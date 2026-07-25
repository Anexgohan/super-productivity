/**
 * Auth routes: first-run setup, login, logout, session introspection, and the
 * subrequest endpoint an edge proxy uses to gate the app.
 *
 * Threat model this is written against: a LAN deployment where the web port was
 * previously unauthenticated — anyone who could reach it received a fully
 * logged-in session, because the sync token is embedded in the served config.
 * Gating that config behind a session is the point.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hashPassword, verifyPassword } from './passwords';
import { AuthStore, ROLES, isRole, type Role } from './store';
import { SessionManager, SESSION_COOKIE, parseCookies } from './session';
import { renderLoginPage } from './login-page';

const USERNAME_PATTERN = /^[a-zA-Z0-9_.-]{3,32}$/;
const MIN_PASSWORD_LENGTH = 8;
/** Fixed delay on failed logins, to slow credential guessing. */
const FAIL_DELAY_MS = 500;
const LOCKOUT_THRESHOLD = 8;
const LOCKOUT_MS = 15 * 60_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Attempts {
  fails: number;
  lockedUntil: number;
}

class LoginRateLimiter {
  private readonly _byIp = new Map<string, Attempts>();

  check(ip: string): { allowed: boolean; retryAfterSeconds: number } {
    const entry = this._byIp.get(ip);
    if (!entry) return { allowed: true, retryAfterSeconds: 0 };
    const now = Date.now();
    if (entry.lockedUntil > now) {
      return {
        allowed: false,
        retryAfterSeconds: Math.ceil((entry.lockedUntil - now) / 1000),
      };
    }
    if (entry.lockedUntil > 0) this._byIp.delete(ip);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  fail(ip: string): void {
    const entry = this._byIp.get(ip) ?? { fails: 0, lockedUntil: 0 };
    entry.fails += 1;
    if (entry.fails >= LOCKOUT_THRESHOLD) {
      entry.lockedUntil = Date.now() + LOCKOUT_MS;
      entry.fails = 0;
      console.warn(`sp-bridge: login lockout for ${ip}`);
    }
    this._byIp.set(ip, entry);
  }

  reset(ip: string): void {
    this._byIp.delete(ip);
  }
}

const REGISTRATION_KEY = 'auth.self_registration_enabled';

/** Sentinel: distinguishes "they sent something unusable" from "they cleared it". */
const INVALID_EMAIL = Symbol('invalid-email');

/**
 * Email is profile data, not identity, so blank is always allowed — it just
 * clears the field. Only a non-empty value that isn't an address is rejected.
 */
const normalizeEmail = (value: unknown): string | null | typeof INVALID_EMAIL => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return INVALID_EMAIL;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  return trimmed.includes('@') ? trimmed : INVALID_EMAIL;
};

const validateCredentials = (username: unknown, password: unknown): string | null => {
  if (typeof username !== 'string' || !USERNAME_PATTERN.test(username)) {
    return 'Username must be 3–32 characters (letters, numbers, . _ -)';
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  return null;
};

export interface AuthDeps {
  store: AuthStore;
  sessions: SessionManager;
  /**
   * Where to send a browser after login. The bridge hosts the login page but is
   * an API server, not the app — without this, success would land on the
   * bridge's own "/" and 404. Empty until an edge proxy serves both from one
   * origin, at which point "/" is correct.
   */
  webUrl?: string;
  /**
   * Removes a SuperSync account and everything it owns. Lives on the sync
   * server, which is the only thing that can reach those tables, so deletion
   * has to go back out over the internal channel.
   */
  purgeSyncAccount?: (supersyncUserId: number) => Promise<void>;
}

/** Reads and validates the session cookie on a request. */
export const sessionFromRequest = (
  req: FastifyRequest,
  sessions: SessionManager,
): ReturnType<SessionManager['verify']> => {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return null;
  return sessions.verify(token);
};

export const registerAuthRoutes = (
  app: FastifyInstance,
  { store, sessions, webUrl, purgeSyncAccount }: AuthDeps,
): void => {
  const limiter = new LoginRateLimiter();
  const appHome = webUrl || '/';

  // The bridge is an API server, so "/" would otherwise 404. Send humans to the
  // app (or the login page if they have no session yet) rather than JSON.
  app.get('/', async (req, reply) => {
    if (!webUrl) {
      return reply
        .status(404)
        .send({ error: 'sp-bridge is an API server — see GET /api/docs' });
    }
    return reply.redirect(sessionFromRequest(req, sessions) ? webUrl : '/login');
  });

  const issue = (
    reply: FastifyReply,
    user: { id: number; username: string; role: string },
  ) => {
    const token = sessions.sign({
      userId: user.id,
      username: user.username,
      role: user.role,
    });
    reply.header('Set-Cookie', sessions.cookie(token));
    return { username: user.username, role: user.role };
  };

  // ── Login / setup page ────────────────────────────────────────────────────
  app.get<{ Querystring: { next?: string } }>('/login', async (req, reply) => {
    // Only same-origin paths, so ?next= can't be used as an open redirect.
    // Anything else falls back to the admin-configured app URL.
    const next = req.query.next;
    const redirectTo = next && /^\/[^/\\]/.test(next) ? next : appHome;
    reply.type('text/html; charset=utf-8');
    return renderLoginPage({ isSetup: (await store.userCount()) === 0, redirectTo });
  });

  // ── First-run admin creation ──────────────────────────────────────────────
  app.post<{ Body: { username?: string; password?: string } }>(
    '/api/auth/setup',
    async (req, reply) => {
      if ((await store.userCount()) > 0) {
        return reply.status(400).send({ error: 'Setup already completed' });
      }
      const { username, password } = req.body ?? {};
      const invalid = validateCredentials(username, password);
      if (invalid) return reply.status(400).send({ error: invalid });

      const hash = await hashPassword(password as string);
      // onlyIfNone makes concurrent setup submissions safe.
      const user = await store.createUser(username as string, hash, 'admin', true);
      if (!user) {
        return reply.status(400).send({ error: 'Setup already completed' });
      }
      console.log(`sp-bridge: initial admin account created: ${user.username}`);
      return issue(reply, user);
    },
  );

  // ── Login ─────────────────────────────────────────────────────────────────
  app.post<{ Body: { username?: string; password?: string } }>(
    '/api/auth/login',
    async (req, reply) => {
      const ip = req.ip ?? 'unknown';
      const gate = limiter.check(ip);
      if (!gate.allowed) {
        return reply.status(429).send({
          error: 'Too many failed attempts. Try again later.',
          retryAfterSeconds: gate.retryAfterSeconds,
        });
      }
      const { username, password } = req.body ?? {};
      if (typeof username !== 'string' || typeof password !== 'string') {
        return reply.status(400).send({ error: 'Username and password required' });
      }
      const user = await store.findUser(username);
      const ok = user ? await verifyPassword(password, user.passwordHash) : false;
      if (!user || !ok) {
        limiter.fail(ip);
        await sleep(FAIL_DELAY_MS);
        // Same message either way — don't reveal which usernames exist.
        return reply.status(401).send({ error: 'Invalid credentials' });
      }
      limiter.reset(ip);
      console.log(`sp-bridge: user logged in: ${user.username}`);
      return issue(reply, user);
    },
  );

  // ── Logout ────────────────────────────────────────────────────────────────
  app.post('/api/auth/logout', async (_req, reply) => {
    reply.header('Set-Cookie', sessions.clearCookie());
    return { ok: true };
  });

  // ── Who am I ──────────────────────────────────────────────────────────────
  app.get('/api/auth/me', async (req, reply) => {
    const session = sessionFromRequest(req, sessions);
    if (!session) return reply.status(401).send({ error: 'Not signed in' });
    // Sliding expiry: refresh the cookie once it's used a fraction of its life.
    if (session.ageSeconds > sessions.renewAfterSeconds) {
      reply.header('Set-Cookie', sessions.cookie(sessions.sign(session.user)));
    }
    return {
      username: session.user.username,
      role: session.user.role,
      setupRequired: false,
    };
  });

  /**
   * Subrequest target for an edge proxy (nginx auth_request): 204 when the
   * session is valid, 401 otherwise. Kept deliberately free of side effects so
   * it stays cheap enough to run on every proxied request.
   */
  app.get('/api/auth/verify', async (req, reply) => {
    const session = sessionFromRequest(req, sessions);
    if (!session) return reply.status(401).send();
    reply.header('X-Auth-User', session.user.username);
    reply.header('X-Auth-Role', session.user.role);
    return reply.status(204).send();
  });

  /** Lets a client discover whether this server still needs first-run setup. */
  app.get('/api/auth/status', async () => {
    const userCount = await store.userCount();
    return { setupRequired: userCount === 0, userCount };
  });

  /**
   * Admin gate, checked inline. The full role ACL table lands with the rest of
   * the role work; these two routes cannot wait for it, because "create a user"
   * unguarded is a worse hole than the one the ACL closes.
   */
  const requireAdmin = async (
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<boolean> => {
    const session = sessionFromRequest(req, sessions);
    if (session?.user.role !== 'admin') {
      await reply.status(403).send({ error: 'Admin only' });
      return false;
    }
    return true;
  };

  const publicUser = (u: {
    id: number;
    username: string;
    role: string;
    email: string | null;
    isPublic: boolean;
  }) => ({
    id: u.id,
    username: u.username,
    role: u.role,
    email: u.email,
    isPublic: u.isPublic,
  });

  app.get('/api/auth/users', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return reply;
    return (await store.listUsers()).map(publicUser);
  });

  app.post<{
    Body: { username?: string; password?: string; role?: string; email?: string };
  }>('/api/auth/users', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return reply;

    const { username, password, role = 'operator', email } = req.body ?? {};
    const invalid = validateCredentials(username, password);
    if (invalid) return reply.status(400).send({ error: invalid });
    if (!isRole(role)) {
      return reply
        .status(400)
        .send({ error: `Role must be one of: ${ROLES.join(', ')}` });
    }
    const cleanEmail = normalizeEmail(email);
    if (cleanEmail === INVALID_EMAIL) {
      return reply.status(400).send({ error: 'Email must be a valid address' });
    }

    const hash = await hashPassword(password as string);
    const user = await store.createUser(
      username as string,
      hash,
      role,
      false,
      cleanEmail,
    );
    // The insert is ON CONFLICT DO NOTHING, so no row means the name is taken.
    if (!user) return reply.status(409).send({ error: 'Username already exists' });

    console.log(`sp-bridge: account created: ${user.username} (${user.role})`);
    return reply.status(201).send(publicUser(user));
  });

  /**
   * The admin's preferred display order, as a complete id list. Registered
   * ahead of /users/:id because Fastify would otherwise match "order" as an id.
   */
  app.put<{ Body: { ids?: unknown } }>('/api/auth/users/order', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return reply;

    const ids = req.body?.ids;
    if (!Array.isArray(ids) || ids.some((n) => !Number.isInteger(n))) {
      return reply.status(400).send({ error: 'ids must be an array of user ids' });
    }
    // Must be the full set: a partial list would leave the rest holding stale
    // positions and the order would come back different from what was sent.
    const known = (await store.listUsers()).map((u) => u.id).sort();
    if (ids.length !== known.length || [...ids].sort().join() !== known.join()) {
      return reply
        .status(400)
        .send({ error: 'ids must list every account exactly once' });
    }

    await store.setOrder(ids as number[]);
    return reply.send({ ok: true });
  });

  /**
   * Role change and/or password reset, mirroring pankha's PUT /users/:id.
   * Both in one route because the admin UI offers them from the same row.
   */
  app.put<{
    Params: { id: string };
    Body: { role?: string; password?: string; email?: string; username?: string };
  }>('/api/auth/users/:id', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return reply;

    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      return reply.status(400).send({ error: 'Invalid user id' });
    }
    const target = await store.findUserById(id);
    if (!target) return reply.status(404).send({ error: 'User not found' });

    const { role, password, email, username } = req.body ?? {};

    if (username !== undefined && username !== target.username) {
      if (!USERNAME_PATTERN.test(username)) {
        return reply
          .status(400)
          .send({ error: 'Username must be 3–32 characters (letters, numbers, . _ -)' });
      }
      // Renaming is safe for the user's data: the board is keyed to the account
      // id, never the name (see sync-identity.ts).
      if (!(await store.setUsername(id, username))) {
        return reply.status(409).send({ error: 'Username already exists' });
      }
    }

    if (role !== undefined) {
      if (!isRole(role)) {
        return reply
          .status(400)
          .send({ error: `Role must be one of: ${ROLES.join(', ')}` });
      }
      // Demoting the last admin would leave nobody able to manage accounts,
      // and no way back in short of editing the database by hand.
      if (
        target.role === 'admin' &&
        role !== 'admin' &&
        (await store.adminCount()) <= 1
      ) {
        return reply.status(400).send({ error: 'Cannot demote the last admin' });
      }
      await store.setRole(id, role);
    }

    if (password !== undefined) {
      if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
        return reply
          .status(400)
          .send({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
      }
      await store.setPassword(id, await hashPassword(password));
    }

    if (email !== undefined) {
      const cleanEmail = normalizeEmail(email);
      if (cleanEmail === INVALID_EMAIL) {
        return reply.status(400).send({ error: 'Email must be a valid address' });
      }
      await store.setEmail(id, cleanEmail);
    }

    console.log(`sp-bridge: account updated: ${target.username}`);
    return reply.send(publicUser((await store.findUserById(id)) as never));
  });

  /**
   * Purge. Removes the login, the stored token, and — through the sync server's
   * internal route — the SuperSync account with every op it owns. Irreversible
   * by design; the UI confirms before calling this.
   */
  app.delete<{ Params: { id: string } }>('/api/auth/users/:id', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return reply;

    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      return reply.status(400).send({ error: 'Invalid user id' });
    }
    const session = sessionFromRequest(req, sessions);
    if (session?.user.userId === id) {
      return reply.status(400).send({ error: 'You cannot delete your own account' });
    }
    const target = await store.findUserById(id);
    if (!target) return reply.status(404).send({ error: 'User not found' });
    if (target.role === 'admin' && (await store.adminCount()) <= 1) {
      return reply.status(400).send({ error: 'Cannot delete the last admin' });
    }

    // Data first: if this fails the account still exists to retry from, whereas
    // dropping the login first would orphan a board nothing can reach.
    if (target.supersyncUserId !== null && purgeSyncAccount) {
      try {
        await purgeSyncAccount(target.supersyncUserId);
      } catch (err) {
        return reply.status(502).send({
          error: `Could not remove synced data: ${(err as Error).message}`,
        });
      }
    }
    await store.deleteSetting(`supersync.user_token.${id}`);
    await store.deleteUser(id);

    console.log(`sp-bridge: account purged: ${target.username}`);
    return reply.send({ deleted: true });
  });

  // ── Your own account ──────────────────────────────────────────────────────
  app.put<{ Body: { currentPassword?: string; newPassword?: string } }>(
    '/api/auth/password',
    async (req, reply) => {
      const session = sessionFromRequest(req, sessions);
      if (!session) return reply.status(401).send({ error: 'Not signed in' });

      const { currentPassword, newPassword } = req.body ?? {};
      if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD_LENGTH) {
        return reply
          .status(400)
          .send({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
      }
      const user = await store.findUserById(session.user.userId);
      if (!user) return reply.status(401).send({ error: 'Not signed in' });

      // Required even though the session already proves identity: it stops an
      // unattended browser being turned into a permanent takeover.
      const ok =
        typeof currentPassword === 'string' &&
        (await verifyPassword(currentPassword, user.passwordHash));
      if (!ok) {
        await sleep(FAIL_DELAY_MS);
        return reply.status(403).send({ error: 'Current password is incorrect' });
      }

      await store.setPassword(user.id, await hashPassword(newPassword));
      console.log(`sp-bridge: password changed: ${user.username}`);
      return reply.send({ ok: true });
    },
  );

  /** Profile data. Changing it moves nothing — see sync-identity.ts. */
  app.put<{ Body: { email?: string } }>('/api/auth/me', async (req, reply) => {
    const session = sessionFromRequest(req, sessions);
    if (!session) return reply.status(401).send({ error: 'Not signed in' });

    const cleanEmail = normalizeEmail(req.body?.email);
    if (cleanEmail === INVALID_EMAIL) {
      return reply.status(400).send({ error: 'Email must be a valid address' });
    }
    await store.setEmail(session.user.userId, cleanEmail);
    const user = await store.findUserById(session.user.userId);
    return reply.send(publicUser(user as never));
  });

  // ── Self-registration toggle ──────────────────────────────────────────────
  app.get('/api/auth/registration', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return reply;
    return { isEnabled: (await store.getSetting(REGISTRATION_KEY)) === 'true' };
  });

  app.put<{ Body: { isEnabled?: boolean } }>(
    '/api/auth/registration',
    async (req, reply) => {
      if (!(await requireAdmin(req, reply))) return reply;
      const isEnabled = req.body?.isEnabled === true;
      await store.setSetting(REGISTRATION_KEY, String(isEnabled));
      console.log(`sp-bridge: self-registration ${isEnabled ? 'enabled' : 'disabled'}`);
      return { isEnabled };
    },
  );

  /** Self-service signup. Refused unless an admin turned it on. */
  app.post<{ Body: { username?: string; password?: string } }>(
    '/api/auth/register',
    async (req, reply) => {
      if ((await store.getSetting(REGISTRATION_KEY)) !== 'true') {
        return reply.status(403).send({ error: 'Registration is disabled' });
      }
      const { username, password } = req.body ?? {};
      const invalid = validateCredentials(username, password);
      if (invalid) return reply.status(400).send({ error: invalid });

      const hash = await hashPassword(password as string);
      // Self-signup always lands on the lowest rank; promotion is the admin's.
      const user = await store.createUser(username as string, hash, 'viewer');
      if (!user) return reply.status(409).send({ error: 'Username already exists' });

      console.log(`sp-bridge: account self-registered: ${user.username}`);
      return issue(reply, user);
    },
  );
};

export { AuthStore, SessionManager };
export type { Role };

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
import { AuthStore, type Role } from './store';
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
  { store, sessions, webUrl }: AuthDeps,
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
};

export { AuthStore, SessionManager };
export type { Role };

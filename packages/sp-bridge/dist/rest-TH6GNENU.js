import { ROLES, ROLE_LEVELS, isRole } from './chunk-PGFRD7XM.js';
import { SESSION_COOKIE, parseCookies } from './chunk-4IBWU5IS.js';

// src/rest.ts
import Fastify from 'fastify';
import { timingSafeEqual as timingSafeEqual3 } from 'crypto';

// src/auth/passwords.ts
import { randomBytes, scrypt, timingSafeEqual } from 'crypto';
var SCRYPT_N = 131072;
var SCRYPT_R = 8;
var SCRYPT_P = 1;
var SALT_BYTES = 16;
var KEY_BYTES = 32;
var SCRYPT_MAXMEM = 256 * 1024 * 1024;
var derive = (password, salt, N, r, p) =>
  new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_BYTES, { N, r, p, maxmem: SCRYPT_MAXMEM }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
var hashPassword = async (password) => {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64'),
    key.toString('base64'),
  ].join('$');
};
var verifyPassword = async (password, stored) => {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number.parseInt(parts[1], 10);
  const r = Number.parseInt(parts[2], 10);
  const p = Number.parseInt(parts[3], 10);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  let actual;
  try {
    actual = await derive(password, salt, N, r, p);
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

// src/auth/api-key.ts
import {
  createHmac,
  randomBytes as randomBytes2,
  timingSafeEqual as timingSafeEqual2,
} from 'crypto';
var KEY_PREFIX = 'spk_';
var DIGEST_BITS = 96;
var DIGEST_CHARS = DIGEST_BITS / 6;
var SALT_BYTES2 = 9;
var mintSalt = () => randomBytes2(SALT_BYTES2).toString('base64url');
var materialFor = (row) => ({
  userId: row.userId,
  keyId: row.id,
  salt: row.salt,
  version: row.version,
});
var deriveDigest = (jwtSecret, m) =>
  createHmac('sha256', jwtSecret)
    .update(`api-key:v1:${m.userId}:${m.keyId}:${m.salt}:${m.version}`)
    .digest('base64url')
    .slice(0, DIGEST_CHARS);
var formatApiKey = (jwtSecret, m) =>
  `${KEY_PREFIX}${m.keyId.toString(36)}_${deriveDigest(jwtSecret, m)}`;
var parseKeyId = (presented) => {
  if (!presented.startsWith(KEY_PREFIX)) return null;
  const [rawId, digest] = presented.slice(KEY_PREFIX.length).split('_');
  if (!rawId || !digest) return null;
  const keyId = Number.parseInt(rawId, 36);
  return Number.isInteger(keyId) && keyId > 0 ? keyId : null;
};
var verifyApiKey = (presented, jwtSecret, m) => {
  const expected = Buffer.from(formatApiKey(jwtSecret, m));
  const actual = Buffer.from(presented);
  return actual.length === expected.length && timingSafeEqual2(actual, expected);
};

// src/auth/login-page.ts
var SP_FONT_STACK = `-apple-system, BlinkMacSystemFont, 'Segoe UI Variable Text', 'Segoe UI', Roboto, 'Inter', 'Open Sans', 'Helvetica Neue', Arial, 'Noto Sans', sans-serif`;
var renderLoginPage = ({ isSetup, redirectTo }) => {
  const title = isSetup ? 'Create your account' : 'Sign in';
  const subtitle = isSetup
    ? 'This is the first account for this server - it will be the admin.'
    : 'Super Productivity';
  const action = isSetup ? '/api/auth/setup' : '/api/auth/login';
  const button = isSetup ? 'Create account' : 'Sign in';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title} \xB7 Super Productivity</title>
<style>
  :root {
    --accent: #6495ED;
    --bg: #f8f8f7;
    --surface: #ffffff;
    --text: #131314;
    --muted: #6b6b70;
    --border: #e2e2e0;
    --danger: #f44336;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #131314;
      --surface: #1e1e20;
      --text: #f2f2f0;
      --muted: #9a9aa0;
      --border: #313134;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh;
    display: flex; align-items: center; justify-content: center;
    padding: 24px;
    font-family: ${SP_FONT_STACK};
    background: var(--bg); color: var(--text);
    -webkit-font-smoothing: antialiased;
  }
  .card {
    width: 100%; max-width: 380px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 32px 28px;
    box-shadow: 0 1px 2px rgba(0,0,0,.04), 0 8px 24px rgba(0,0,0,.06);
  }
  .mark {
    width: 40px; height: 40px; border-radius: 10px;
    background: var(--accent);
    display: flex; align-items: center; justify-content: center;
    margin-bottom: 20px;
  }
  .mark svg { width: 22px; height: 22px; fill: #fff; }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 4px; letter-spacing: -0.01em; }
  p.sub { margin: 0 0 24px; color: var(--muted); font-size: 13.5px; line-height: 1.45; }
  label { display: block; font-size: 12.5px; font-weight: 600; margin-bottom: 6px; }
  input {
    width: 100%; padding: 10px 12px; margin-bottom: 16px;
    font: inherit; font-size: 14px;
    color: var(--text); background: var(--bg);
    border: 1px solid var(--border); border-radius: 8px;
    transition: border-color .15s, box-shadow .15s;
  }
  input:focus {
    outline: none; border-color: var(--accent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent);
  }
  button {
    width: 100%; padding: 11px 16px;
    font: inherit; font-size: 14px; font-weight: 600;
    color: #fff; background: var(--accent);
    border: 0; border-radius: 8px; cursor: pointer;
    transition: filter .15s;
  }
  button:hover:not(:disabled) { filter: brightness(1.07); }
  button:disabled { opacity: .6; cursor: default; }
  .err {
    display: none; margin: 0 0 16px;
    padding: 10px 12px; border-radius: 8px; font-size: 13px;
    color: var(--danger);
    background: color-mix(in srgb, var(--danger) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--danger) 30%, transparent);
  }
  .err.show { display: block; }
  .hint { margin: 18px 0 0; font-size: 12px; color: var(--muted); text-align: center; }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style>
</head>
<body>
  <main class="card">
    <div class="mark" aria-hidden="true">
      <svg viewBox="0 0 24 24"><path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
    </div>
    <h1>${title}</h1>
    <p class="sub">${subtitle}</p>

    <div class="err" id="err" role="alert"></div>

    <form id="f" autocomplete="on">
      <label for="u">Username</label>
      <input id="u" name="username" autocomplete="username" required
             autocapitalize="none" spellcheck="false" autofocus>

      <label for="p">Password</label>
      <input id="p" name="password" type="password" required
             autocomplete="${isSetup ? 'new-password' : 'current-password'}">

      <button type="submit" id="b">${button}</button>
    </form>
    ${isSetup ? '<p class="hint">Choose a password of at least 8 characters.</p>' : ''}
  </main>

<script>
  const form = document.getElementById('f');
  const err = document.getElementById('err');
  const btn = document.getElementById('b');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.classList.remove('show');
    btn.disabled = true;
    try {
      const res = await fetch(${JSON.stringify(action)}, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          username: document.getElementById('u').value,
          password: document.getElementById('p').value,
        }),
      });
      if (res.ok) {
        window.location.href = ${JSON.stringify(redirectTo)};
        return;
      }
      const body = await res.json().catch(() => ({}));
      err.textContent = body.error || 'Something went wrong. Try again.';
      err.classList.add('show');
    } catch {
      err.textContent = 'Could not reach the server.';
      err.classList.add('show');
    }
    btn.disabled = false;
  });
</script>
</body>
</html>`;
};

// src/auth/routes.ts
var USERNAME_PATTERN = /^[a-zA-Z0-9_.-]{3,32}$/;
var MIN_PASSWORD_LENGTH = 8;
var FAIL_DELAY_MS = 500;
var LOCKOUT_THRESHOLD = 8;
var LOCKOUT_MS = 15 * 6e4;
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
var LoginRateLimiter = class {
  _byIp = /* @__PURE__ */ new Map();
  check(ip) {
    const entry = this._byIp.get(ip);
    if (!entry) return { allowed: true, retryAfterSeconds: 0 };
    const now = Date.now();
    if (entry.lockedUntil > now) {
      return {
        allowed: false,
        retryAfterSeconds: Math.ceil((entry.lockedUntil - now) / 1e3),
      };
    }
    if (entry.lockedUntil > 0) this._byIp.delete(ip);
    return { allowed: true, retryAfterSeconds: 0 };
  }
  fail(ip) {
    const entry = this._byIp.get(ip) ?? { fails: 0, lockedUntil: 0 };
    entry.fails += 1;
    if (entry.fails >= LOCKOUT_THRESHOLD) {
      entry.lockedUntil = Date.now() + LOCKOUT_MS;
      entry.fails = 0;
      console.warn(`sp-bridge: login lockout for ${ip}`);
    }
    this._byIp.set(ip, entry);
  }
  reset(ip) {
    this._byIp.delete(ip);
  }
};
var REGISTRATION_KEY = 'auth.self_registration_enabled';
var INVALID_EMAIL = /* @__PURE__ */ Symbol('invalid-email');
var normalizeEmail = (value) => {
  if (value === void 0 || value === null) return null;
  if (typeof value !== 'string') return INVALID_EMAIL;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  return trimmed.includes('@') ? trimmed : INVALID_EMAIL;
};
var validateCredentials = (username, password) => {
  if (typeof username !== 'string' || !USERNAME_PATTERN.test(username)) {
    return 'Username must be 3-32 characters (letters, numbers, . _ -)';
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  return null;
};
var sessionFromRequest = (req, sessions) => {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return null;
  return sessions.verify(token);
};
var registerAuthRoutes = (
  app,
  { store, sessions, jwtSecret, webUrl, purgeSyncAccount },
) => {
  const limiter = new LoginRateLimiter();
  const appHome = webUrl || '/';
  app.get('/', async (req, reply) => {
    if (!webUrl) {
      return reply
        .status(404)
        .send({ error: 'sp-bridge is an API server - see GET /api/docs' });
    }
    return reply.redirect(sessionFromRequest(req, sessions) ? webUrl : '/login');
  });
  const issue = (reply, user) => {
    const token = sessions.sign({
      userId: user.id,
      username: user.username,
      role: user.role,
    });
    reply.header('Set-Cookie', sessions.cookie(token));
    return { username: user.username, role: user.role };
  };
  app.get('/login', async (req, reply) => {
    const next = req.query.next;
    const redirectTo = next && /^\/[^/\\]/.test(next) ? next : appHome;
    reply.type('text/html; charset=utf-8');
    return renderLoginPage({ isSetup: (await store.userCount()) === 0, redirectTo });
  });
  app.post('/api/auth/setup', async (req, reply) => {
    if ((await store.userCount()) > 0) {
      return reply.status(400).send({ error: 'Setup already completed' });
    }
    const { username, password } = req.body ?? {};
    const invalid = validateCredentials(username, password);
    if (invalid) return reply.status(400).send({ error: invalid });
    const hash = await hashPassword(password);
    const user = await store.createUser(username, hash, 'admin', true);
    if (!user) {
      return reply.status(400).send({ error: 'Setup already completed' });
    }
    console.log(`sp-bridge: initial admin account created: ${user.username}`);
    return issue(reply, user);
  });
  app.post('/api/auth/login', async (req, reply) => {
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
      return reply.status(401).send({ error: 'Invalid credentials' });
    }
    limiter.reset(ip);
    console.log(`sp-bridge: user logged in: ${user.username}`);
    return issue(reply, user);
  });
  app.post('/api/auth/logout', async (_req, reply) => {
    reply.header('Set-Cookie', sessions.clearCookie());
    return { ok: true };
  });
  app.get('/api/auth/me', async (req, reply) => {
    const session = sessionFromRequest(req, sessions);
    if (!session) return reply.status(401).send({ error: 'Not signed in' });
    if (session.ageSeconds > sessions.renewAfterSeconds) {
      reply.header('Set-Cookie', sessions.cookie(sessions.sign(session.user)));
    }
    const user = await store.findUserById(session.user.userId);
    if (!user) return reply.status(401).send({ error: 'Not signed in' });
    return {
      // The client needs its own id to address /api/auth/users/:id/keys.
      id: user.id,
      username: user.username,
      role: user.role,
      email: user.email,
      setupRequired: false,
    };
  });
  app.get('/api/auth/verify', async (req, reply) => {
    const session = sessionFromRequest(req, sessions);
    if (!session) return reply.status(401).send();
    reply.header('X-Auth-User', session.user.username);
    reply.header('X-Auth-Role', session.user.role);
    return reply.status(204).send();
  });
  app.get('/api/auth/status', async () => {
    const userCount = await store.userCount();
    return { setupRequired: userCount === 0, userCount };
  });
  const requireAdmin = async (req, reply) => {
    const session = sessionFromRequest(req, sessions);
    if (session?.user.role !== 'admin') {
      await reply.status(403).send({ error: 'Admin only' });
      return false;
    }
    return true;
  };
  const publicUser = (u) => ({
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
  app.post('/api/auth/users', async (req, reply) => {
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
    const hash = await hashPassword(password);
    const user = await store.createUser(username, hash, role, false, cleanEmail);
    if (!user) return reply.status(409).send({ error: 'Username already exists' });
    console.log(`sp-bridge: account created: ${user.username} (${user.role})`);
    return reply.status(201).send(publicUser(user));
  });
  app.put('/api/auth/users/order', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return reply;
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || ids.some((n) => !Number.isInteger(n))) {
      return reply.status(400).send({ error: 'ids must be an array of user ids' });
    }
    const known = (await store.listUsers()).map((u) => u.id).sort();
    if (ids.length !== known.length || [...ids].sort().join() !== known.join()) {
      return reply
        .status(400)
        .send({ error: 'ids must list every account exactly once' });
    }
    await store.setOrder(ids);
    return reply.send({ ok: true });
  });
  app.put('/api/auth/users/:id', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return reply;
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      return reply.status(400).send({ error: 'Invalid user id' });
    }
    const target = await store.findUserById(id);
    if (!target) return reply.status(404).send({ error: 'User not found' });
    const { role, password, email, username } = req.body ?? {};
    if (username !== void 0 && username !== target.username) {
      if (!USERNAME_PATTERN.test(username)) {
        return reply
          .status(400)
          .send({ error: 'Username must be 3-32 characters (letters, numbers, . _ -)' });
      }
      if (!(await store.setUsername(id, username))) {
        return reply.status(409).send({ error: 'Username already exists' });
      }
    }
    if (role !== void 0) {
      if (!isRole(role)) {
        return reply
          .status(400)
          .send({ error: `Role must be one of: ${ROLES.join(', ')}` });
      }
      if (
        target.role === 'admin' &&
        role !== 'admin' &&
        (await store.adminCount()) <= 1
      ) {
        return reply.status(400).send({ error: 'Cannot demote the last admin' });
      }
      await store.setRole(id, role);
    }
    if (password !== void 0) {
      if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
        return reply
          .status(400)
          .send({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
      }
      await store.setPassword(id, await hashPassword(password));
    }
    if (email !== void 0) {
      const cleanEmail = normalizeEmail(email);
      if (cleanEmail === INVALID_EMAIL) {
        return reply.status(400).send({ error: 'Email must be a valid address' });
      }
      await store.setEmail(id, cleanEmail);
    }
    console.log(`sp-bridge: account updated: ${target.username}`);
    return reply.send(publicUser(await store.findUserById(id)));
  });
  app.delete('/api/auth/users/:id', async (req, reply) => {
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
    if (target.supersyncUserId !== null && purgeSyncAccount) {
      try {
        await purgeSyncAccount(target.supersyncUserId);
      } catch (err) {
        return reply.status(502).send({
          error: `Could not remove synced data: ${err.message}`,
        });
      }
    }
    await store.deleteSetting(`supersync.user_token.${id}`);
    await store.deleteUser(id);
    console.log(`sp-bridge: account purged: ${target.username}`);
    return reply.send({ deleted: true });
  });
  app.put('/api/auth/password', async (req, reply) => {
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
  });
  app.put('/api/auth/me', async (req, reply) => {
    const session = sessionFromRequest(req, sessions);
    if (!session) return reply.status(401).send({ error: 'Not signed in' });
    const cleanEmail = normalizeEmail(req.body?.email);
    if (cleanEmail === INVALID_EMAIL) {
      return reply.status(400).send({ error: 'Email must be a valid address' });
    }
    await store.setEmail(session.user.userId, cleanEmail);
    const user = await store.findUserById(session.user.userId);
    return reply.send(publicUser(user));
  });
  app.get('/api/auth/registration', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return reply;
    return { isEnabled: (await store.getSetting(REGISTRATION_KEY)) === 'true' };
  });
  app.put('/api/auth/registration', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return reply;
    const isEnabled = req.body?.isEnabled === true;
    await store.setSetting(REGISTRATION_KEY, String(isEnabled));
    console.log(`sp-bridge: self-registration ${isEnabled ? 'enabled' : 'disabled'}`);
    return { isEnabled };
  });
  app.post('/api/auth/register', async (req, reply) => {
    if ((await store.getSetting(REGISTRATION_KEY)) !== 'true') {
      return reply.status(403).send({ error: 'Registration is disabled' });
    }
    const { username, password } = req.body ?? {};
    const invalid = validateCredentials(username, password);
    if (invalid) return reply.status(400).send({ error: invalid });
    const hash = await hashPassword(password);
    const user = await store.createUser(username, hash, 'viewer');
    if (!user) return reply.status(409).send({ error: 'Username already exists' });
    console.log(`sp-bridge: account self-registered: ${user.username}`);
    return issue(reply, user);
  });
  const keyPrincipal = async (req, reply, targetId) => {
    const session = sessionFromRequest(req, sessions);
    if (!session) {
      await reply.status(401).send({ error: 'Unauthorized' });
      return false;
    }
    if (session.user.role !== 'admin' && session.user.userId !== targetId) {
      await reply.status(403).send({ error: 'Not your account' });
      return false;
    }
    return true;
  };
  const publicKey = (row) => ({
    id: row.id,
    label: row.label,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
    // Revoked keys no longer verify, so showing the string would be misleading.
    key: row.revokedAt ? null : formatApiKey(jwtSecret, materialFor(row)),
  });
  app.get('/api/auth/users/:id/keys', async (req, reply) => {
    const targetId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(targetId)) {
      return reply.status(400).send({ error: 'Invalid user id' });
    }
    if (!(await keyPrincipal(req, reply, targetId))) return;
    const rows = await store.listApiKeys(targetId);
    return { keys: rows.map(publicKey) };
  });
  app.post('/api/auth/users/:id/keys', async (req, reply) => {
    const targetId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(targetId)) {
      return reply.status(400).send({ error: 'Invalid user id' });
    }
    if (!(await keyPrincipal(req, reply, targetId))) return;
    if (!(await store.findUserById(targetId))) {
      return reply.status(404).send({ error: 'No such user' });
    }
    const label = (req.body?.label ?? '').trim() || 'API key';
    if (label.length > 64) {
      return reply.status(400).send({ error: 'Label too long' });
    }
    const row = await store.createApiKey(targetId, label, mintSalt());
    return reply.status(201).send(publicKey(row));
  });
  const keyInPath = async (req, reply) => {
    const targetId = Number.parseInt(req.params.id, 10);
    const keyId = Number.parseInt(req.params.keyId, 10);
    if (!Number.isInteger(targetId) || !Number.isInteger(keyId)) {
      await reply.status(400).send({ error: 'Invalid id' });
      return null;
    }
    if (!(await keyPrincipal(req, reply, targetId))) return null;
    const row = await store.findApiKey(keyId);
    if (!row || row.userId !== targetId) {
      await reply.status(404).send({ error: 'No such key' });
      return null;
    }
    return row;
  };
  app.post('/api/auth/users/:id/keys/:keyId/revoke', async (req, reply) => {
    const row = await keyInPath(req, reply);
    if (!row) return;
    return { revoked: await store.revokeApiKey(row.id) };
  });
  app.delete('/api/auth/users/:id/keys/:keyId', async (req, reply) => {
    const row = await keyInPath(req, reply);
    if (!row) return;
    return { deleted: await store.deleteApiKey(row.id) };
  });
};

// src/rest.ts
var DOCS = {
  name: 'sp-bridge API',
  version: 1,
  auth: 'Authorization: Bearer <key> or X-Api-Key: <key>; keys are per-user, created at /api/auth/users/:id/keys',
  routes: {
    'GET /api/health': 'liveness (no auth)',
    'GET /api/docs': 'this document (no auth)',
    'GET /api/status': 'sync cursor, last sync time, entity counts',
    'GET /api/tasks':
      'list tasks; filters: isDone, projectId, tagId, dueDay (YYYY-MM-DD), parentId ("null" for top-level), search, overdue, unscheduled, plannedForToday, parentsOnly, recurringOnly (booleans), today (YYYY-MM-DD anchor for date filters), fields (comma-separated projection)',
    'GET /api/tasks/:id': 'single task by id',
    'GET /api/current-task':
      'active task (always null on the headless bridge - non-synced UI state)',
    'GET /api/task-repeat-cfgs': 'list recurring-task configurations',
    'GET /api/planner': 'future-day scheduling board { YYYY-MM-DD: taskId[] }',
    'GET /api/projects': 'list projects',
    'GET /api/tags': 'list tags',
    'GET /api/config': 'global config (by section)',
    'GET /api/worklog': 'time spent per day; filters: from, to (YYYY-MM-DD)',
    'GET /api/entities': 'list materialized entity types (raw superset access)',
    'GET /api/entities/:type': 'raw entity map for a type',
    'POST /api/sync/refresh': 'force an op-log pull now',
    'POST /api/tasks/from-syntax':
      'create a task from short syntax; body: {text: "Title #tag +Project @tomorrow 1h30m", projectId?}. #tag adds/creates a tag, +Project moves by title, @date sets dueDay (YYYY-MM-DD|today|tomorrow), a bare 1h/30m/1h30m token sets the estimate',
    'POST /api/tasks/:id/links':
      'attach a link to a task; body: {url (required), title?}',
    'POST /api/tasks/:id/issue-link':
      'link a task to an external issue; body: {issueId, issueType, issueProviderId (all required), issuePoints?}',
    'DELETE /api/projects/:id':
      'delete a project and all its tasks/notes (Inbox cannot be deleted)',
    'POST /api/tasks/with-subtasks':
      'create a parent task plus subtasks; body: {title (required), projectId?, notes?, timeEstimate?, tagIds?, dueDay?, subTasks: string[]}',
    'POST /api/tasks/:id/subtasks':
      'add a subtask under a top-level task; body: {title (required), notes?, timeEstimate?}',
    'POST /api/tasks/:id/reparent':
      'reparent a task; body: {parentId: string | null} (null promotes it to a top-level task)',
    'POST /api/tasks/reorder':
      'reorder a task list (permutation only); body: {taskIds: string[]} + exactly one of {projectId} | {parentId} | {today: true}',
    'POST /api/today/plan':
      'add tasks to the TODAY list; body: {taskIds: string[], today?: YYYY-MM-DD}',
    'POST /api/today/remove':
      'remove tasks from the TODAY list; body: {taskIds: string[]}',
    'POST /api/tasks/bulk/complete':
      'complete many tasks in one upload; body: {taskIds: string[]}',
    'POST /api/tasks/bulk/update':
      'apply per-task updates in one upload (all-or-nothing); body: {updates: [{id, ...allowed task fields}]}',
    'POST /api/tasks':
      'create task; body: {title (required), projectId?, notes?, timeEstimate?, tagIds?, dueDay?, dueWithTime?}',
    'PATCH /api/tasks/:id':
      'update task; body: partial of {title, notes, isDone, doneOn, timeEstimate, timeSpent, projectId, tagIds, dueDay, dueWithTime}',
    'POST /api/tasks/:id/complete': 'mark task done (sets doneOn=now)',
    'POST /api/tasks/:id/complete-on':
      'mark done with explicit date; body: {doneOn: "YYYY-MM-DD"}',
    'DELETE /api/tasks/:id': 'delete task (refuses while subtasks exist)',
    'POST /api/tasks/:id/tags':
      'add a tag (Kanban column move); body: {tagId}; preserves other tags',
    'DELETE /api/tasks/:id/tags/:tagId': 'remove a tag; preserves other tags',
    'POST /api/tasks/:id/move': 'move task to another project; body: {projectId}',
    'POST /api/tags': 'create tag; body: {title (required), icon?, color?}',
    'PATCH /api/tags/:id': 'update tag; body: partial of {title, color, icon}',
    'DELETE /api/tags/:id':
      'delete tag (cascades: strips it from all tasks; TODAY is protected)',
    'POST /api/projects':
      'create project; body: {title (required), color?, isEnableBacklog?}',
    'PATCH /api/projects/:id':
      'update project; body: partial of {title, isEnableBacklog, isArchived}',
    'GET /api/boards':
      'list boards with their panels; an account that has never edited a board gets the app defaults rather than [], so this matches what its owner sees in a browser. [] means every board was deleted',
    'GET /api/boards/:id': 'single board by id',
    'POST /api/boards':
      'create board; body: {title (required), id?, cols?, panels?}; 409 on an existing id, including the default board ids',
    'PATCH /api/boards/:id':
      'update board; body: partial of {title, cols, panels}; a panel edit is a full replacement panels array',
    'DELETE /api/boards/:id': 'delete board; deleting all of them is remembered',
    'PUT /api/boards/order':
      'reorder boards; body: {ids: string[]} must name every board',
    'POST /api/boards/:id/panels':
      'add a column; body: one panel {title (required), id?, includedTagIds?, excludedTagIds?, taskDoneState?, scheduledState?, backlogState?, isParentTasksOnly?, projectIds?}; appended, and cols grows to match',
    'PATCH /api/boards/:id/panels/:panelId':
      'update one column; writable: everything but id and taskIds',
    'DELETE /api/boards/:id/panels/:panelId':
      'remove a column; leaves its tag and any exclusion of that tag on other columns for the caller to clean up',
    'PUT /api/panels/:panelId/taskIds':
      'set manual card order in one column; body: {taskIds: string[]}; panel ids are unique across boards',
  },
};
var presentedKeys = (req) => {
  const candidates = [];
  const header = req.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    candidates.push(header.slice('Bearer '.length));
  }
  const xApiKey = req.headers['x-api-key'];
  if (typeof xApiKey === 'string') {
    candidates.push(xApiKey);
  }
  return candidates;
};
var KEY_FAIL_GRACE = 10;
var KEY_FAIL_WINDOW_MS = 6e4;
var KEY_FAIL_DELAY_MS = 250;
var keyFailures = /* @__PURE__ */ new Map();
var throttleKey = (req) => req.ip ?? 'unknown';
var throttleDelayMs = (req) => {
  const entry = keyFailures.get(throttleKey(req));
  if (!entry) return 0;
  if (Date.now() > entry.resetAt) {
    keyFailures.delete(throttleKey(req));
    return 0;
  }
  return entry.count >= KEY_FAIL_GRACE ? KEY_FAIL_DELAY_MS : 0;
};
var recordKeyFailure = (req) => {
  const id = throttleKey(req);
  const entry = keyFailures.get(id);
  if (!entry || Date.now() > entry.resetAt) {
    keyFailures.set(id, { count: 1, resetAt: Date.now() + KEY_FAIL_WINDOW_MS });
    return;
  }
  entry.count += 1;
};
var clearKeyFailures = (req) => {
  keyFailures.delete(throttleKey(req));
};
var READ_ONLY_METHODS = /* @__PURE__ */ new Set(['GET', 'HEAD', 'OPTIONS']);
var isReadOnlyRequest = (method) => READ_ONLY_METHODS.has(method.toUpperCase());
var canWrite = (role) => isRole(role) && ROLE_LEVELS[role] >= ROLE_LEVELS.operator;
var OVERRIDE_PATH = '/assets/sync-config-default-override.json';
var secretMatches = (presented, expected) => {
  if (typeof presented !== 'string') return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual3(a, b);
};
var PUBLIC_PATHS = /* @__PURE__ */ new Set([
  // "/" is public so its handler can decide where to send a browser (app vs
  // login) instead of the auth hook returning bare JSON 401 to a human.
  '/',
  '/api/health',
  '/api/docs',
  '/login',
  '/api/auth/login',
  '/api/auth/setup',
  '/api/auth/logout',
  '/api/auth/status',
  '/api/auth/verify',
  // Signing up necessarily happens without a session. The route refuses unless
  // an admin enabled self-registration, so the gate is there, not here.
  '/api/auth/register',
  // Carries its own X-Internal-Secret guard (see below). Listed here because
  // its caller is the web container's entrypoint, which holds JWT_SECRET but
  // no user account to authenticate as.
  '/api/internal/webapp-token',
]);
var createRestServer = (core, store, auth, internal, boards) => {
  const app = Fastify({ logger: false, trustProxy: true });
  const principals = /* @__PURE__ */ new WeakMap();
  const userForApiKey = async (req) => {
    if (!auth) return null;
    const candidates = presentedKeys(req);
    if (!candidates.length) return null;
    const delay = throttleDelayMs(req);
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    for (const candidate of candidates) {
      const keyId = parseKeyId(candidate);
      if (!keyId) continue;
      const row = await auth.store.findLiveApiKey(keyId);
      if (!row) continue;
      if (!verifyApiKey(candidate, auth.jwtSecret, materialFor(row))) continue;
      const user = await auth.store.findUserById(row.userId);
      if (!user) continue;
      clearKeyFailures(req);
      void auth.store.touchApiKey(row.id).catch(() => void 0);
      return user;
    }
    recordKeyFailure(req);
    return null;
  };
  const boardFor = async (req) => {
    const container = { core, store };
    if (!boards || !auth?.override) return container;
    const user = principals.get(req);
    if (!user) return container;
    return boards.forUser(user, await auth.override.identities.isContainerAccount(user));
  };
  const coreFor = async (req) => (await boardFor(req)).core;
  if (auth) {
    registerAuthRoutes(app, auth);
  }
  if (auth?.override) {
    const { baseUrl, encryptKey, identities, instanceId, boardHasData } = auth.override;
    app.get(OVERRIDE_PATH, async (req, reply) => {
      const session = sessionFromRequest(req, auth.sessions);
      if (!session) return reply.status(401).send({ error: 'Not signed in' });
      const user = await auth.store.findUserById(session.user.userId);
      if (!user) return reply.status(403).send({ error: 'No board for this session' });
      try {
        const accessToken = await identities.tokenForUser(user);
        reply.header('Cache-Control', 'no-store');
        return {
          syncProvider: 'SuperSync',
          superSync: {
            baseUrl,
            accessToken,
            ...(encryptKey ? { encryptKey, isEncryptionEnabled: true } : {}),
          },
          // Whose data this browser is entitled to hold. The client compares it
          // against the stamp on its local replica and purges on a mismatch, so
          // a wiped stack or a different user cannot inherit the last one's
          // board. Absent from the baked fallback file, and absence means
          // "ungated" - never a mismatch.
          //
          // `serverHasData` is what lets an UNSTAMPED replica be judged: with
          // nothing to compare against, an empty stack means this browser is
          // the only thing keeping that data alive, which is precisely the
          // resurrection case rather than a legitimate one.
          //
          // Asked per user. The bridge's own sequence describes the container
          // account only, so using it told every other account their empty
          // board was populated - the gate then adopted where it should purge.
          identity: {
            instanceId: await instanceId(),
            userId: user.id,
            // Re-read: tokenForUser() provisions on first login and writes the
            // sync id, so the row fetched above is stale for a brand-new user.
            serverHasData: await boardHasData(
              (await auth.store.findUserById(user.id))?.supersyncUserId ?? null,
            ),
          },
        };
      } catch (err) {
        return reply.status(503).send({ error: err.message });
      }
    });
  }
  if (internal) {
    app.get('/api/internal/webapp-token', async (req, reply) => {
      if (!secretMatches(req.headers['x-internal-secret'], internal.secret)) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }
      try {
        return { token: await internal.webappToken() };
      } catch (err) {
        return reply.status(503).send({ error: err.message });
      }
    });
  }
  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0];
    if (PUBLIC_PATHS.has(url)) return;
    let principal = await userForApiKey(req);
    if (!principal) {
      const session = auth && sessionFromRequest(req, auth.sessions);
      principal = session
        ? await auth?.store.findUserById(session.user.userId).catch(() => null)
        : null;
    }
    if (!principal) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
    principals.set(req, principal);
    if (url.startsWith('/api/auth/')) return;
    if (!isReadOnlyRequest(req.method) && !canWrite(principal.role)) {
      return reply.status(403).send({ error: 'Read-only account', role: principal.role });
    }
  });
  app.get('/api/health', async () => ({ status: 'ok' }));
  app.get('/api/docs', async () => DOCS);
  app.get('/api/status', async (req) => (await coreFor(req)).status());
  app.get('/api/tasks', async (req) => {
    const q = req.query;
    const isTrue = (v) => v === 'true' || v === '1';
    const filter = {
      ...(q.isDone !== void 0 ? { isDone: q.isDone === 'true' } : {}),
      ...(q.projectId !== void 0 ? { projectId: q.projectId } : {}),
      ...(q.tagId !== void 0 ? { tagId: q.tagId } : {}),
      ...(q.dueDay !== void 0 ? { dueDay: q.dueDay } : {}),
      ...(q.parentId !== void 0
        ? { parentId: q.parentId === 'null' ? null : q.parentId }
        : {}),
      ...(q.search !== void 0 ? { search: q.search } : {}),
      ...(isTrue(q.overdue) ? { overdue: true } : {}),
      ...(isTrue(q.unscheduled) ? { unscheduled: true } : {}),
      ...(isTrue(q.plannedForToday) ? { plannedForToday: true } : {}),
      ...(isTrue(q.parentsOnly) ? { parentsOnly: true } : {}),
      ...(isTrue(q.recurringOnly) ? { recurringOnly: true } : {}),
      ...(q.today !== void 0 ? { today: q.today } : {}),
      ...(q.fields !== void 0
        ? {
            fields: q.fields
              .split(',')
              .map((f) => f.trim())
              .filter(Boolean),
          }
        : {}),
    };
    return (await coreFor(req)).listTasks(filter);
  });
  app.get('/api/tasks/:id', async (req, reply) => {
    const task = (await coreFor(req)).getTask(req.params.id);
    if (!task) return reply.status(404).send({ error: 'Task not found' });
    return task;
  });
  app.get('/api/current-task', async (req) => (await coreFor(req)).getCurrentTask());
  app.get('/api/task-repeat-cfgs', async (req) =>
    (await coreFor(req)).listTaskRepeatCfgs(),
  );
  app.get('/api/planner', async (req) => (await coreFor(req)).getPlanner());
  app.get('/api/projects', async (req) => (await coreFor(req)).listProjects());
  app.get('/api/tags', async (req) => (await coreFor(req)).listTags());
  app.get('/api/config', async (req) => (await coreFor(req)).getConfig());
  app.get('/api/worklog', async (req) =>
    (await coreFor(req)).getWorklog(req.query.from, req.query.to),
  );
  app.get('/api/entities', async (req) => (await coreFor(req)).listEntityTypes());
  app.get('/api/entities/:type', async (req, reply) => {
    const entities = (await coreFor(req)).rawEntities(req.params.type);
    if (!entities) return reply.status(404).send({ error: 'Unknown entity type' });
    return entities;
  });
  app.post('/api/sync/refresh', async (req) => {
    const board = await boardFor(req);
    await board.store.refresh();
    return board.core.status();
  });
  const sendError = (reply, err) => {
    const e = err;
    return reply
      .status(e.statusCode ?? 500)
      .send({ error: e.message ?? 'Internal error' });
  };
  app.post('/api/tasks/from-syntax', async (req, reply) => {
    try {
      const b = req.body ?? {};
      const created = await (
        await coreFor(req)
      ).createTaskFromShortSyntax(b.text ?? '', b.projectId);
      return reply.status(201).send(created);
    } catch (err) {
      return sendError(reply, err);
    }
  });
  app.post('/api/tasks/:id/links', async (req, reply) => {
    try {
      const b = req.body ?? {};
      return await (
        await coreFor(req)
      ).addLinkToTask(req.params.id, b.url ?? '', b.title);
    } catch (err) {
      return sendError(reply, err);
    }
  });
  app.post('/api/tasks/:id/issue-link', async (req, reply) => {
    try {
      return await (await coreFor(req)).linkTaskToIssue(req.params.id, req.body ?? {});
    } catch (err) {
      return sendError(reply, err);
    }
  });
  app.post('/api/tasks/with-subtasks', async (req, reply) => {
    try {
      const { subTasks, ...input } = req.body ?? {};
      const created = await (
        await coreFor(req)
      ).createTaskWithSubtasks(input, Array.isArray(subTasks) ? subTasks : []);
      return reply.status(201).send(created);
    } catch (err) {
      return sendError(reply, err);
    }
  });
  app.post('/api/tasks/:id/subtasks', async (req, reply) => {
    try {
      const created = await (
        await coreFor(req)
      ).createSubTask(req.params.id, req.body ?? {});
      return reply.status(201).send(created);
    } catch (err) {
      return sendError(reply, err);
    }
  });
  app.post('/api/tasks/:id/reparent', async (req, reply) => {
    try {
      const parentId = (req.body ?? {}).parentId ?? null;
      return await (await coreFor(req)).reparentTask(req.params.id, parentId);
    } catch (err) {
      return sendError(reply, err);
    }
  });
  app.post('/api/tasks/reorder', async (req, reply) => {
    try {
      const b = req.body ?? {};
      return await (
        await coreFor(req)
      ).reorderTasks(
        { projectId: b.projectId, parentId: b.parentId, today: b.today },
        b.taskIds ?? [],
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });
  app.post('/api/today/plan', async (req, reply) => {
    try {
      const b = req.body ?? {};
      return await (await coreFor(req)).planTasksForToday(b.taskIds ?? [], b.today);
    } catch (err) {
      return sendError(reply, err);
    }
  });
  app.post('/api/today/remove', async (req, reply) => {
    try {
      return await (
        await coreFor(req)
      ).removeTasksFromToday((req.body ?? {}).taskIds ?? []);
    } catch (err) {
      return sendError(reply, err);
    }
  });
  app.post('/api/tasks/bulk/complete', async (req, reply) => {
    try {
      return await (await coreFor(req)).bulkComplete((req.body ?? {}).taskIds ?? []);
    } catch (err) {
      return sendError(reply, err);
    }
  });
  app.post('/api/tasks/bulk/update', async (req, reply) => {
    try {
      const raw = (req.body ?? {}).updates ?? [];
      const updates = raw.map(({ id, ...changes }) => ({ id, changes }));
      return await (await coreFor(req)).bulkUpdate(updates);
    } catch (err) {
      return sendError(reply, err);
    }
  });
  app.post('/api/tasks', async (req, reply) => {
    try {
      const created = await (await coreFor(req)).createTask(req.body ?? {});
      return reply.status(201).send(created);
    } catch (err) {
      return sendError(reply, err);
    }
  });
  app.patch('/api/tasks/:id', async (req, reply) => {
    try {
      return await (await coreFor(req)).updateTask(req.params.id, req.body ?? {});
    } catch (err) {
      return sendError(reply, err);
    }
  });
  app.post('/api/tasks/:id/complete', async (req, reply) => {
    try {
      return await (await coreFor(req)).completeTask(req.params.id);
    } catch (err) {
      return sendError(reply, err);
    }
  });
  app.delete('/api/tasks/:id', async (req, reply) => {
    try {
      return await (await coreFor(req)).deleteTask(req.params.id);
    } catch (err) {
      return sendError(reply, err);
    }
  });
  app.post('/api/tasks/:id/complete-on', async (req, reply) => {
    try {
      return await (
        await coreFor(req)
      ).completeTaskOn(req.params.id, (req.body ?? {}).doneOn ?? '');
    } catch (err) {
      return sendError(reply, err);
    }
  });
  app.post('/api/tasks/:id/tags', async (req, reply) => {
    try {
      const tagId = (req.body ?? {}).tagId;
      if (!tagId) return reply.status(400).send({ error: 'tagId is required' });
      return await (await coreFor(req)).addTagToTask(req.params.id, tagId);
    } catch (err) {
      return sendError(reply, err);
    }
  });
  app.delete('/api/tasks/:id/tags/:tagId', async (req, reply) => {
    try {
      return await (
        await coreFor(req)
      ).removeTagFromTask(req.params.id, req.params.tagId);
    } catch (err) {
      return sendError(reply, err);
    }
  });
  app.post('/api/tasks/:id/move', async (req, reply) => {
    try {
      const projectId = (req.body ?? {}).projectId;
      if (!projectId) return reply.status(400).send({ error: 'projectId is required' });
      return await (await coreFor(req)).moveTaskToProject(req.params.id, projectId);
    } catch (err) {
      return sendError(reply, err);
    }
  });
  app.post('/api/tags', async (req, reply) => {
    try {
      return reply.status(201).send(await (await coreFor(req)).createTag(req.body ?? {}));
    } catch (err) {
      return sendError(reply, err);
    }
  });
  app.patch('/api/tags/:id', async (req, reply) => {
    try {
      return await (await coreFor(req)).updateTag(req.params.id, req.body ?? {});
    } catch (err) {
      return sendError(reply, err);
    }
  });
  app.delete('/api/tags/:id', async (req, reply) => {
    try {
      return await (await coreFor(req)).deleteTag(req.params.id);
    } catch (err) {
      return sendError(reply, err);
    }
  });
  app.post('/api/projects', async (req, reply) => {
    try {
      return reply
        .status(201)
        .send(await (await coreFor(req)).createProject(req.body ?? {}));
    } catch (err) {
      return sendError(reply, err);
    }
  });
  app.patch('/api/projects/:id', async (req, reply) => {
    try {
      return await (await coreFor(req)).updateProject(req.params.id, req.body ?? {});
    } catch (err) {
      return sendError(reply, err);
    }
  });
  app.delete('/api/projects/:id', async (req, reply) => {
    try {
      return await (await coreFor(req)).deleteProject(req.params.id);
    } catch (err) {
      return sendError(reply, err);
    }
  });
  app.get('/api/boards', async (req) => (await coreFor(req)).listBoards());
  app.get('/api/boards/:id', async (req, reply) => {
    const board = (await coreFor(req)).getBoard(req.params.id);
    if (!board) return reply.status(404).send({ error: 'Board not found' });
    return board;
  });
  app.post('/api/boards', async (req, reply) => {
    try {
      return reply
        .status(201)
        .send(await (await coreFor(req)).createBoard(req.body ?? {}));
    } catch (err) {
      return sendError(reply, err);
    }
  });
  app.patch('/api/boards/:id', async (req, reply) => {
    try {
      return await (await coreFor(req)).updateBoard(req.params.id, req.body ?? {});
    } catch (err) {
      return sendError(reply, err);
    }
  });
  app.delete('/api/boards/:id', async (req, reply) => {
    try {
      return await (await coreFor(req)).deleteBoard(req.params.id);
    } catch (err) {
      return sendError(reply, err);
    }
  });
  app.put('/api/boards/order', async (req, reply) => {
    try {
      return await (await coreFor(req)).sortBoards(req.body?.ids ?? []);
    } catch (err) {
      return sendError(reply, err);
    }
  });
  app.post('/api/boards/:id/panels', async (req, reply) => {
    try {
      return reply
        .status(201)
        .send(await (await coreFor(req)).addPanel(req.params.id, req.body ?? {}));
    } catch (err) {
      return sendError(reply, err);
    }
  });
  app.patch('/api/boards/:id/panels/:panelId', async (req, reply) => {
    try {
      return await (
        await coreFor(req)
      ).updatePanel(req.params.id, req.params.panelId, req.body ?? {});
    } catch (err) {
      return sendError(reply, err);
    }
  });
  app.delete('/api/boards/:id/panels/:panelId', async (req, reply) => {
    try {
      return await (await coreFor(req)).removePanel(req.params.id, req.params.panelId);
    } catch (err) {
      return sendError(reply, err);
    }
  });
  app.put('/api/panels/:panelId/taskIds', async (req, reply) => {
    try {
      return await (
        await coreFor(req)
      ).setPanelTaskIds(req.params.panelId, req.body?.taskIds ?? []);
    } catch (err) {
      return sendError(reply, err);
    }
  });
  return app;
};
export { OVERRIDE_PATH, createRestServer };

import './chunk-5W5R7G7I.js';
import { SESSION_COOKIE, parseCookies } from './chunk-MD3SZICO.js';

// src/rest.ts
import Fastify from 'fastify';

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

// src/auth/login-page.ts
var SP_FONT_STACK = `-apple-system, BlinkMacSystemFont, 'Segoe UI Variable Text', 'Segoe UI', Roboto, 'Inter', 'Open Sans', 'Helvetica Neue', Arial, 'Noto Sans', sans-serif`;
var renderLoginPage = ({ isSetup, redirectTo }) => {
  const title = isSetup ? 'Create your account' : 'Sign in';
  const subtitle = isSetup
    ? 'This is the first account for this server \u2014 it will be the admin.'
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
var validateCredentials = (username, password) => {
  if (typeof username !== 'string' || !USERNAME_PATTERN.test(username)) {
    return 'Username must be 3\u201332 characters (letters, numbers, . _ -)';
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
var registerAuthRoutes = (app, { store, sessions }) => {
  const limiter = new LoginRateLimiter();
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
    const redirectTo = next && /^\/[^/\\]/.test(next) ? next : '/';
    reply.type('text/html; charset=utf-8');
    return renderLoginPage({ isSetup: store.userCount() === 0, redirectTo });
  });
  app.post('/api/auth/setup', async (req, reply) => {
    if (store.userCount() > 0) {
      return reply.status(400).send({ error: 'Setup already completed' });
    }
    const { username, password } = req.body ?? {};
    const invalid = validateCredentials(username, password);
    if (invalid) return reply.status(400).send({ error: invalid });
    const hash = await hashPassword(password);
    const user = store.createUser(username, hash, 'admin', true);
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
    const user = store.findUser(username);
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
    return {
      username: session.user.username,
      role: session.user.role,
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
  app.get('/api/auth/status', async () => ({
    setupRequired: store.userCount() === 0,
    userCount: store.userCount(),
  }));
};

// src/rest.ts
var DOCS = {
  name: 'sp-bridge API',
  version: 1,
  auth: 'Authorization: Bearer <key> or X-Api-Key: <key> (env SP_BRIDGE_API_KEY)',
  routes: {
    'GET /api/health': 'liveness (no auth)',
    'GET /api/docs': 'this document (no auth)',
    'GET /api/status': 'sync cursor, last sync time, entity counts',
    'GET /api/tasks':
      'list tasks; filters: isDone, projectId, tagId, dueDay (YYYY-MM-DD), parentId ("null" for top-level), search, overdue, unscheduled, plannedForToday, parentsOnly, recurringOnly (booleans), today (YYYY-MM-DD anchor for date filters), fields (comma-separated projection)',
    'GET /api/tasks/:id': 'single task by id',
    'GET /api/current-task':
      'active task (always null on the headless bridge \u2014 non-synced UI state)',
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
  },
};
var isAuthorized = (req, apiKey) => {
  const header = req.headers.authorization;
  if (header === `Bearer ${apiKey}`) return true;
  return req.headers['x-api-key'] === apiKey;
};
var PUBLIC_PATHS = /* @__PURE__ */ new Set([
  '/api/health',
  '/api/docs',
  '/login',
  '/api/auth/login',
  '/api/auth/setup',
  '/api/auth/logout',
  '/api/auth/status',
  '/api/auth/verify',
]);
var createRestServer = (core, store, apiKey, auth) => {
  const app = Fastify({ logger: false, trustProxy: true });
  if (auth) {
    registerAuthRoutes(app, auth);
  }
  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0];
    if (PUBLIC_PATHS.has(url)) return;
    if (isAuthorized(req, apiKey)) return;
    if (auth && sessionFromRequest(req, auth.sessions)) return;
    return reply.status(401).send({ error: 'Unauthorized' });
  });
  app.get('/api/health', async () => ({ status: 'ok' }));
  app.get('/api/docs', async () => DOCS);
  app.get('/api/status', async () => core.status());
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
    return core.listTasks(filter);
  });
  app.get('/api/tasks/:id', async (req, reply) => {
    const task = core.getTask(req.params.id);
    if (!task) return reply.status(404).send({ error: 'Task not found' });
    return task;
  });
  app.get('/api/current-task', async () => core.getCurrentTask());
  app.get('/api/task-repeat-cfgs', async () => core.listTaskRepeatCfgs());
  app.get('/api/planner', async () => core.getPlanner());
  app.get('/api/projects', async () => core.listProjects());
  app.get('/api/tags', async () => core.listTags());
  app.get('/api/config', async () => core.getConfig());
  app.get('/api/worklog', async (req) => core.getWorklog(req.query.from, req.query.to));
  app.get('/api/entities', async () => core.listEntityTypes());
  app.get('/api/entities/:type', async (req, reply) => {
    const entities = core.rawEntities(req.params.type);
    if (!entities) return reply.status(404).send({ error: 'Unknown entity type' });
    return entities;
  });
  app.post('/api/sync/refresh', async () => {
    await store.refresh();
    return core.status();
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
      const created = await core.createTaskFromShortSyntax(b.text ?? '', b.projectId);
      return reply.status(201).send(created);
    } catch (err) {
      return sendError(reply, err);
    }
  });
  app.post('/api/tasks/:id/links', async (req, reply) => {
    try {
      const b = req.body ?? {};
      return await core.addLinkToTask(req.params.id, b.url ?? '', b.title);
    } catch (err) {
      return sendError(reply, err);
    }
  });
  app.post('/api/tasks/:id/issue-link', async (req, reply) => {
    try {
      return await core.linkTaskToIssue(req.params.id, req.body ?? {});
    } catch (err) {
      return sendError(reply, err);
    }
  });
  app.post('/api/tasks/with-subtasks', async (req, reply) => {
    try {
      const { subTasks, ...input } = req.body ?? {};
      const created = await core.createTaskWithSubtasks(
        input,
        Array.isArray(subTasks) ? subTasks : [],
      );
      return reply.status(201).send(created);
    } catch (err) {
      return sendError(reply, err);
    }
  });
  app.post('/api/tasks/:id/subtasks', async (req, reply) => {
    try {
      const created = await core.createSubTask(req.params.id, req.body ?? {});
      return reply.status(201).send(created);
    } catch (err) {
      return sendError(reply, err);
    }
  });
  app.post('/api/tasks/:id/reparent', async (req, reply) => {
    try {
      const parentId = (req.body ?? {}).parentId ?? null;
      return await core.reparentTask(req.params.id, parentId);
    } catch (err) {
      return sendError(reply, err);
    }
  });
  app.post('/api/tasks/reorder', async (req, reply) => {
    try {
      const b = req.body ?? {};
      return await core.reorderTasks(
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
      return await core.planTasksForToday(b.taskIds ?? [], b.today);
    } catch (err) {
      return sendError(reply, err);
    }
  });
  app.post('/api/today/remove', async (req, reply) => {
    try {
      return await core.removeTasksFromToday((req.body ?? {}).taskIds ?? []);
    } catch (err) {
      return sendError(reply, err);
    }
  });
  app.post('/api/tasks/bulk/complete', async (req, reply) => {
    try {
      return await core.bulkComplete((req.body ?? {}).taskIds ?? []);
    } catch (err) {
      return sendError(reply, err);
    }
  });
  app.post('/api/tasks/bulk/update', async (req, reply) => {
    try {
      const raw = (req.body ?? {}).updates ?? [];
      const updates = raw.map(({ id, ...changes }) => ({ id, changes }));
      return await core.bulkUpdate(updates);
    } catch (err) {
      return sendError(reply, err);
    }
  });
  app.post('/api/tasks', async (req, reply) => {
    try {
      const created = await core.createTask(req.body ?? {});
      return reply.status(201).send(created);
    } catch (err) {
      return sendError(reply, err);
    }
  });
  app.patch('/api/tasks/:id', async (req, reply) => {
    try {
      return await core.updateTask(req.params.id, req.body ?? {});
    } catch (err) {
      return sendError(reply, err);
    }
  });
  app.post('/api/tasks/:id/complete', async (req, reply) => {
    try {
      return await core.completeTask(req.params.id);
    } catch (err) {
      return sendError(reply, err);
    }
  });
  app.delete('/api/tasks/:id', async (req, reply) => {
    try {
      return await core.deleteTask(req.params.id);
    } catch (err) {
      return sendError(reply, err);
    }
  });
  app.post('/api/tasks/:id/complete-on', async (req, reply) => {
    try {
      return await core.completeTaskOn(req.params.id, (req.body ?? {}).doneOn ?? '');
    } catch (err) {
      return sendError(reply, err);
    }
  });
  app.post('/api/tasks/:id/tags', async (req, reply) => {
    try {
      const tagId = (req.body ?? {}).tagId;
      if (!tagId) return reply.status(400).send({ error: 'tagId is required' });
      return await core.addTagToTask(req.params.id, tagId);
    } catch (err) {
      return sendError(reply, err);
    }
  });
  app.delete('/api/tasks/:id/tags/:tagId', async (req, reply) => {
    try {
      return await core.removeTagFromTask(req.params.id, req.params.tagId);
    } catch (err) {
      return sendError(reply, err);
    }
  });
  app.post('/api/tasks/:id/move', async (req, reply) => {
    try {
      const projectId = (req.body ?? {}).projectId;
      if (!projectId) return reply.status(400).send({ error: 'projectId is required' });
      return await core.moveTaskToProject(req.params.id, projectId);
    } catch (err) {
      return sendError(reply, err);
    }
  });
  app.post('/api/tags', async (req, reply) => {
    try {
      return reply.status(201).send(await core.createTag(req.body ?? {}));
    } catch (err) {
      return sendError(reply, err);
    }
  });
  app.patch('/api/tags/:id', async (req, reply) => {
    try {
      return await core.updateTag(req.params.id, req.body ?? {});
    } catch (err) {
      return sendError(reply, err);
    }
  });
  app.delete('/api/tags/:id', async (req, reply) => {
    try {
      return await core.deleteTag(req.params.id);
    } catch (err) {
      return sendError(reply, err);
    }
  });
  app.post('/api/projects', async (req, reply) => {
    try {
      return reply.status(201).send(await core.createProject(req.body ?? {}));
    } catch (err) {
      return sendError(reply, err);
    }
  });
  app.patch('/api/projects/:id', async (req, reply) => {
    try {
      return await core.updateProject(req.params.id, req.body ?? {});
    } catch (err) {
      return sendError(reply, err);
    }
  });
  app.delete('/api/projects/:id', async (req, reply) => {
    try {
      return await core.deleteProject(req.params.id);
    } catch (err) {
      return sendError(reply, err);
    }
  });
  return app;
};
export { createRestServer };

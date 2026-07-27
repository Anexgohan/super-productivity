/**
 * The canonical REST API of sp-bridge (v1, read surface).
 *
 * Design rules:
 *  - This API is the single external interface - full-featured by definition.
 *  - Self-describing: GET /api/docs returns a machine-readable route map so
 *    agents (Claude, scripts) can discover capabilities without external docs.
 *  - Auth: every /api/* route except /api/health and /api/docs requires a per-user API key or a browser session cookie.
 *    Both resolve to a user, and that user's role and board apply either way.
 */
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import type { BridgeCore, TaskFilter } from './core';
import type { StateStore } from './state-store';
import type { AuthStore, UserRow } from './auth/store';
import { isRole, ROLE_LEVELS } from './auth/store';
import type { SessionManager } from './auth/session';
import type { SyncIdentityProvider } from './auth/sync-identity';
import { registerAuthRoutes, sessionFromRequest } from './auth/routes';
import { materialFor, parseKeyId, verifyApiKey } from './auth/api-key';
import type { UserBoards } from './user-boards';

const DOCS = {
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
} as const;

/** Both header forms stay supported: `Authorization: Bearer <key>` and `X-API-Key: <key>`. */
const presentedKeys = (req: FastifyRequest): string[] => {
  const candidates: string[] = [];
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

/**
 * Failure throttle for key auth: a delay once an address starts missing, never a lockout.
 *
 * Deliberately unlike the login limiter, which locks an address out entirely. That is right for passwords, where the guessable space is small.
 * A key is 96 random bits, so online guessing is hopeless anyway, and a lockout would mainly deny service to whoever shares the address behind a NAT.
 * So a correct key ALWAYS succeeds and a wrong one just gets slower, which is enough to stop the endpoint being used as a fast oracle.
 *
 * In-memory on purpose: the bridge is one process, and a restart clearing the counters costs an attacker more than it costs us.
 */
const KEY_FAIL_GRACE = 10;
const KEY_FAIL_WINDOW_MS = 60_000;
const KEY_FAIL_DELAY_MS = 250;
const keyFailures = new Map<string, { count: number; resetAt: number }>();

const throttleKey = (req: FastifyRequest): string => req.ip ?? 'unknown';

/** How long to stall this attempt. Zero until an address has been missing repeatedly. */
const throttleDelayMs = (req: FastifyRequest): number => {
  const entry = keyFailures.get(throttleKey(req));
  if (!entry) return 0;
  if (Date.now() > entry.resetAt) {
    keyFailures.delete(throttleKey(req));
    return 0;
  }
  return entry.count >= KEY_FAIL_GRACE ? KEY_FAIL_DELAY_MS : 0;
};

const recordKeyFailure = (req: FastifyRequest): void => {
  const id = throttleKey(req);
  const entry = keyFailures.get(id);
  if (!entry || Date.now() > entry.resetAt) {
    keyFailures.set(id, { count: 1, resetAt: Date.now() + KEY_FAIL_WINDOW_MS });
    return;
  }
  entry.count += 1;
};

/** A key that verifies clears the address: one bad client must not slow a good one indefinitely. */
const clearKeyFailures = (req: FastifyRequest): void => {
  keyFailures.delete(throttleKey(req));
};

/** Methods that cannot change anything, so a viewer may use them. */
const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const isReadOnlyRequest = (method: string): boolean =>
  READ_ONLY_METHODS.has(method.toUpperCase());

/** operator and admin may write data; admin's extra powers are account management, gated per-route in auth/routes.ts. */
export const canWrite = (role: string): boolean =>
  isRole(role) && ROLE_LEVELS[role] >= ROLE_LEVELS.operator;

export interface AuthWiring {
  store: AuthStore;
  sessions: SessionManager;
  /** JWT_SECRET. API keys are derived from it rather than stored, see auth/api-key.ts. */
  jwtSecret: string;
  /** Public URL of the web app, for the post-login redirect. */
  webUrl?: string;
  /** Removes a SuperSync account and its data when an admin deletes a user. */
  purgeSyncAccount?: (supersyncUserId: number) => Promise<void>;
  /** Drops the cached read-only token for a board when it is unpublished. */
  forgetBoardReadToken?: (ownerId: number) => void;
  /** Serves each browser its own board's credentials (see below). */
  override?: SessionOverrideWiring;
}

/**
 * Per-session sync config. The web container bakes one override file at
 * startup, which is why every browser used to arrive as the same user; served
 * from here instead, the answer depends on who is asking.
 *
 * The app needs no change for this: it fetches the path same-origin, so the
 * session cookie rides along and it never learns the file became dynamic.
 */
export interface SessionOverrideWiring {
  /** Where the app should reach sync - "/sync" under the single-port layout. */
  baseUrl: string;
  /** Container-wide E2E passphrase. One key for everyone, by design - see the explainer, "Encryption is container-wide, deliberately". */
  encryptKey: string;
  /**
   * Deployment-wide Argon2 salt, base64. Generated once and served to every browser so they all derive the SAME key from the passphrase.
   *
   * Without it each session invents its own salt, so reading a board back costs one ~200ms derivation per operation rather than one per session: a hundred
   * operations meant a twenty-second first sync. Random and per-deployment, so it still prevents precomputation; per-message uniqueness is the IV's job.
   */
  encryptSalt: () => Promise<string>;
  identities: SyncIdentityProvider;
  /** Whether that user's own board holds any ops - see boardHasData. */
  boardHasData: (supersyncUserId: number | null) => Promise<boolean>;
  /**
   * Identity of this stack's data, so a browser can tell whose replica it is
   * holding. Wiping the database mints a new one, which is what makes a wipe
   * actually reach the browsers - see the explainer, "The browser is a cache".
   */
  instanceId: () => Promise<string>;
}

/** The path the app fetches. Real file on disk in the web image; proxied here when the bridge is wired up. */
export const OVERRIDE_PATH = '/assets/sync-config-default-override.json';

/**
 * Container-to-container wiring. Not part of the public API: these routes serve
 * sibling services at boot, before any user exists to hold a credential.
 */
export interface InternalWiring {
  /** JWT_SECRET, which sibling containers already hold - no new secret in .env. */
  secret: string;
  /** The durable SuperSync token the web entrypoint embeds. */
  webappToken: () => Promise<string>;
}

/**
 * Constant-time compare that also tolerates length mismatch, which
 * `timingSafeEqual` itself throws on (and a throw is a timing signal).
 */
const secretMatches = (presented: unknown, expected: string): boolean => {
  if (typeof presented !== 'string') return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
};

/** Routes reachable without any credential (login flow + liveness). */
const PUBLIC_PATHS = new Set([
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

export const createRestServer = (
  core: BridgeCore,
  store: StateStore,
  auth?: AuthWiring,
  internal?: InternalWiring,
  boards?: UserBoards,
): FastifyInstance => {
  const app = Fastify({ logger: false, trustProxy: true });

  /**
   * Who this request is, established once by the auth hook so the handlers and boardFor() agree.
   * A key and a session both resolve to a user, which is what makes "a key is its owner acting through a machine" true rather than aspirational.
   */
  const principals = new WeakMap<FastifyRequest, UserRow>();

  /** The user a presented API key belongs to, or null. Revoked and unknown keys are indistinguishable to the caller. */
  const userForApiKey = async (req: FastifyRequest): Promise<UserRow | null> => {
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
      // Usage stamp is bookkeeping: never let it fail the request it describes.
      void auth.store.touchApiKey(row.id).catch(() => undefined);
      return user;
    }
    recordKeyFailure(req);
    return null;
  };

  /**
   * The board this request acts on: the principal's own, whether they arrived by session or by API key.
   * Automation therefore addresses the same board its owner sees, rather than the container account everything used to land on.
   *
   * Falls back to the container board when no principal could be resolved, so a deployment without auth behaves exactly as it did.
   */
  const boardFor = async (
    req: FastifyRequest,
  ): Promise<{ core: BridgeCore; store: StateStore }> => {
    const container = { core, store };
    if (!boards || !auth?.override) return container;
    const user = principals.get(req);
    if (!user) return container;
    // A session reading somebody else's published board reads THAT board here too, so the API and the browser never disagree about what is on screen.
    const owner = await viewedOwner(req);
    const target = owner ?? user;
    return boards.forUser(
      target,
      await auth.override.identities.isContainerAccount(target),
    );
  };

  /**
   * The published board this request is reading, or undefined for the caller's own.
   *
   * Only a session can name one: an API key has no session and so always addresses its owner's board. Publication is re-checked on every request rather than
   * trusted from the cookie, so unpublishing takes effect immediately instead of when the session expires.
   */
  const viewedOwner = async (req: FastifyRequest): Promise<UserRow | undefined> => {
    if (!auth) return undefined;
    const session = sessionFromRequest(req, auth.sessions);
    const viewingId = session?.user.viewingUserId;
    if (!viewingId) return undefined;
    // A key presented alongside a browser's cookie must not inherit that browser's delegated board.
    if (principals.get(req)?.id !== session?.user.userId) return undefined;
    return (await auth.store.listPublicUsers()).find((u) => u.id === viewingId);
  };

  const coreFor = async (req: FastifyRequest): Promise<BridgeCore> =>
    (await boardFor(req)).core;

  if (auth) {
    registerAuthRoutes(app, auth);
  }

  if (auth?.override) {
    const { baseUrl, encryptKey, encryptSalt, identities, instanceId, boardHasData } =
      auth.override;
    app.get(OVERRIDE_PATH, async (req, reply) => {
      const session = sessionFromRequest(req, auth.sessions);
      if (!session) return reply.status(401).send({ error: 'Not signed in' });

      const user = await auth.store.findUserById(session.user.userId);
      // Session outlives the account it names - the row was deleted while a
      // cookie was still valid. 403 rather than 404: nginx falls back to the
      // baked single-account file on 404, which would hand this stale session
      // the container account's board.
      if (!user) return reply.status(403).send({ error: 'No board for this session' });

      // Reading somebody else's published board. Re-checked here rather than trusted from the cookie, so unpublishing takes effect on the next config fetch
      // instead of whenever the session happens to expire.
      const viewingId = session.user.viewingUserId;
      const owner = viewingId
        ? (await auth.store.listPublicUsers()).find((u) => u.id === viewingId)
        : undefined;
      if (viewingId && !owner) {
        return reply.status(409).send({ error: 'That board is no longer published' });
      }

      try {
        // A delegated board gets a read-scoped token. The sync API authenticates by token alone on the same public origin as the app, so an unscoped one here
        // would hand a reader full write access to data that is not theirs, whatever the bridge's own role check says.
        const accessToken = owner
          ? await identities.tokenForBoardRead(owner)
          : await identities.tokenForUser(user);
        // Never cached: the response is per-user, and a shared cache entry
        // would hand one user's token to the next.
        reply.header('Cache-Control', 'no-store');
        return {
          syncProvider: 'SuperSync',
          superSync: {
            baseUrl,
            accessToken,
            ...(encryptKey
              ? {
                  encryptKey,
                  isEncryptionEnabled: true,
                  encryptSalt: await encryptSalt(),
                }
              : {}),
          },
          // Reading someone else's shared board. The token served above is refused on every write route, so without this the app would attempt uploads,
          // collect 403s, and report a broken token - then clear its own credentials after three of them.
          isReadOnly: Boolean(owner),
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
            // The BOARD, not the reader. These are the same person unless a published board is being read, and stamping such a replica with the reader's id
            // would make it match again when they switch back to their own board - so the gate would adopt the owner's data as theirs instead of purging it.
            userId: (owner ?? user).id,
            // Re-read: tokenForUser() provisions on first login and writes the
            // sync id, so the row fetched above is stale for a brand-new user.
            serverHasData: await boardHasData(
              (await auth.store.findUserById((owner ?? user).id))?.supersyncUserId ??
                null,
            ),
          },
        };
      } catch (err) {
        // 503, not 500: the sync server being slow to come up is the usual
        // cause, and the app treats any non-OK as "no override" and keeps the
        // credentials it already holds.
        return reply.status(503).send({ error: (err as Error).message });
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
        // 503 rather than 500: the usual cause is the sync server not being up
        // yet, which is exactly what the caller should retry on.
        return reply.status(503).send({ error: (err as Error).message });
      }
    });
  }

  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0];
    if (PUBLIC_PATHS.has(url)) return;

    // A key and a session are two ways of naming the same thing, so both resolve to a user and both are held to that user's role.
    // A key no longer bypasses the ACL: an admin's key can manage accounts, a viewer's key can only read.
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

    // Account routes carry their own per-route checks (requireAdmin), and a
    // viewer legitimately POSTs to some of them - logout, own password, own
    // email. Gating them by method here would lock people out of their own
    // account.
    if (url.startsWith('/api/auth/')) return;

    // Roles were assignable in the UI but enforced nowhere: a viewer could
    // create tasks or delete boards. Writes now require operator or above.
    if (!isReadOnlyRequest(req.method) && !canWrite(principal.role)) {
      return reply.status(403).send({ error: 'Read-only account', role: principal.role });
    }

    // Somebody else's board is read-only regardless of rank. Publishing grants a look, never a hand: an admin browsing an operator's board is a reader there,
    // and the sync token served for it is read-scoped for the same reason.
    if (!isReadOnlyRequest(req.method) && (await viewedOwner(req))) {
      return reply.status(403).send({ error: 'Read-only: viewing another board' });
    }
  });

  app.get('/api/health', async () => ({ status: 'ok' }));
  app.get('/api/docs', async () => DOCS);
  app.get('/api/status', async (req) => (await coreFor(req)).status());

  app.get<{
    Querystring: {
      isDone?: string;
      projectId?: string;
      tagId?: string;
      dueDay?: string;
      parentId?: string;
      search?: string;
      overdue?: string;
      unscheduled?: string;
      plannedForToday?: string;
      parentsOnly?: string;
      recurringOnly?: string;
      today?: string;
      fields?: string;
    };
  }>('/api/tasks', async (req) => {
    const q = req.query;
    const isTrue = (v?: string): boolean => v === 'true' || v === '1';
    const filter: TaskFilter = {
      ...(q.isDone !== undefined ? { isDone: q.isDone === 'true' } : {}),
      ...(q.projectId !== undefined ? { projectId: q.projectId } : {}),
      ...(q.tagId !== undefined ? { tagId: q.tagId } : {}),
      ...(q.dueDay !== undefined ? { dueDay: q.dueDay } : {}),
      ...(q.parentId !== undefined
        ? { parentId: q.parentId === 'null' ? null : q.parentId }
        : {}),
      ...(q.search !== undefined ? { search: q.search } : {}),
      ...(isTrue(q.overdue) ? { overdue: true } : {}),
      ...(isTrue(q.unscheduled) ? { unscheduled: true } : {}),
      ...(isTrue(q.plannedForToday) ? { plannedForToday: true } : {}),
      ...(isTrue(q.parentsOnly) ? { parentsOnly: true } : {}),
      ...(isTrue(q.recurringOnly) ? { recurringOnly: true } : {}),
      ...(q.today !== undefined ? { today: q.today } : {}),
      ...(q.fields !== undefined
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

  app.get<{ Params: { id: string } }>('/api/tasks/:id', async (req, reply) => {
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

  app.get<{ Querystring: { from?: string; to?: string } }>('/api/worklog', async (req) =>
    (await coreFor(req)).getWorklog(req.query.from, req.query.to),
  );

  app.get('/api/entities', async (req) => (await coreFor(req)).listEntityTypes());
  app.get<{ Params: { type: string } }>('/api/entities/:type', async (req, reply) => {
    const entities = (await coreFor(req)).rawEntities(req.params.type);
    if (!entities) return reply.status(404).send({ error: 'Unknown entity type' });
    return entities;
  });

  app.post('/api/sync/refresh', async (req) => {
    const board = await boardFor(req);
    await board.store.refresh();
    return board.core.status();
  });

  // ── Writes ────────────────────────────────────────────────────────────────
  const sendError = (
    reply: { status: (c: number) => { send: (b: unknown) => unknown } },
    err: unknown,
  ): unknown => {
    const e = err as { statusCode?: number; message?: string };
    return reply
      .status(e.statusCode ?? 500)
      .send({ error: e.message ?? 'Internal error' });
  };

  app.post<{ Body: { text?: string; projectId?: string } }>(
    '/api/tasks/from-syntax',
    async (req, reply) => {
      try {
        const b = req.body ?? {};
        const created = await (
          await coreFor(req)
        ).createTaskFromShortSyntax(b.text ?? '', b.projectId);
        return reply.status(201).send(created);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { url?: string; title?: string } }>(
    '/api/tasks/:id/links',
    async (req, reply) => {
      try {
        const b = req.body ?? {};
        return await (
          await coreFor(req)
        ).addLinkToTask(req.params.id, b.url ?? '', b.title);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post<{
    Params: { id: string };
    Body: {
      issueId?: string;
      issueType?: string;
      issueProviderId?: string;
      issuePoints?: number;
    };
  }>('/api/tasks/:id/issue-link', async (req, reply) => {
    try {
      return await (await coreFor(req)).linkTaskToIssue(req.params.id, req.body ?? {});
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{ Body: Record<string, unknown> & { subTasks?: string[] } }>(
    '/api/tasks/with-subtasks',
    async (req, reply) => {
      try {
        const { subTasks, ...input } = req.body ?? {};
        const created = await (
          await coreFor(req)
        ).createTaskWithSubtasks(input as never, Array.isArray(subTasks) ? subTasks : []);
        return reply.status(201).send(created);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/tasks/:id/subtasks',
    async (req, reply) => {
      try {
        const created = await (
          await coreFor(req)
        ).createSubTask(req.params.id, (req.body ?? {}) as never);
        return reply.status(201).send(created);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { parentId?: string | null } }>(
    '/api/tasks/:id/reparent',
    async (req, reply) => {
      try {
        const parentId = (req.body ?? {}).parentId ?? null;
        return await (await coreFor(req)).reparentTask(req.params.id, parentId);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post<{
    Body: { taskIds?: string[]; projectId?: string; parentId?: string; today?: boolean };
  }>('/api/tasks/reorder', async (req, reply) => {
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

  app.post<{ Body: { taskIds?: string[]; today?: string } }>(
    '/api/today/plan',
    async (req, reply) => {
      try {
        const b = req.body ?? {};
        return await (await coreFor(req)).planTasksForToday(b.taskIds ?? [], b.today);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post<{ Body: { taskIds?: string[] } }>('/api/today/remove', async (req, reply) => {
    try {
      return await (
        await coreFor(req)
      ).removeTasksFromToday((req.body ?? {}).taskIds ?? []);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{ Body: { taskIds?: string[] } }>(
    '/api/tasks/bulk/complete',
    async (req, reply) => {
      try {
        return await (await coreFor(req)).bulkComplete((req.body ?? {}).taskIds ?? []);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post<{ Body: { updates?: { id: string; [k: string]: unknown }[] } }>(
    '/api/tasks/bulk/update',
    async (req, reply) => {
      try {
        const raw = (req.body ?? {}).updates ?? [];
        const updates = raw.map(({ id, ...changes }) => ({ id, changes }));
        return await (await coreFor(req)).bulkUpdate(updates);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post<{ Body: Record<string, unknown> }>('/api/tasks', async (req, reply) => {
    try {
      const created = await (await coreFor(req)).createTask((req.body ?? {}) as never);
      return reply.status(201).send(created);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/tasks/:id',
    async (req, reply) => {
      try {
        return await (
          await coreFor(req)
        ).updateTask(req.params.id, (req.body ?? {}) as Record<string, unknown>);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post<{ Params: { id: string } }>('/api/tasks/:id/complete', async (req, reply) => {
    try {
      return await (await coreFor(req)).completeTask(req.params.id);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>('/api/tasks/:id', async (req, reply) => {
    try {
      return await (await coreFor(req)).deleteTask(req.params.id);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{ Params: { id: string }; Body: { doneOn?: string } }>(
    '/api/tasks/:id/complete-on',
    async (req, reply) => {
      try {
        return await (
          await coreFor(req)
        ).completeTaskOn(req.params.id, (req.body ?? {}).doneOn ?? '');
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { tagId?: string } }>(
    '/api/tasks/:id/tags',
    async (req, reply) => {
      try {
        const tagId = (req.body ?? {}).tagId;
        if (!tagId) return reply.status(400).send({ error: 'tagId is required' });
        return await (await coreFor(req)).addTagToTask(req.params.id, tagId);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.delete<{ Params: { id: string; tagId: string } }>(
    '/api/tasks/:id/tags/:tagId',
    async (req, reply) => {
      try {
        return await (
          await coreFor(req)
        ).removeTagFromTask(req.params.id, req.params.tagId);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { projectId?: string } }>(
    '/api/tasks/:id/move',
    async (req, reply) => {
      try {
        const projectId = (req.body ?? {}).projectId;
        if (!projectId) return reply.status(400).send({ error: 'projectId is required' });
        return await (await coreFor(req)).moveTaskToProject(req.params.id, projectId);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // ── Tags (write) ──────────────────────────────────────────────────────────
  app.post<{ Body: Record<string, unknown> }>('/api/tags', async (req, reply) => {
    try {
      return reply
        .status(201)
        .send(await (await coreFor(req)).createTag((req.body ?? {}) as never));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/tags/:id',
    async (req, reply) => {
      try {
        return await (
          await coreFor(req)
        ).updateTag(req.params.id, (req.body ?? {}) as Record<string, unknown>);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.delete<{ Params: { id: string } }>('/api/tags/:id', async (req, reply) => {
    try {
      return await (await coreFor(req)).deleteTag(req.params.id);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ── Projects (write) ──────────────────────────────────────────────────────
  app.post<{ Body: Record<string, unknown> }>('/api/projects', async (req, reply) => {
    try {
      return reply
        .status(201)
        .send(await (await coreFor(req)).createProject((req.body ?? {}) as never));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/projects/:id',
    async (req, reply) => {
      try {
        return await (
          await coreFor(req)
        ).updateProject(req.params.id, (req.body ?? {}) as Record<string, unknown>);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    try {
      return await (await coreFor(req)).deleteProject(req.params.id);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ── Boards ──────────────────────────────────────────────────────────────────
  // Columns are panels; a task is in a column because it matches that panel's
  // filters, so moving cards is still done by changing tags on the task. These
  // routes shape the board itself, which previously had no write path at all.

  app.get('/api/boards', async (req) => (await coreFor(req)).listBoards());

  app.get<{ Params: { id: string } }>('/api/boards/:id', async (req, reply) => {
    const board = (await coreFor(req)).getBoard(req.params.id);
    if (!board) return reply.status(404).send({ error: 'Board not found' });
    return board;
  });

  app.post<{ Body: Record<string, unknown> }>('/api/boards', async (req, reply) => {
    try {
      return reply
        .status(201)
        .send(await (await coreFor(req)).createBoard((req.body ?? {}) as never));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/boards/:id',
    async (req, reply) => {
      try {
        return await (
          await coreFor(req)
        ).updateBoard(req.params.id, (req.body ?? {}) as Record<string, unknown>);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.delete<{ Params: { id: string } }>('/api/boards/:id', async (req, reply) => {
    try {
      return await (await coreFor(req)).deleteBoard(req.params.id);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Before /api/boards/:id/panels/:panelId so "order" is never read as a panel id.
  app.put<{ Body: { ids?: string[] } }>('/api/boards/order', async (req, reply) => {
    try {
      return await (await coreFor(req)).sortBoards(req.body?.ids ?? []);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/boards/:id/panels',
    async (req, reply) => {
      try {
        return reply
          .status(201)
          .send(
            await (await coreFor(req)).addPanel(req.params.id, (req.body ?? {}) as never),
          );
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.patch<{
    Params: { id: string; panelId: string };
    Body: Record<string, unknown>;
  }>('/api/boards/:id/panels/:panelId', async (req, reply) => {
    try {
      return await (
        await coreFor(req)
      ).updatePanel(
        req.params.id,
        req.params.panelId,
        (req.body ?? {}) as Record<string, unknown>,
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete<{ Params: { id: string; panelId: string } }>(
    '/api/boards/:id/panels/:panelId',
    async (req, reply) => {
      try {
        return await (await coreFor(req)).removePanel(req.params.id, req.params.panelId);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.put<{ Params: { panelId: string }; Body: { taskIds?: string[] } }>(
    '/api/panels/:panelId/taskIds',
    async (req, reply) => {
      try {
        return await (
          await coreFor(req)
        ).setPanelTaskIds(req.params.panelId, req.body?.taskIds ?? []);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  return app;
};

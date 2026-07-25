/**
 * The canonical REST API of sp-bridge (v1, read surface).
 *
 * Design rules:
 *  - This API is the single external interface — full-featured by definition.
 *  - Self-describing: GET /api/docs returns a machine-readable route map so
 *    agents (Claude, scripts) can discover capabilities without external docs.
 *  - Auth: every /api/* route except /api/health and /api/docs requires the
 *    key from SP_BRIDGE_API_KEY via `Authorization: Bearer <key>` or
 *    `X-Api-Key: <key>`.
 */
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import type { BridgeCore, TaskFilter } from './core';
import type { StateStore } from './state-store';
import type { AuthStore } from './auth/store';
import { isRole, ROLE_LEVELS } from './auth/store';
import type { SessionManager } from './auth/session';
import type { SyncIdentityProvider } from './auth/sync-identity';
import { registerAuthRoutes, sessionFromRequest } from './auth/routes';
import { verifyApiKey } from './auth/api-key';
import type { UserBoards } from './user-boards';

const DOCS = {
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
      'active task (always null on the headless bridge — non-synced UI state)',
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
} as const;

/**
 * Machine auth. Both header forms stay supported; each candidate is checked
 * against the stored DIGEST rather than the key itself (see auth/api-key.ts).
 */
const isAuthorized = (req: FastifyRequest, apiKeyHash: string): boolean => {
  const candidates: string[] = [];
  const header = req.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    candidates.push(header.slice('Bearer '.length));
  }
  const xApiKey = req.headers['x-api-key'];
  if (typeof xApiKey === 'string') {
    candidates.push(xApiKey);
  }
  return candidates.some((candidate) => verifyApiKey(candidate, apiKeyHash));
};

/** Methods that cannot change anything, so a viewer may use them. */
const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const isReadOnlyRequest = (method: string): boolean =>
  READ_ONLY_METHODS.has(method.toUpperCase());

/** operator and admin may write data; admin's extra powers are account management, gated per-route in auth/routes.ts. */
const canWrite = (role: string): boolean =>
  isRole(role) && ROLE_LEVELS[role] >= ROLE_LEVELS.operator;

export interface AuthWiring {
  store: AuthStore;
  sessions: SessionManager;
  /** Public URL of the web app, for the post-login redirect. */
  webUrl?: string;
  /** Removes a SuperSync account and its data when an admin deletes a user. */
  purgeSyncAccount?: (supersyncUserId: number) => Promise<void>;
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
  /** Where the app should reach sync — "/sync" under the single-port layout. */
  baseUrl: string;
  /** Container-wide E2E passphrase. One key for everyone, by design — see the explainer, "Encryption is container-wide, deliberately". */
  encryptKey: string;
  identities: SyncIdentityProvider;
  /** Whether that user's own board holds any ops — see boardHasData. */
  boardHasData: (supersyncUserId: number | null) => Promise<boolean>;
  /**
   * Identity of this stack's data, so a browser can tell whose replica it is
   * holding. Wiping the database mints a new one, which is what makes a wipe
   * actually reach the browsers — see the explainer, "The browser is a cache".
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
  /** JWT_SECRET, which sibling containers already hold — no new secret in .env. */
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
  // deliberately not SP_BRIDGE_API_KEY.
  '/api/internal/webapp-token',
]);

export const createRestServer = (
  core: BridgeCore,
  store: StateStore,
  apiKeyHash: string,
  auth?: AuthWiring,
  internal?: InternalWiring,
  boards?: UserBoards,
): FastifyInstance => {
  const app = Fastify({ logger: false, trustProxy: true });

  /**
   * The board this request acts on.
   *
   * A browser session names a user, so it gets that user's own board. The API
   * key names nobody — it is a deployment secret — so it stays on the container
   * account, which is where every caller landed before boards were per-user.
   * Per-user keys are what will let automation address any board.
   *
   * Falls back to the container board whenever the caller cannot be resolved,
   * so a deployment without auth behaves exactly as it did.
   */
  const boardFor = async (
    req: FastifyRequest,
  ): Promise<{ core: BridgeCore; store: StateStore }> => {
    const container = { core, store };
    if (!boards || !auth?.override) return container;
    const session = sessionFromRequest(req, auth.sessions);
    if (!session) return container;
    const user = await auth.store.findUserById(session.user.userId);
    if (!user) return container;
    return boards.forUser(user, await auth.override.identities.isContainerAccount(user));
  };

  const coreFor = async (req: FastifyRequest): Promise<BridgeCore> =>
    (await boardFor(req)).core;

  if (auth) {
    registerAuthRoutes(app, auth);
  }

  if (auth?.override) {
    const { baseUrl, encryptKey, identities, instanceId, boardHasData } = auth.override;
    app.get(OVERRIDE_PATH, async (req, reply) => {
      const session = sessionFromRequest(req, auth.sessions);
      if (!session) return reply.status(401).send({ error: 'Not signed in' });

      const user = await auth.store.findUserById(session.user.userId);
      // Session outlives the account it names — the row was deleted while a
      // cookie was still valid. 403 rather than 404: nginx falls back to the
      // baked single-account file on 404, which would hand this stale session
      // the container account's board.
      if (!user) return reply.status(403).send({ error: 'No board for this session' });

      try {
        const accessToken = await identities.tokenForUser(user);
        // Never cached: the response is per-user, and a shared cache entry
        // would hand one user's token to the next.
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
          // "ungated" — never a mismatch.
          //
          // `serverHasData` is what lets an UNSTAMPED replica be judged: with
          // nothing to compare against, an empty stack means this browser is
          // the only thing keeping that data alive, which is precisely the
          // resurrection case rather than a legitimate one.
          //
          // Asked per user. The bridge's own sequence describes the container
          // account only, so using it told every other account their empty
          // board was populated — the gate then adopted where it should purge.
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
    // Machine clients present the API key; browsers present a session cookie.
    // Either is sufficient — they authenticate different kinds of caller.
    // The key is a deployment secret with no role attached, so it stays
    // unrestricted: it IS the admin credential for automation.
    if (isAuthorized(req, apiKeyHash)) return;

    const session = auth && sessionFromRequest(req, auth.sessions);
    if (!session) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    // Account routes carry their own per-route checks (requireAdmin), and a
    // viewer legitimately POSTs to some of them — logout, own password, own
    // email. Gating them by method here would lock people out of their own
    // account.
    if (url.startsWith('/api/auth/')) return;

    // Roles were assignable in the UI but enforced nowhere: a viewer could
    // create tasks or delete boards. Writes now require operator or above.
    if (!isReadOnlyRequest(req.method) && !canWrite(session.user.role)) {
      return reply
        .status(403)
        .send({ error: 'Read-only account', role: session.user.role });
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

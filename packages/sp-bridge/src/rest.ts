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
import type { BridgeCore, TaskFilter } from './core';
import type { StateStore } from './state-store';

const DOCS = {
  name: 'sp-bridge API',
  version: 1,
  auth: "Authorization: Bearer <key> or X-Api-Key: <key> (env SP_BRIDGE_API_KEY)",
  routes: {
    'GET /api/health': 'liveness (no auth)',
    'GET /api/docs': 'this document (no auth)',
    'GET /api/status': 'sync cursor, last sync time, entity counts',
    'GET /api/tasks':
      'list tasks; filters: isDone, projectId, tagId, dueDay (YYYY-MM-DD), parentId ("null" for top-level), search',
    'GET /api/tasks/:id': 'single task by id',
    'GET /api/projects': 'list projects',
    'GET /api/tags': 'list tags',
    'GET /api/config': 'global config (by section)',
    'GET /api/worklog': 'time spent per day; filters: from, to (YYYY-MM-DD)',
    'GET /api/entities': 'list materialized entity types (raw superset access)',
    'GET /api/entities/:type': 'raw entity map for a type',
    'POST /api/sync/refresh': 'force an op-log pull now',
    'POST /api/tasks':
      'create task; body: {title (required), projectId?, notes?, timeEstimate?, tagIds?, dueDay?, dueWithTime?}',
    'PATCH /api/tasks/:id':
      'update task; body: partial of {title, notes, isDone, doneOn, timeEstimate, timeSpent, projectId, tagIds, dueDay, dueWithTime}',
    'POST /api/tasks/:id/complete': 'mark task done (sets doneOn)',
    'DELETE /api/tasks/:id': 'delete task (refuses while subtasks exist)',
  },
} as const;

const isAuthorized = (req: FastifyRequest, apiKey: string): boolean => {
  const header = req.headers.authorization;
  if (header === `Bearer ${apiKey}`) return true;
  return req.headers['x-api-key'] === apiKey;
};

export const createRestServer = (
  core: BridgeCore,
  store: StateStore,
  apiKey: string,
): FastifyInstance => {
  const app = Fastify({ logger: false });

  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0];
    if (url === '/api/health' || url === '/api/docs') return;
    if (!isAuthorized(req, apiKey)) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
  });

  app.get('/api/health', async () => ({ status: 'ok' }));
  app.get('/api/docs', async () => DOCS);
  app.get('/api/status', async () => core.status());

  app.get<{
    Querystring: {
      isDone?: string;
      projectId?: string;
      tagId?: string;
      dueDay?: string;
      parentId?: string;
      search?: string;
    };
  }>('/api/tasks', async (req) => {
    const q = req.query;
    const filter: TaskFilter = {
      ...(q.isDone !== undefined ? { isDone: q.isDone === 'true' } : {}),
      ...(q.projectId !== undefined ? { projectId: q.projectId } : {}),
      ...(q.tagId !== undefined ? { tagId: q.tagId } : {}),
      ...(q.dueDay !== undefined ? { dueDay: q.dueDay } : {}),
      ...(q.parentId !== undefined
        ? { parentId: q.parentId === 'null' ? null : q.parentId }
        : {}),
      ...(q.search !== undefined ? { search: q.search } : {}),
    };
    return core.listTasks(filter);
  });

  app.get<{ Params: { id: string } }>('/api/tasks/:id', async (req, reply) => {
    const task = core.getTask(req.params.id);
    if (!task) return reply.status(404).send({ error: 'Task not found' });
    return task;
  });

  app.get('/api/projects', async () => core.listProjects());
  app.get('/api/tags', async () => core.listTags());
  app.get('/api/config', async () => core.getConfig());

  app.get<{ Querystring: { from?: string; to?: string } }>(
    '/api/worklog',
    async (req) => core.getWorklog(req.query.from, req.query.to),
  );

  app.get('/api/entities', async () => core.listEntityTypes());
  app.get<{ Params: { type: string } }>('/api/entities/:type', async (req, reply) => {
    const entities = core.rawEntities(req.params.type);
    if (!entities) return reply.status(404).send({ error: 'Unknown entity type' });
    return entities;
  });

  app.post('/api/sync/refresh', async () => {
    await store.refresh();
    return core.status();
  });

  // ── Writes ────────────────────────────────────────────────────────────────
  const sendError = (reply: { status: (c: number) => { send: (b: unknown) => unknown } }, err: unknown): unknown => {
    const e = err as { statusCode?: number; message?: string };
    return reply
      .status(e.statusCode ?? 500)
      .send({ error: e.message ?? 'Internal error' });
  };

  app.post<{ Body: Record<string, unknown> }>('/api/tasks', async (req, reply) => {
    try {
      const created = await core.createTask((req.body ?? {}) as never);
      return reply.status(201).send(created);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/tasks/:id',
    async (req, reply) => {
      try {
        return await core.updateTask(req.params.id, (req.body ?? {}) as Record<string, unknown>);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post<{ Params: { id: string } }>('/api/tasks/:id/complete', async (req, reply) => {
    try {
      return await core.completeTask(req.params.id);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>('/api/tasks/:id', async (req, reply) => {
    try {
      return await core.deleteTask(req.params.id);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  return app;
};

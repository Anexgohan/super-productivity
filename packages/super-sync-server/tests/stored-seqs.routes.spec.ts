/**
 * POST /api/sync/stored: the numbers a browser's saves were stored under, for a browser whose upload answer never came back.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import * as jwt from 'jsonwebtoken';
import { uuidv7 } from 'uuidv7';
import { initDb } from '../src/db';
import { getSyncService, initSyncService } from '../src/sync/sync.service';
import { syncRoutes } from '../src/sync/sync.routes';
import { Operation } from '../src/sync/sync.types';

const userId = 1;
const clientId = 'client-1';

const edit = (entityId: string): Operation => ({
  id: uuidv7(),
  clientId,
  actionType: '[Task Shared] updateTask',
  opType: 'UPD',
  entityType: 'TASK',
  entityId,
  payload: { task: { id: entityId, changes: { title: entityId } } },
  vectorClock: { [clientId]: 1 },
  timestamp: Date.now() - 60_000,
  schemaVersion: 1,
});

describe('POST /api/sync/stored', () => {
  let app: FastifyInstance;
  const token = jwt.sign(
    { userId, email: 'test@test.com' },
    'super-sync-dev-secret-do-not-use-in-production',
    { expiresIn: '1d' },
  );

  beforeEach(async () => {
    initDb('./data', true);
    initSyncService();
    app = Fastify();
    await app.register(syncRoutes, { prefix: '/api/sync' });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  const ask = (body: unknown, withToken = true) =>
    app.inject({
      method: 'POST',
      url: '/api/sync/stored',
      headers: withToken ? { authorization: `Bearer ${token}` } : {},
      payload: body as object,
    });

  it("answers the numbers of the caller's stored saves and leaves out saves it does not hold", async () => {
    const first = edit('t1');
    const second = edit('t2');
    const results = await getSyncService().uploadOps(userId, clientId, [first, second]);
    const seqOf = (opId: string): number | undefined =>
      results.find((result) => result.opId === opId)?.serverSeq;

    const response = await ask({ opIds: [second.id, 'never-sent', first.id] });

    expect(response.statusCode).toBe(200);
    const { stored } = response.json() as {
      stored: { opId: string; serverSeq: number }[];
    };
    expect([...stored].sort((a, b) => a.serverSeq - b.serverSeq)).toEqual([
      { opId: first.id, serverSeq: seqOf(first.id) },
      { opId: second.id, serverSeq: seqOf(second.id) },
    ]);
  });

  it("never answers another user's saves", async () => {
    const theirs = edit('t1');
    const [result] = await getSyncService().uploadOps(2, clientId, [theirs]);
    expect(result.accepted).toBe(true);

    const response = await ask({ opIds: [theirs.id] });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ stored: [] });
  });

  it('needs a signed-in user', async () => {
    expect((await ask({ opIds: ['op-1'] }, false)).statusCode).toBe(401);
  });

  it('refuses an empty list and more than 500 ids', async () => {
    expect((await ask({ opIds: [] })).statusCode).toBe(400);
    const opIds = Array.from({ length: 501 }, (_, i) => `op-${i}`);
    expect((await ask({ opIds })).statusCode).toBe(400);
  });
});

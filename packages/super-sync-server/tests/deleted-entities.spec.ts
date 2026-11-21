import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import Fastify, { FastifyInstance } from 'fastify';
import * as jwt from 'jsonwebtoken';
import { uuidv7 } from 'uuidv7';
import { initDb, prisma } from '../src/db';
import { getSyncService, initSyncService } from '../src/sync/sync.service';
import { syncRoutes } from '../src/sync/sync.routes';
import {
  deleteOldDeleteRecords,
  deletesNamedBy,
  DELETED_ENTITY_RETENTION_MS,
  recordDeletes,
} from '../src/sync/deleted-entities';
import { Operation } from '../src/sync/sync.types';

const userId = 1;
const clientId = 'client-1';

const op = (overrides: Partial<Operation>): Operation => ({
  id: uuidv7(),
  clientId,
  actionType: '[Task Shared] deleteTask',
  opType: 'DEL',
  entityType: 'TASK',
  entityId: 't1',
  payload: { task: { id: 't1' } },
  vectorClock: { [clientId]: 1 },
  timestamp: Date.now() - 60_000,
  schemaVersion: 1,
  ...overrides,
});

const storedRows = async (): Promise<
  { userId: number; entityType: string; entityId: string; deletedAt: number }[]
> =>
  (await prisma.deletedEntity.findMany({ where: { userId } }))
    .map((row) => ({
      userId: row.userId,
      entityType: row.entityType,
      entityId: row.entityId,
      deletedAt: Number(row.deletedAt),
    }))
    .sort((a, b) => a.entityId.localeCompare(b.entityId));

describe('deletesNamedBy', () => {
  it('names every task and note id of a delete, with the latest delete time of each', () => {
    expect(
      deletesNamedBy([
        op({ entityId: 't1', timestamp: 10 }),
        op({ entityId: 't2', entityIds: ['t2', 't3'], timestamp: 20 }),
        op({ entityType: 'NOTE', entityId: 'n1', timestamp: 30 }),
        op({ entityId: 't1', timestamp: 40 }),
        op({ entityId: 't1', timestamp: 5 }),
      ]),
    ).toEqual([
      { entityType: 'TASK', entityId: 't1', deletedAt: 40 },
      { entityType: 'TASK', entityId: 't2', deletedAt: 20 },
      { entityType: 'TASK', entityId: 't3', deletedAt: 20 },
      { entityType: 'NOTE', entityId: 'n1', deletedAt: 30 },
    ]);
  });

  it('names nothing for a project delete or an edit', () => {
    expect(
      deletesNamedBy([
        op({ entityType: 'PROJECT', entityId: 'p1' }),
        op({ opType: 'UPD', entityId: 't1' }),
      ]),
    ).toEqual([]);
  });
});

describe('pruning the delete records', () => {
  beforeEach(() => {
    initDb('./data', true);
    initSyncService();
  });

  it('prunes the records stored before the cutoff, by server time', async () => {
    const service = getSyncService();
    const now = Date.now();
    await prisma.deletedEntity.createMany({
      data: [
        {
          userId,
          entityType: 'TASK',
          entityId: 'old',
          // A device clock far ahead does not keep a record alive.
          deletedAt: BigInt(now + 10 * DELETED_ENTITY_RETENTION_MS),
          recordedAt: BigInt(now - DELETED_ENTITY_RETENTION_MS - 1),
        },
        {
          userId,
          entityType: 'TASK',
          entityId: 'recent',
          deletedAt: BigInt(now - 10 * DELETED_ENTITY_RETENTION_MS),
          recordedAt: BigInt(now - 1_000),
        },
      ],
    });

    expect(await service.deleteOldDeleteRecords(now - DELETED_ENTITY_RETENTION_MS)).toBe(
      1,
    );
    expect((await storedRows()).map((row) => row.entityId)).toEqual(['recent']);
  });
});

describe('recording deletes', () => {
  beforeEach(() => {
    initDb('./data', true);
  });

  it('records a delete whose expired record the cleanup removes while the upload records it', async () => {
    const now = Date.now();
    const expired = BigInt(now - DELETED_ENTITY_RETENTION_MS - 1);
    await prisma.deletedEntity.createMany({
      data: [
        {
          userId,
          entityType: 'TASK',
          entityId: 't1',
          deletedAt: expired,
          recordedAt: expired,
        },
      ],
    });
    // The cleanup runs outside the user's lock, so it can remove the row between the upload's read and its write.
    const findMany = vi.mocked(prisma.deletedEntity.findMany);
    const read = findMany.getMockImplementation()!;
    findMany.mockImplementationOnce(async (args) => {
      const rows = await read(args);
      await deleteOldDeleteRecords(now - DELETED_ENTITY_RETENTION_MS);
      return rows;
    });

    await recordDeletes(
      prisma as unknown as Prisma.TransactionClient,
      userId,
      [op({ entityId: 't1', timestamp: now - 1_000 })],
      now,
    );
    expect(await storedRows()).toEqual([
      { userId, entityType: 'TASK', entityId: 't1', deletedAt: now - 1_000 },
    ]);
  });
});

describe('POST /api/sync/deleted', () => {
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
      url: '/api/sync/deleted',
      headers: withToken ? { authorization: `Bearer ${token}` } : {},
      payload: body as object,
    });

  it("answers the caller's recorded delete times and leaves out items without one and other users' records", async () => {
    await getSyncService().uploadOps(userId, clientId, [
      op({ entityId: 't1', timestamp: 1_000 }),
    ]);
    await prisma.deletedEntity.createMany({
      data: [
        {
          userId: 2,
          entityType: 'TASK',
          entityId: 't2',
          deletedAt: BigInt(2_000),
          recordedAt: BigInt(Date.now()),
        },
      ],
    });

    const response = await ask({
      items: [
        { entityType: 'TASK', entityId: 't1' },
        { entityType: 'TASK', entityId: 't2' },
        { entityType: 'NOTE', entityId: 't1' },
      ],
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      deleted: [{ entityType: 'TASK', entityId: 't1', deletedAt: 1_000 }],
    });
  });

  it('needs a signed-in user', async () => {
    const response = await ask(
      { items: [{ entityType: 'TASK', entityId: 't1' }] },
      false,
    );
    expect(response.statusCode).toBe(401);
  });

  it('refuses other entity types and more than 500 items', async () => {
    expect(
      (await ask({ items: [{ entityType: 'PROJECT', entityId: 'p1' }] })).statusCode,
    ).toBe(400);
    const items = Array.from({ length: 501 }, (_, i) => ({
      entityType: 'TASK',
      entityId: `t${i}`,
    }));
    expect((await ask({ items })).statusCode).toBe(400);
  });
});

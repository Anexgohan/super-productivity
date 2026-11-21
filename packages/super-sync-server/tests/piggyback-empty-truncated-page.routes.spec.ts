/** A budget-cut piggyback page emptied by a wipe between its two reads still answers 200 with more to download: the upload is stored. */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';

const mocks = vi.hoisted(() => {
  const syncService = {
    isRateLimited: vi.fn(),
    checkOpsRequestDedup: vi.fn(),
    cacheOpsRequestResults: vi.fn(),
    checkStorageQuota: vi.fn(),
    uploadOps: vi.fn(),
    updateStorageUsage: vi.fn(),
    incrementStorageUsage: vi.fn(),
    decrementStorageUsage: vi.fn(),
    runWithStorageUsageLock: vi.fn(),
    freeStorageForUpload: vi.fn(),
    getLatestSeq: vi.fn(),
    getOpsSinceWithSeq: vi.fn(),
    getStorageInfo: vi.fn(),
    getCachedSnapshotBytes: vi.fn(),
    getMaxClockDriftMs: vi.fn(),
    filterValidOpsForQuota: vi.fn(),
    getPrevalidatedPayloadBytes: vi.fn(),
  };
  const prisma = {
    operation: { findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn() },
  };
  return { syncService, prisma, notifyNewOps: vi.fn() };
});

vi.mock('../src/auth', () => ({
  verifyToken: vi
    .fn()
    .mockResolvedValue({ valid: true, userId: 1, email: 'test@test.com' }),
}));
vi.mock('../src/sync/sync.service', () => ({
  getSyncService: () => mocks.syncService,
}));
vi.mock('../src/sync/services/websocket-connection.service', () => ({
  getWsConnectionService: () => ({ notifyNewOps: mocks.notifyNewOps }),
}));
vi.mock('../src/db', () => ({ prisma: mocks.prisma }));

import { syncRoutes } from '../src/sync/sync.routes';

const clientId = 'uploading-client';
const QUOTA = 100 * 1024 * 1024;

const createOp = (): unknown => ({
  id: 'op-1',
  clientId,
  actionType: 'ADD_TASK',
  opType: 'CRT',
  entityType: 'TASK',
  entityId: 'task-1',
  payload: { title: 'Test Task' },
  vectorClock: {},
  timestamp: Date.now(),
  schemaVersion: 1,
});

describe('Upload piggyback: a budget-cut page that comes back empty', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.syncService.isRateLimited.mockReturnValue(false);
    mocks.syncService.checkOpsRequestDedup.mockReturnValue(null);
    mocks.syncService.checkStorageQuota.mockResolvedValue({
      allowed: true,
      currentUsage: 0,
      quota: QUOTA,
    });
    mocks.syncService.runWithStorageUsageLock.mockImplementation(
      async (_userId: number, fn: () => Promise<unknown>) => fn(),
    );
    mocks.syncService.getStorageInfo.mockResolvedValue({
      storageUsedBytes: 0,
      storageQuotaBytes: QUOTA,
    });
    mocks.syncService.getCachedSnapshotBytes.mockResolvedValue(0);
    mocks.syncService.getMaxClockDriftMs.mockReturnValue(60_000);
    mocks.syncService.filterValidOpsForQuota.mockImplementation((ops: unknown[]) => ops);
    mocks.syncService.uploadOps.mockResolvedValue([
      { opId: 'op-1', accepted: true, serverSeq: 12 },
    ]);
    mocks.syncService.getOpsSinceWithSeq.mockResolvedValue({
      ops: [],
      latestSeq: 12,
      truncatedByBytes: true,
    });
    mocks.prisma.operation.findFirst.mockResolvedValue(null);
    mocks.prisma.operation.findMany.mockResolvedValue([]);

    app = Fastify();
    await app.register(syncRoutes, { prefix: '/api/sync' });
    await app.ready();
  });

  const upload = (requestId?: string) =>
    app.inject({
      method: 'POST',
      url: '/api/sync/ops',
      headers: { authorization: 'Bearer mock-token' },
      payload: {
        ops: [createOp()],
        clientId,
        lastKnownServerSeq: 5,
        ...(requestId ? { requestId } : {}),
      },
    });

  it('answers 200 with the upload accepted and more to download', async () => {
    const res = await upload();

    expect(res.statusCode).toBe(200);
    expect(res.json().results[0].accepted).toBe(true);
    expect(res.json().newOps).toBeUndefined();
    expect(res.json().hasMorePiggyback).toBe(true);
  });

  it('does the same on a retried request served from the dedup cache', async () => {
    mocks.syncService.checkOpsRequestDedup.mockReturnValue([
      { opId: 'op-1', accepted: true, serverSeq: 12 },
    ]);

    const res = await upload('retry-1');

    expect(res.statusCode).toBe(200);
    expect(res.json().hasMorePiggyback).toBe(true);
  });
});

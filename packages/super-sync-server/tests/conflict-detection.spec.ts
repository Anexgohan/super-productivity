import { describe, it, expect, beforeEach, vi } from 'vitest';
import { uuidv7 } from 'uuidv7';
import { Prisma } from '@prisma/client';
import { testState, resetTestState } from './sync.service.test-state';

// Mock the database module with Prisma mocks
vi.mock('../src/db', async () => {
  const {
    applyOperationSelect,
    hasOperationUniqueConflict,
    testState: state,
  } = await import('./sync.service.test-state');
  const { Prisma: PrismaModule } = await import('@prisma/client');

  const createTxMock = () => ({
    operation: {
      create: vi.fn().mockImplementation(async (args: any) => {
        if (state.operations.has(args.data.id)) {
          throw new PrismaModule.PrismaClientKnownRequestError(
            'Unique constraint failed',
            {
              code: 'P2002',
              clientVersion: '5.0.0',
            },
          );
        }
        state.serverSeqCounter++;
        const op = {
          ...args.data,
          serverSeq: state.serverSeqCounter,
          receivedAt: BigInt(Date.now()),
        };
        state.operations.set(args.data.id, op);
        return op;
      }),
      createMany: vi.fn().mockImplementation(async (args: any) => {
        const rows = Array.isArray(args.data) ? args.data : [args.data];
        let count = 0;

        for (const row of rows) {
          if (hasOperationUniqueConflict(state.operations, row)) {
            if (args.skipDuplicates) {
              continue;
            }
            throw new PrismaModule.PrismaClientKnownRequestError(
              'Unique constraint failed',
              { code: 'P2002', clientVersion: '5.0.0' },
            );
          }

          state.operations.set(row.id, {
            ...row,
            receivedAt: row.receivedAt ?? BigInt(Date.now()),
          });
          count++;
        }

        return { count };
      }),
      findFirst: vi.fn().mockImplementation(async (args: any) => {
        if (args.where?.id) {
          return (
            applyOperationSelect(state.operations.get(args.where.id), args.select) || null
          );
        }
        // Single-entity conflict lookup: where { userId, entityType,
        // OR: [{ entityId: X }, { entityIds: { has: X } }] } — match X as the
        // scalar entity_id OR a member of the entity_ids array (#8334).
        if (Array.isArray(args.where?.OR) && args.where?.entityType) {
          state.entityConflictFindFirstCount++;
          const scalarClause = args.where.OR.find((c: any) => 'entityId' in c);
          const hasClause = args.where.OR.find(
            (c: any) => c.entityIds?.has !== undefined,
          );
          const targetId = scalarClause?.entityId ?? hasClause?.entityIds?.has;
          const ops = Array.from(state.operations.values())
            .filter(
              (op: any) =>
                op.userId === args.where.userId &&
                op.entityType === args.where.entityType &&
                (op.entityId === targetId ||
                  (Array.isArray(op.entityIds) && op.entityIds.includes(targetId))),
            )
            .sort((a: any, b: any) => b.serverSeq - a.serverSeq);
          return applyOperationSelect(ops[0], args.select) || null;
        }
        // Scalar-only lookup (other callers): where { userId, entityType, entityId }.
        if (args.where?.entityId && args.where?.entityType) {
          state.entityConflictFindFirstCount++;
          const ops = Array.from(state.operations.values())
            .filter(
              (op: any) =>
                op.userId === args.where.userId &&
                op.entityId === args.where.entityId &&
                op.entityType === args.where.entityType &&
                (args.where.clientId?.not === undefined ||
                  op.clientId !== args.where.clientId.not),
            )
            .sort((a: any, b: any) => b.serverSeq - a.serverSeq);
          return applyOperationSelect(ops[0], args.select) || null;
        }
        return null;
      }),
      findMany: vi.fn().mockImplementation(async (args: any) => {
        const ops = Array.from(state.operations.values());
        return ops
          .filter((op: any) => {
            if (args.where?.userId !== undefined && args.where.userId !== op.userId)
              return false;
            if (
              args.where?.serverSeq?.gt !== undefined &&
              op.serverSeq <= args.where.serverSeq.gt
            )
              return false;
            if (args.where?.clientId?.not && op.clientId === args.where.clientId.not)
              return false;
            return true;
          })
          .sort((a: any, b: any) => a.serverSeq - b.serverSeq)
          .slice(0, args.take || 500);
      }),
      findUnique: vi.fn().mockImplementation(async (args: any) => {
        if (args.where?.id) {
          return (
            applyOperationSelect(state.operations.get(args.where.id), args.select) || null
          );
        }
        return null;
      }),
    },
    userSyncState: {
      findUnique: vi.fn().mockImplementation(async (args: any) => {
        return state.userSyncStates.get(args.where.userId) || null;
      }),
      upsert: vi.fn().mockImplementation(async (args: any) => {
        const existing = state.userSyncStates.get(args.where.userId);
        const result = existing
          ? { ...existing, ...args.update }
          : { userId: args.where.userId, ...args.create };
        state.userSyncStates.set(args.where.userId, result);
        return result;
      }),
      update: vi.fn().mockImplementation(async (args: any) => {
        const existing = state.userSyncStates.get(args.where.userId);
        if (existing) {
          const updated = { ...existing };
          for (const [key, value] of Object.entries(args.data)) {
            if (typeof value === 'object' && value !== null && 'increment' in value) {
              updated[key] =
                (existing[key] || 0) + (value as { increment: number }).increment;
            } else if (
              typeof value === 'object' &&
              value !== null &&
              'decrement' in value
            ) {
              updated[key] =
                (existing[key] || 0) - (value as { decrement: number }).decrement;
            } else {
              updated[key] = value;
            }
          }
          state.userSyncStates.set(args.where.userId, updated);
          return updated;
        }
        return null;
      }),
    },
    syncDevice: {
      upsert: vi.fn().mockImplementation(async (args: any) => {
        const key = `${args.where.userId_clientId.userId}:${args.where.userId_clientId.clientId}`;
        const result = {
          ...args.create,
          ...args.update,
          userId: args.where.userId_clientId.userId,
          clientId: args.where.userId_clientId.clientId,
        };
        state.syncDevices.set(key, result);
        return result;
      }),
    },
    user: {
      findUnique: vi.fn().mockImplementation(async (args: any) => {
        return state.users.get(args.where.id) || null;
      }),
    },
    // Upload transaction writes the storage counter atomically via $executeRaw.
    $executeRaw: vi.fn().mockResolvedValue(0),
    $queryRaw: vi.fn().mockImplementation(async (strings: any, ...params: unknown[]) => {
      const sql = Array.isArray(strings) ? strings.join('') : String(strings);
      // Full-state op uploads aggregate prior vector clocks via $queryRaw.
      if (sql.includes('jsonb_each_text(vector_clock)')) {
        const [txUserId, beforeServerSeq] = params as [number, number];
        const aggregate = new Map<string, number>();
        for (const op of state.operations.values()) {
          if ((op as any).userId !== txUserId) continue;
          if ((op as any).serverSeq >= beforeServerSeq) continue;
          const vc = (op as any).vectorClock;
          if (!vc || typeof vc !== 'object') continue;
          for (const [clientKey, rawVal] of Object.entries(
            vc as Record<string, unknown>,
          )) {
            if (typeof rawVal !== 'number' || !Number.isFinite(rawVal)) continue;
            const cur = aggregate.get(clientKey) ?? 0;
            if (rawVal > cur) aggregate.set(clientKey, rawVal);
          }
        }
        return Array.from(aggregate, ([client_id, max_counter]) => ({
          client_id,
          max_counter: BigInt(max_counter),
        }));
      }

      if (sql.includes('FROM user_sync_state') && sql.includes('FOR UPDATE')) {
        const [txUserId] = params as [number];
        return [{ lastSeq: state.userSyncStates.get(txUserId)?.lastSeq ?? 0 }];
      }

      const [userId, entityType, entityIdsSql] = params as [number, string, Prisma.Sql];
      state.batchConflictQueryCount++;
      if (!Array.isArray(entityIdsSql.values)) {
        throw new Error(
          'Expected batched conflict query entity IDs to be passed via Prisma.join(...)',
        );
      }
      const batchEntityIds = new Set(
        entityIdsSql.values.filter(
          (entityId): entityId is string => typeof entityId === 'string',
        ),
      );
      // An op covers every entity in its entity_ids set UNION its scalar
      // entity_id — mirrors the `entity_ids || ARRAY[entity_id]` unnest. The
      // scalar is always folded in (not just for empty/pre-migration rows) so a
      // divergent scalar entity_id is never missed; the Set below dedupes the
      // common entity_id = entityIds[0] overlap. (#8334)
      const coveredEntityIds = (op: any): string[] => {
        const ids = Array.isArray(op.entityIds) ? [...op.entityIds] : [];
        if (op.entityId != null) ids.push(op.entityId);
        return ids;
      };
      const latestByEntityId = new Map<string, any>();
      const ops = Array.from(state.operations.values())
        .filter((op: any) => op.userId === userId && op.entityType === entityType)
        .sort((a: any, b: any) => b.serverSeq - a.serverSeq);

      for (const op of ops) {
        for (const eid of coveredEntityIds(op)) {
          if (batchEntityIds.has(eid) && !latestByEntityId.has(eid)) {
            latestByEntityId.set(eid, op);
          }
        }
      }

      return Array.from(latestByEntityId.entries()).map(([eid, op]) => ({
        entityId: eid,
        clientId: op.clientId,
        vectorClock: op.vectorClock,
      }));
    }),
  });

  return {
    prisma: {
      $transaction: vi
        .fn()
        .mockImplementation(async (callback: any) => callback(createTxMock())),
      userSyncState: {
        findUnique: vi.fn().mockImplementation(async (args: any) => {
          return state.userSyncStates.get(args.where.userId) || null;
        }),
      },
      operation: {
        findMany: vi.fn().mockImplementation(async (args: any) => {
          const ops = Array.from(state.operations.values());
          return ops
            .filter((op: any) => {
              if (args.where?.userId !== undefined && args.where.userId !== op.userId)
                return false;
              if (
                args.where?.serverSeq?.gt !== undefined &&
                op.serverSeq <= args.where.serverSeq.gt
              )
                return false;
              if (args.where?.clientId?.not && op.clientId === args.where.clientId.not)
                return false;
              return true;
            })
            .sort((a: any, b: any) => a.serverSeq - b.serverSeq)
            .slice(0, args.take || 500);
        }),
        aggregate: vi.fn().mockImplementation(async (args: any) => {
          const ops = Array.from(state.operations.values()).filter(
            (op: any) => args.where?.userId === op.userId,
          );
          if (ops.length === 0) return { _max: { serverSeq: null } };
          const seqs = ops.map((op: any) => op.serverSeq);
          return { _max: { serverSeq: Math.max(...seqs) } };
        }),
        findUnique: vi.fn().mockImplementation(async (args: any) => {
          if (args.where?.id) {
            return state.operations.get(args.where.id) || null;
          }
          return null;
        }),
      },
    },
  };
});

import { initSyncService, getSyncService } from '../src/sync/sync.service';
import { OperationDownloadService } from '../src/sync/services/operation-download.service';
import { Operation, VectorClock, MAX_VECTOR_CLOCK_SIZE } from '../src/sync/sync.types';

describe('Conflict Detection', () => {
  const userId = 1;
  const clientA = 'client-a';
  const clientB = 'client-b';
  let operationDownloadService: OperationDownloadService;

  const createOp = (overrides: Partial<Operation> & { entityId: string }): Operation => ({
    id: uuidv7(),
    clientId: clientA,
    actionType: 'UPDATE_TASK',
    opType: 'UPD',
    entityType: 'TASK',
    payload: { title: 'Updated' },
    vectorClock: {},
    timestamp: Date.now(),
    schemaVersion: 1,
    ...overrides,
  });

  beforeEach(() => {
    resetTestState();

    // Add test user
    testState.users.set(userId, {
      id: userId,
      email: 'test@test.com',
      storageQuotaBytes: BigInt(100 * 1024 * 1024),
      storageUsedBytes: BigInt(0),
    });

    vi.clearAllMocks();
    initSyncService();
    operationDownloadService = new OperationDownloadService();
  });

  describe('Vector Clock Comparison', () => {
    it('should accept operation when incoming clock is GREATER_THAN existing', async () => {
      const service = getSyncService();
      const entityId = 'task-1';

      // First op from client A with clock {a: 1}
      const op1 = createOp({
        entityId,
        clientId: clientA,
        vectorClock: { [clientA]: 1 },
        opType: 'CRT',
      });
      const result1 = await service.uploadOps(userId, clientA, [op1]);
      expect(result1[0].accepted).toBe(true);

      // Second op from client A with clock {a: 2} - GREATER_THAN {a: 1}
      const op2 = createOp({
        entityId,
        clientId: clientA,
        vectorClock: { [clientA]: 2 },
      });
      const result2 = await service.uploadOps(userId, clientA, [op2]);
      expect(result2[0].accepted).toBe(true);
    });

    // anex fork, Stage 9: the server no longer refuses a change because another browser changed the same item. Every
    // valid change is stored in arrival order; browsers apply them in that order (the server_seq).
    it.each([
      ['older than the stored one (superseded)', { [clientA]: 1 }, { [clientA]: 2 }],
      ['concurrent with the stored one', { [clientB]: 1 }, { [clientA]: 1 }],
      [
        'equal to the stored one, from another client',
        { [clientA]: 1 },
        { [clientA]: 1 },
      ],
      ['empty, after an empty one from another client', {}, {}],
    ])(
      'should store an update whose clock is %s, numbered after it',
      async (_case, incomingClock, storedClock) => {
        const service = getSyncService();
        const entityId = 'task-1';

        const stored = await service.uploadOps(userId, clientA, [
          createOp({
            entityId,
            clientId: clientA,
            vectorClock: storedClock,
            opType: 'CRT',
          }),
        ]);
        expect(stored[0]).toMatchObject({ accepted: true, serverSeq: 1 });

        const result = await service.uploadOps(userId, clientB, [
          createOp({ entityId, clientId: clientB, vectorClock: incomingClock }),
        ]);
        expect(result[0]).toMatchObject({ accepted: true, serverSeq: 2 });
        expect(result[0].errorCode).toBeUndefined();
      },
    );

    it('should accept operation when clocks are EQUAL from same client (retry)', async () => {
      const service = getSyncService();
      const entityId = 'task-1';

      // First op
      const op1 = createOp({
        entityId,
        clientId: clientA,
        vectorClock: { [clientA]: 1 },
        opType: 'CRT',
      });
      const result1 = await service.uploadOps(userId, clientA, [op1]);
      expect(result1[0].accepted).toBe(true);

      // Second op with EQUAL clock from SAME client
      const op2 = createOp({
        entityId,
        clientId: clientA,
        vectorClock: { [clientA]: 1 },
      });
      const result2 = await service.uploadOps(userId, clientA, [op2]);
      expect(result2[0].accepted).toBe(true);
    });
  });

  describe('Conflict Bypass Rules', () => {
    it('should bypass conflict detection for SYNC_IMPORT operations', async () => {
      const service = getSyncService();
      const entityId = 'task-1';

      // First op
      const op1 = createOp({
        entityId,
        clientId: clientA,
        vectorClock: { [clientA]: 1 },
        opType: 'CRT',
      });
      await service.uploadOps(userId, clientA, [op1]);

      // SYNC_IMPORT with superseded clock should still be accepted
      const op2 = createOp({
        entityId,
        clientId: clientB,
        vectorClock: {},
        opType: 'SYNC_IMPORT',
        entityType: 'ALL',
      });
      const result = await service.uploadOps(userId, clientB, [op2]);
      expect(result[0].accepted).toBe(true);
    });

    it('should bypass conflict detection for BACKUP_IMPORT operations', async () => {
      const service = getSyncService();
      const entityId = 'task-1';

      // First op
      const op1 = createOp({
        entityId,
        clientId: clientA,
        vectorClock: { [clientA]: 1 },
        opType: 'CRT',
      });
      await service.uploadOps(userId, clientA, [op1]);

      // BACKUP_IMPORT with conflicting clock should still be accepted
      const op2 = createOp({
        entityId,
        clientId: clientB,
        vectorClock: { [clientB]: 1 },
        opType: 'BACKUP_IMPORT',
        entityType: 'ALL',
      });
      const result = await service.uploadOps(userId, clientB, [op2]);
      expect(result[0].accepted).toBe(true);
    });

    it('should bypass conflict detection for REPAIR operations', async () => {
      const service = getSyncService();
      const entityId = 'task-1';

      // First op
      const op1 = createOp({
        entityId,
        clientId: clientA,
        vectorClock: { [clientA]: 1 },
        opType: 'CRT',
      });
      await service.uploadOps(userId, clientA, [op1]);

      // A causal REPAIR with a current base should bypass vector-clock conflicts.
      const op2 = createOp({
        entityId,
        clientId: clientB,
        vectorClock: {},
        opType: 'REPAIR',
        entityType: 'RECOVERY',
        repairBaseServerSeq: 1,
      });
      const result = await service.uploadOps(userId, clientB, [op2], false, undefined, 1);
      expect(result[0].accepted).toBe(true);
    });

    it('should skip conflict detection when operation has bulk entityType ALL', async () => {
      const service = getSyncService();

      // First op on specific entity
      const op1 = createOp({
        entityId: 'task-1',
        clientId: clientA,
        vectorClock: { [clientA]: 1 },
        opType: 'CRT',
      });
      await service.uploadOps(userId, clientA, [op1]);

      // Bulk entityType 'ALL' should bypass conflict detection (no entityId required)
      const op2: Operation = {
        id: uuidv7(),
        clientId: clientB,
        actionType: 'BATCH_UPDATE',
        opType: 'BATCH',
        entityType: 'ALL', // Bulk entity types don't require entityId
        payload: { entities: {} },
        vectorClock: { [clientB]: 1 },
        timestamp: Date.now(),
        schemaVersion: 1,
      };
      const result = await service.uploadOps(userId, clientB, [op2]);
      expect(result[0].accepted).toBe(true);
    });
  });

  describe('Complex Vector Clock Scenarios', () => {
    it('should handle multi-device clock progression correctly', async () => {
      const service = getSyncService();
      const entityId = 'task-1';
      const clientC = 'client-c';

      // Client A creates with {a: 1}
      const op1 = createOp({
        entityId,
        clientId: clientA,
        vectorClock: { [clientA]: 1 },
        opType: 'CRT',
      });
      expect((await service.uploadOps(userId, clientA, [op1]))[0].accepted).toBe(true);

      // Client B updates knowing A's change: {a: 1, b: 1}
      const op2 = createOp({
        entityId,
        clientId: clientB,
        vectorClock: { [clientA]: 1, [clientB]: 1 },
      });
      expect((await service.uploadOps(userId, clientB, [op2]))[0].accepted).toBe(true);

      // Client C updates knowing both: {a: 1, b: 1, c: 1}
      const op3 = createOp({
        entityId,
        clientId: clientC,
        vectorClock: { [clientA]: 1, [clientB]: 1, [clientC]: 1 },
      });
      expect((await service.uploadOps(userId, clientC, [op3]))[0].accepted).toBe(true);

      // Client A tries to update with superseded clock {a: 2} (doesn't know about B, C)
      const op4 = createOp({
        entityId,
        clientId: clientA,
        vectorClock: { [clientA]: 2 },
      });
      // Stored after the others (Stage 9: no refusal; browsers apply it in this order).
      const result = await service.uploadOps(userId, clientA, [op4]);
      expect(result[0]).toMatchObject({ accepted: true, serverSeq: 4 });
    });

    it('should handle rapid sequential updates from same client', async () => {
      const service = getSyncService();
      const entityId = 'task-1';

      // Sequential updates from same client should all succeed
      for (let i = 1; i <= 10; i++) {
        const op = createOp({
          entityId,
          clientId: clientA,
          vectorClock: { [clientA]: i },
          opType: i === 1 ? 'CRT' : 'UPD',
        });
        const result = await service.uploadOps(userId, clientA, [op]);
        expect(result[0].accepted).toBe(true);
        expect(result[0].serverSeq).toBe(i);
      }
    });

    it('should store an update to a deleted entity after the delete', async () => {
      const service = getSyncService();
      const entityId = 'task-1';

      // Create
      const op1 = createOp({
        entityId,
        clientId: clientA,
        vectorClock: { [clientA]: 1 },
        opType: 'CRT',
      });
      await service.uploadOps(userId, clientA, [op1]);

      // Delete
      const op2 = createOp({
        entityId,
        clientId: clientA,
        vectorClock: { [clientA]: 2 },
        opType: 'DEL',
        payload: {},
      });
      await service.uploadOps(userId, clientA, [op2]);

      // Client B tries to update with concurrent clock (doesn't know about delete)
      const op3 = createOp({
        entityId,
        clientId: clientB,
        vectorClock: { [clientA]: 1, [clientB]: 1 },
      });
      // Stored after the delete; the browsers apply it there (an update to a deleted task changes nothing). A browser
      // that wants the task back sends a "bring it back" save (Stage 8).
      const result = await service.uploadOps(userId, clientB, [op3]);
      expect(result[0]).toMatchObject({ accepted: true, serverSeq: 3 });
    });
  });

  describe('Entity Type Isolation', () => {
    it('should not conflict operations on different entities of same type', async () => {
      const service = getSyncService();

      // Op on task-1
      const op1 = createOp({
        entityId: 'task-1',
        clientId: clientA,
        vectorClock: { [clientA]: 1 },
        opType: 'CRT',
      });
      await service.uploadOps(userId, clientA, [op1]);

      // Op on task-2 with same clock should succeed (different entity)
      const op2 = createOp({
        entityId: 'task-2',
        clientId: clientB,
        vectorClock: { [clientA]: 1 },
        opType: 'CRT',
      });
      const result = await service.uploadOps(userId, clientB, [op2]);
      expect(result[0].accepted).toBe(true);
    });

    it('should not conflict operations on different entity types with same ID', async () => {
      const service = getSyncService();
      const entityId = 'entity-1';

      // Create a TASK with this ID
      const op1 = createOp({
        entityId,
        entityType: 'TASK',
        clientId: clientA,
        vectorClock: { [clientA]: 1 },
        opType: 'CRT',
      });
      await service.uploadOps(userId, clientA, [op1]);

      // Create a PROJECT with same ID and concurrent clock should succeed
      const op2 = createOp({
        entityId,
        entityType: 'PROJECT',
        clientId: clientB,
        vectorClock: { [clientB]: 1 },
        opType: 'CRT',
      });
      const result = await service.uploadOps(userId, clientB, [op2]);
      expect(result[0].accepted).toBe(true);
    });
  });

  describe('User Isolation', () => {
    it('should not conflict operations from different users', async () => {
      const service = getSyncService();
      const entityId = 'task-1';
      const userId2 = 2;

      // Create second user
      testState.users.set(userId2, {
        id: userId2,
        email: 'test2@test.com',
        storageQuotaBytes: BigInt(100 * 1024 * 1024),
        storageUsedBytes: BigInt(0),
      });

      // User 1 creates task
      const op1 = createOp({
        entityId,
        clientId: clientA,
        vectorClock: { [clientA]: 1 },
        opType: 'CRT',
      });
      await service.uploadOps(userId, clientA, [op1]);

      // User 2 creates task with same ID - should succeed (different user)
      const op2 = createOp({
        entityId,
        clientId: clientB,
        vectorClock: { [clientB]: 1 },
        opType: 'CRT',
      });
      const result = await service.uploadOps(userId2, clientB, [op2]);
      expect(result[0].accepted).toBe(true);
    });
  });

  describe('Edge Cases', () => {
    it('should handle oversized vector clocks by pruning to MAX_VECTOR_CLOCK_SIZE before storage', async () => {
      const service = getSyncService();
      const entityId = 'task-1';

      // Create clock with entries above MAX_VECTOR_CLOCK_SIZE but within sanitize limit.
      // This simulates conflict resolution where the client merges all entity clock IDs
      // plus its own ID, resulting in MAX+N entries.
      const entryCount = MAX_VECTOR_CLOCK_SIZE + 10;
      const largeClock: VectorClock = {};
      for (let i = 0; i < entryCount; i++) {
        largeClock[`client-${i}`] = i + 1;
      }

      const op1 = createOp({
        entityId,
        clientId: clientA,
        vectorClock: largeClock,
        opType: 'CRT',
      });
      const result = await service.uploadOps(userId, clientA, [op1]);
      expect(result[0].accepted).toBe(true);

      // Verify the clock was pruned to MAX_VECTOR_CLOCK_SIZE (20) before storage.
      // clientA ('client-a') is not in the clock, so only the MAX most active
      // clients are kept (the ones with highest counters).
      const ops = (await operationDownloadService.getOpsSinceWithSeq(userId, 0)).ops;
      const storedClock = ops[0].op.vectorClock;
      expect(Object.keys(storedClock).length).toBe(MAX_VECTOR_CLOCK_SIZE);
      // The most active clients should be preserved (top MAX entries by counter)
      for (let i = entryCount - MAX_VECTOR_CLOCK_SIZE; i < entryCount; i++) {
        expect(storedClock[`client-${i}`]).toBe(i + 1);
      }
    });

    it('should preserve uploading client ID during server-side clock pruning', async () => {
      const service = getSyncService();
      const entityId = 'task-1';

      // Create clock with entries above MAX where the uploading client (clientA) IS in the clock
      // but has a low counter value that would normally be pruned
      const largeClock: VectorClock = { [clientA]: 2 }; // Low counter
      for (let i = 0; i < MAX_VECTOR_CLOCK_SIZE + 10; i++) {
        largeClock[`client-${i}`] = 100 + i; // All have higher counters
      }

      const op = createOp({
        entityId,
        clientId: clientA,
        vectorClock: largeClock,
        opType: 'CRT',
      });
      const result = await service.uploadOps(userId, clientA, [op]);
      expect(result[0].accepted).toBe(true);

      // Verify the clock was pruned to MAX_VECTOR_CLOCK_SIZE
      const ops = (await operationDownloadService.getOpsSinceWithSeq(userId, 0)).ops;
      const storedClock = ops[0].op.vectorClock;
      expect(Object.keys(storedClock).length).toBe(MAX_VECTOR_CLOCK_SIZE);
      // clientA should be preserved despite having the lowest counter
      expect(storedClock[clientA]).toBe(2);
    });

    it('should accept MAX+1 entry clock as GREATER_THAN when it dominates a MAX entry entity clock (regression: infinite loop fix)', async () => {
      // This is the core regression test for the infinite sync loop bug.
      // Scenario: entity has MAX_VECTOR_CLOCK_SIZE (20) entries in its stored clock.
      // A client resolves the conflict by merging all entity clock IDs + its own ID,
      // producing MAX+1 entries. The server must compare BEFORE pruning,
      // so the MAX+1-entry clock is seen as GREATER_THAN the MAX-entry stored clock.
      // If the server pruned before comparison, the MAX+1-entry clock would lose one
      // entity key, and comparison could return CONCURRENT → infinite loop.
      const service = getSyncService();
      const entityId = 'task-regression';

      // Step 1: Create an entity with a clock that has exactly MAX entries
      const entityClock: VectorClock = {};
      for (let i = 0; i < MAX_VECTOR_CLOCK_SIZE; i++) {
        entityClock[`entity-client-${i}`] = i + 1;
      }
      const initialOp = createOp({
        entityId,
        clientId: 'entity-client-0',
        vectorClock: entityClock,
        opType: 'CRT',
      });
      const initialResult = await service.uploadOps(userId, 'entity-client-0', [
        initialOp,
      ]);
      expect(initialResult[0].accepted).toBe(true);

      // Step 2: clientA resolves conflict by merging entity clock + its own ID → MAX+1 entries.
      // clientA is NOT one of the entity-client-* IDs.
      const resolvedClock: VectorClock = {};
      for (let i = 0; i < MAX_VECTOR_CLOCK_SIZE; i++) {
        // Same keys as entity clock, but with incremented values → dominates entity clock
        resolvedClock[`entity-client-${i}`] = i + 2;
      }
      resolvedClock[clientA] = 1; // clientA's own entry → MAX+1 total entries

      const resolvedOp = createOp({
        entityId,
        clientId: clientA,
        vectorClock: resolvedClock,
      });
      const resolvedResult = await service.uploadOps(userId, clientA, [resolvedOp]);

      // The server must accept this as GREATER_THAN (not reject as CONCURRENT)
      expect(resolvedResult[0].accepted).toBe(true);

      // Verify the stored clock was pruned to MAX after acceptance
      const ops = (await operationDownloadService.getOpsSinceWithSeq(userId, 0)).ops;
      const latestOp = ops.find((o: any) => o.op.id === resolvedOp.id);
      expect(latestOp).toBeDefined();
      const storedClock = latestOp!.op.vectorClock;
      expect(Object.keys(storedClock).length).toBe(MAX_VECTOR_CLOCK_SIZE);
      // clientA should be preserved (it's the uploading client)
      expect(storedClock[clientA]).toBe(1);
    });

    it('should handle first operation on entity (no existing op to conflict with)', async () => {
      const service = getSyncService();

      // First ever operation - no conflict possible
      const op = createOp({
        entityId: 'brand-new-task',
        clientId: clientA,
        vectorClock: { [clientA]: 1 },
        opType: 'CRT',
      });
      const result = await service.uploadOps(userId, clientA, [op]);
      expect(result[0].accepted).toBe(true);
    });
  });
});

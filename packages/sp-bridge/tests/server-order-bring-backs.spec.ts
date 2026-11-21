/**
 * Which deleted tasks a download brings back, decided by the app's own ServerOrderService from source with a fake change log and server.
 */
import '@angular/compiler';
import '../app-rules/globals';
import { Injector, ɵINJECTOR_SCOPE as INJECTOR_SCOPE } from '@angular/core';
import { Store } from '@ngrx/store';
import { of, type OperatorFunction } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { ServerOrderService } from '../../../src/app/op-log/sync/server-order.service';
import { OperationLogStoreService } from '../../../src/app/op-log/persistence/operation-log-store.service';
import { SyncProviderManager } from '../../../src/app/op-log/sync-providers/provider-manager.service';
import { SyncProviderId } from '../../../src/app/op-log/sync-providers/provider.const';
import { CLIENT_ID_PROVIDER } from '../../../src/app/op-log/util/client-id.provider';
import { ConflictResolutionService } from '../../../src/app/op-log/sync/conflict-resolution.service';
import { TaskTimeSyncService } from '../../../src/app/features/tasks/task-time-sync.service';
import { OperationCaptureService } from '../../../src/app/op-log/capture/operation-capture.service';
import { SimpleCounterService } from '../../../src/app/features/simple-counter/simple-counter.service';
import type { Operation } from '../../../src/app/op-log/core/operation.types';

vi.mock(
  '@sp/sync-providers/provider-types',
  () => import('../../sync-providers/src/provider-types'),
);
// Their modules load the app's UI, which needs a browser; fakes are provided below where the service reaches them.
vi.mock('../../../src/app/op-log/sync/operation-log-download.service', () => ({
  OperationLogDownloadService: class {},
}));
vi.mock('../../../src/app/op-log/sync/conflict-resolution.service', () => ({
  ConflictResolutionService: class {},
}));
vi.mock('../../../src/app/op-log/sync-providers/wrapped-provider.service', () => ({
  WrappedProviderService: class {},
}));
vi.mock('../../../src/app/op-log/capture/operation-capture.service', () => ({
  OperationCaptureService: class {},
}));
vi.mock('../../../src/app/op-log/apply/operation-applier.service', () => ({
  OperationApplierService: class {},
}));
vi.mock('../../../src/app/features/tasks/task-time-sync.service', () => ({
  TaskTimeSyncService: class {},
}));
vi.mock('../../../src/app/features/simple-counter/simple-counter.service', () => ({
  SimpleCounterService: class {},
}));
vi.mock('../../../src/app/op-log/persistence/operation-log-store.service', () => ({
  OperationLogStoreService: class {},
}));
vi.mock('../../../src/app/op-log/sync-providers/provider-manager.service', () => ({
  SyncProviderManager: class {},
}));

const A = 'B_browserA';
const B = 'B_browserB';

const op = (fields: { id: string } & Record<string, unknown>): Operation =>
  ({
    clientId: B,
    actionType: '[Task Shared] updateTask',
    opType: 'UPD',
    entityType: 'TASK',
    entityId: 't1',
    payload: { actionPayload: {}, entityChanges: [] },
    vectorClock: { [B]: 1 },
    timestamp: 0,
    schemaVersion: 4,
    ...fields,
  }) as unknown as Operation;

const task = (id: string, title: string): Record<string, unknown> => ({
  id,
  title,
  subTaskIds: [],
  tagIds: [],
  projectId: 'INBOX_PROJECT',
});

const tasksOf = (...tasks: Record<string, unknown>[]): Record<string, unknown> => ({
  ids: tasks.map((t) => t.id),
  entities: Object.fromEntries(tasks.map((t) => [t.id, t])),
});

const editBy = (
  clientId: string,
  id: string,
  entityId: string,
  timestamp: number,
): Operation => op({ id, clientId, entityId, timestamp });
const deleteOf = (id: string, entityId: string, timestamp: number): Operation =>
  op({ id, actionType: '[Task Shared] deleteTask', opType: 'DEL', entityId, timestamp });
const restoreOf = (id: string, entityId: string, timestamp: number): Operation =>
  op({ id, actionType: '[Task Shared] restoreDeletedTask', entityId, timestamp });
const checkpointWith = (tasks: Record<string, unknown>): Operation =>
  op({
    id: 'checkpoint',
    actionType: '[SP_ALL] Load(import) all data',
    opType: 'REPAIR',
    entityType: 'ALL',
    entityId: undefined,
    payload: { appDataComplete: { task: tasks, note: { ids: [], entities: {} } } },
    repairBaseServerSeq: 49,
  });

/** The service over a browser showing `shown`, whose change log holds `own` (all unsent unless `sent` names them). */
const serviceWith = ({
  shown,
  own,
  sent = [],
  deleteTimes = [],
}: {
  shown: Record<string, unknown>;
  own: Operation[];
  sent?: string[];
  deleteTimes?: { entityType: string; entityId: string; deletedAt: number }[];
}): { service: ServerOrderService; rejected: string[] } => {
  const rejected: string[] = [];
  const provider = {
    id: SyncProviderId.SuperSync,
    getDeleteTimes: async () => deleteTimes,
  };
  const entries = (): { op: Operation; source: string }[] =>
    own.filter((o) => !rejected.includes(o.id)).map((o) => ({ op: o, source: 'local' }));
  const injector = Injector.create({
    providers: [
      { provide: INJECTOR_SCOPE, useValue: 'root' },
      {
        provide: Store,
        useValue: {
          pipe: (take: OperatorFunction<unknown, unknown>) =>
            of({ tasks: shown }).pipe(take),
        },
      },
      {
        provide: OperationLogStoreService,
        useValue: {
          getUnsynced: async () => entries().filter((e) => !sent.includes(e.op.id)),
          getOpsAfterSeq: async () => entries(),
          hasOp: async () => false,
          markRejected: async (ids: string[]) => rejected.push(...ids),
          getVectorClock: async () => ({ [A]: 5 }),
        },
      },
      {
        provide: SyncProviderManager,
        useValue: { syncEpoch: 0, getActiveProvider: () => provider },
      },
      { provide: CLIENT_ID_PROVIDER, useValue: { loadClientId: async () => A } },
      {
        provide: ConflictResolutionService,
        useValue: {
          mergeAndIncrementClocks: () => ({ [A]: 6 }),
          createLWWUpdateOp: (
            entityType: string,
            entityId: string,
            entity: unknown,
            clientId: string,
            vectorClock: Record<string, number>,
            timestamp: number,
          ) =>
            op({
              id: `save-${entityId}`,
              clientId,
              actionType: `[${entityType}] LWW Update`,
              entityType,
              entityId,
              payload: entity,
              vectorClock,
              timestamp,
            }),
        },
      },
      { provide: TaskTimeSyncService, useValue: { getPendingEntries: () => [] } },
      {
        provide: OperationCaptureService,
        useValue: { getPendingTaskTimeEntries: () => [] },
      },
      {
        provide: SimpleCounterService,
        useValue: { getPendingStopwatchEntries: () => [] },
      },
    ],
  });
  return { service: injector.get(ServerOrderService), rejected };
};

describe('a checkpoint download with deletes after the checkpoint', () => {
  it('brings back a task the checkpoint holds and a later change of the same download deletes, when this browser edited it later', async () => {
    const { service } = serviceWith({
      shown: tasksOf(task('t2', 'edited by A')),
      own: [editBy(A, 'a-edit', 't2', 200)],
    });

    const { saves, missingKeys } = await service.decideCheckpointBringBacks([
      checkpointWith(tasksOf(task('t2', 'old'))),
      deleteOf('b-delete', 't2', 100),
    ]);

    expect(saves.map((save) => save.entityId)).toEqual(['t2']);
    expect(saves[0].timestamp).toBe(200);
    expect([...missingKeys]).toEqual(['TASK:t2']);
  });

  it('withdraws an unsent recreation that a delete after the checkpoint beats', async () => {
    const recreation = op({
      id: 'a-recreation',
      clientId: A,
      actionType: '[TASK] LWW Update',
      entityId: 't2',
      timestamp: 100,
    });
    const { service, rejected } = serviceWith({
      shown: tasksOf(task('t2', 'brought back by A')),
      own: [recreation],
    });

    const { saves } = await service.decideCheckpointBringBacks([
      checkpointWith(tasksOf(task('t2', 'brought back by A'))),
      deleteOf('b-delete', 't2', 200),
    ]);

    expect(saves).toEqual([]);
    expect(rejected).toEqual(['a-recreation']);
  });

  it('brings nothing back for a task the checkpoint lacks when a later change of the same download restores it', async () => {
    const { service } = serviceWith({
      shown: tasksOf(task('t1', 'edited by A')),
      own: [editBy(A, 'a-edit', 't1', 120)],
      deleteTimes: [{ entityType: 'TASK', entityId: 't1', deletedAt: 100 }],
    });

    const { saves } = await service.decideCheckpointBringBacks([
      checkpointWith(tasksOf()),
      restoreOf('c-restore', 't1', 150),
    ]);

    expect(saves).toEqual([]);
  });
  it('asks about a task the checkpoint lacks that this browser edited only through a change naming several tasks', async () => {
    const bulkEdit = op({
      id: 'a-bulk-edit',
      clientId: A,
      actionType: '[Task Shared] updateTasks',
      entityId: undefined,
      entityIds: ['t0', 't1'],
      timestamp: 120,
    });
    const { service } = serviceWith({
      shown: tasksOf(task('t1', 'edited by A')),
      own: [bulkEdit],
      deleteTimes: [{ entityType: 'TASK', entityId: 't1', deletedAt: 100 }],
    });

    const { saves } = await service.decideCheckpointBringBacks([
      checkpointWith(tasksOf()),
    ]);

    expect(saves.map((save) => save.entityId)).toEqual(['t1']);
  });
});

describe('a download that deletes a task and restores it again', () => {
  it('brings nothing back over the restored task, although this browser edited it after the delete', async () => {
    const { service } = serviceWith({
      shown: tasksOf(task('t1', 'edited by A')),
      own: [editBy(A, 'a-edit', 't1', 120)],
    });

    const saves = await service.decideBringBacks([
      deleteOf('b-delete', 't1', 100),
      restoreOf('c-restore', 't1', 150),
      editBy('B_browserC', 'c-edit', 't1', 200),
    ]);

    expect(saves).toEqual([]);
  });

  it('still brings back a task deleted after a restore in the same download', async () => {
    const { service } = serviceWith({
      shown: tasksOf(task('t1', 'edited by A')),
      own: [editBy(A, 'a-edit', 't1', 300)],
    });

    const saves = await service.decideBringBacks([
      restoreOf('c-restore', 't1', 150),
      deleteOf('b-delete', 't1', 200),
    ]);

    expect(saves.map((save) => save.entityId)).toEqual(['t1']);
  });
});

describe('a save of this browser numbered past the confirmed state that it cannot place', () => {
  it('rebuilds instead of replaying without it', async () => {
    const { service } = serviceWith({ shown: tasksOf(task('t1', 'shown')), own: [] });
    const first = op({ id: 'b-first' });
    service.recordServerSeqs([{ serverSeq: 9, op: first }]);
    await service.commitInOrder(
      { plan: { kind: 'in-order', confirmedSeq: 9 }, downloaded: [] },
      false,
    );
    const next = op({ id: 'b-next' });
    service.recordServerSeqs([{ serverSeq: 10, op: next }]);
    // Another tab of this browser saved at 11, so this tab never got the answer.
    service.recordOwnLatestSeq(11);

    const { plan } = await service.prepare([next], [next]);

    expect(plan.kind).toBe('rebuild');
  });
});

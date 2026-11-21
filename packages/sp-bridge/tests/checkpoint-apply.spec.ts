/**
 * A checkpoint applied in a browser: the app's own RemoteOpsProcessingService and replay meta-reducer from source, with a fake change log.
 */
import '@angular/compiler';
import '../app-rules/globals';
import { Injector, ɵINJECTOR_SCOPE as INJECTOR_SCOPE } from '@angular/core';
import { Store, type Action } from '@ngrx/store';
import { of, type OperatorFunction } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRootReducer } from '../app-rules/root-reducer';
import { buildTaskEntity } from '../src/op-factory';
import { bulkApplyOperations } from '../../../src/app/op-log/apply/bulk-hydration.action';
import {
  reapplyEditsReplacedByCheckpoint,
  setUnsavedLocalTimeSource,
} from '../../../src/app/op-log/apply/server-order-replay.meta-reducer';
import { NO_UNSAVED_LOCAL_TIME } from '../../../src/app/op-log/apply/server-order-local-state.util';
import {
  bufferDeferredAction,
  clearDeferredActions,
} from '../../../src/app/op-log/capture/operation-capture.meta-reducer';
import { convertOpToAction } from '../../../src/app/op-log/apply/operation-converter.util';
import { RemoteOpsProcessingService } from '../../../src/app/op-log/sync/remote-ops-processing.service';
import { ServerOrderService } from '../../../src/app/op-log/sync/server-order.service';
import { OperationLogStoreService } from '../../../src/app/op-log/persistence/operation-log-store.service';
import { OperationLogSnapshotService } from '../../../src/app/op-log/persistence/operation-log-snapshot.service';
import { OperationApplierService } from '../../../src/app/op-log/apply/operation-applier.service';
import { SchemaMigrationService } from '../../../src/app/op-log/persistence/schema-migration.service';
import { SyncImportFilterService } from '../../../src/app/op-log/sync/sync-import-filter.service';
import { LockService } from '../../../src/app/op-log/sync/lock.service';
import { LOCK_NAMES } from '../../../src/app/op-log/core/operation-log.const';
import { OperationWriteFlushService } from '../../../src/app/op-log/sync/operation-write-flush.service';
import { HydrationStateService } from '../../../src/app/op-log/apply/hydration-state.service';
import { SyncProviderManager } from '../../../src/app/op-log/sync-providers/provider-manager.service';
import { SnackService } from '../../../src/app/core/snack/snack.service';
import { CLIENT_ID_PROVIDER } from '../../../src/app/op-log/util/client-id.provider';
import { ConflictResolutionService } from '../../../src/app/op-log/sync/conflict-resolution.service';
import { ValidateStateService } from '../../../src/app/op-log/validation/validate-state.service';
import { SyncSessionValidationService } from '../../../src/app/op-log/sync/sync-session-validation.service';
import { VectorClockService } from '../../../src/app/op-log/sync/vector-clock.service';
import { OperationLogCompactionService } from '../../../src/app/op-log/persistence/operation-log-compaction.service';
import { UnsentEditOnTopService } from '../../../src/app/op-log/sync/unsent-edit-on-top.service';
import { withUnsentEditsAfterCheckpoint } from '../../../src/app/op-log/persistence/unsent-after-checkpoint.util';
import type {
  Operation,
  OperationLogEntry,
} from '../../../src/app/op-log/core/operation.types';
import type { PersistentAction } from '../../../src/app/op-log/core/persistent-action.interface';

vi.mock(
  '@sp/sync-providers/provider-types',
  () => import('../../sync-providers/src/provider-types'),
);
vi.mock('../../../src/app/op-log/sync/process-deferred-actions-flush.util', () => ({
  processDeferredActionsAfterRemoteApply: async () => undefined,
}));
vi.mock('../../../src/app/op-log/persistence/schema-migration.service', () => ({
  SchemaMigrationService: class {},
  MIN_SUPPORTED_SCHEMA_VERSION: 1,
  getOperationSchemaVersion: (op: { schemaVersion: number }) => op.schemaVersion,
}));
// Their modules load the app's UI, which needs a browser; fakes are provided below where the services reach them.
vi.mock('../../../src/app/op-log/persistence/operation-log-store.service', () => ({
  OperationLogStoreService: class {},
}));
vi.mock('../../../src/app/op-log/persistence/operation-log-snapshot.service', () => ({
  OperationLogSnapshotService: class {},
}));
vi.mock('../../../src/app/op-log/persistence/operation-log-compaction.service', () => ({
  OperationLogCompactionService: class {},
}));
vi.mock('../../../src/app/op-log/apply/operation-applier.service', () => ({
  OperationApplierService: class {},
}));
vi.mock('../../../src/app/op-log/apply/hydration-state.service', () => ({
  HydrationStateService: class {},
}));
vi.mock('../../../src/app/op-log/sync/conflict-resolution.service', () => ({
  ConflictResolutionService: class {},
}));
vi.mock('../../../src/app/op-log/sync/unsent-edit-on-top.service', () => ({
  UnsentEditOnTopService: class {},
}));
vi.mock('../../../src/app/op-log/sync/sync-session-validation.service', () => ({
  SyncSessionValidationService: class {},
}));
vi.mock('../../../src/app/op-log/sync/vector-clock.service', () => ({
  VectorClockService: class {},
}));
vi.mock('../../../src/app/op-log/sync/lock.service', () => ({ LockService: class {} }));
vi.mock('../../../src/app/op-log/sync/sync-import-filter.service', () => ({
  SyncImportFilterService: class {},
}));
vi.mock('../../../src/app/op-log/sync/operation-write-flush.service', () => ({
  OperationWriteFlushService: class {},
}));
vi.mock('../../../src/app/op-log/sync/operation-log-download.service', () => ({
  OperationLogDownloadService: class {},
}));
vi.mock('../../../src/app/op-log/sync-providers/wrapped-provider.service', () => ({
  WrappedProviderService: class {},
}));
vi.mock('../../../src/app/op-log/sync-providers/provider-manager.service', () => ({
  SyncProviderManager: class {},
}));
vi.mock('../../../src/app/op-log/validation/validate-state.service', () => ({
  ValidateStateService: class {},
}));
vi.mock('../../../src/app/op-log/capture/operation-capture.service', () => ({
  OperationCaptureService: class {},
}));
vi.mock('../../../src/app/features/tasks/task-time-sync.service', () => ({
  TaskTimeSyncService: class {},
}));
vi.mock('../../../src/app/features/simple-counter/simple-counter.service', () => ({
  SimpleCounterService: class {},
}));
vi.mock('../../../src/app/core/snack/snack.service', () => ({ SnackService: class {} }));

type State = Record<string, unknown>;
const A = 'B_browserA';
const B = 'B_browserB';
const root = buildRootReducer() as (state: State | undefined, action: Action) => State;

let opCount = 0;
const makeOp = (
  clientId: string,
  actionType: string,
  opType: string,
  entityId: string,
  actionPayload: Record<string, unknown>,
): Operation =>
  ({
    id: `op-${++opCount}`,
    clientId,
    actionType,
    opType,
    entityType: 'TASK',
    entityId,
    payload: { actionPayload, entityChanges: [] },
    vectorClock: { [clientId]: opCount },
    timestamp: 1_790_000_000_000 + opCount,
    schemaVersion: 4,
  }) as unknown as Operation;

const rename = (clientId: string, title: string): Operation =>
  makeOp(clientId, '[Task Shared] updateTask', 'UPD', 't1', {
    task: { id: 't1', changes: { title } },
  });

const apply = (state: State | undefined, ops: Operation[], localClientId = A): State =>
  root(state, bulkApplyOperations({ operations: ops, localClientId }));

const titleOf = (state: State): string =>
  (state.tasks as { entities: Record<string, { title: string }> }).entities.t1.title;

const start = (): State =>
  apply(
    root(undefined, { type: '@@init' }),
    [
      makeOp(B, '[Task Shared] addTask', 'CRT', 't1', {
        task: { ...buildTaskEntity({ title: 'one' }), id: 't1' },
        workContextId: 'INBOX_PROJECT',
        workContextType: 'PROJECT',
        isAddToBacklog: false,
        isAddToBottom: false,
      }),
    ],
    B,
  );

const checkpointOf = (state: State, id = 'checkpoint'): Operation =>
  ({
    ...makeOp(B, '[SP_ALL] Load(import) all data', 'REPAIR', 'ALL', {}),
    id,
    entityType: 'ALL',
    entityId: undefined,
    payload: { appDataComplete: { task: state.tasks, project: state.projects } },
    repairBaseServerSeq: 7,
  }) as unknown as Operation;

/** Dispatched by the user while the checkpoint applies: shown at once, saved after the apply. */
const typeDuringApply = (state: State, edit: Operation): State => {
  const action = convertOpToAction(edit) as PersistentAction;
  const localAction = {
    ...action,
    meta: { ...action.meta, isRemote: false },
  } as PersistentAction;
  bufferDeferredAction(localAction);
  return root(state, localAction);
};

afterEach(() => {
  setUnsavedLocalTimeSource(() => NO_UNSAVED_LOCAL_TIME);
  clearDeferredActions();
});

describe('edits typed while a checkpoint applies', () => {
  it('stay on top of the unsent edits put back after the checkpoint, typed before or after its reducer ran', () => {
    const base = start();
    const unsent = rename(A, 'unsent before the checkpoint');
    const beforeReducer = typeDuringApply(apply(base, [unsent]), rename(A, 'A'));
    const fromCheckpoint = root(
      beforeReducer,
      bulkApplyOperations({
        operations: [checkpointOf(base)],
        localClientId: A,
        keepsLocalOnlyState: true,
      }),
    );
    const afterReducer = typeDuringApply(fromCheckpoint, rename(A, 'AB'));
    const withUnsent = apply(afterReducer, [unsent]);

    const after = root(withUnsent, reapplyEditsReplacedByCheckpoint({ onTop: [unsent] }));

    expect(titleOf(after)).toBe('AB');
  });
});

/** The services over a fake change log that records each write and apply in order. */
const checkpointHarness = (
  saves: Operation[],
  unsent: Operation[],
  ownServerSeqs: Record<string, number> = {},
): {
  service: RemoteOpsProcessingService;
  events: string[];
  dispatched: Action[];
  order: string[];
} => {
  const events: string[] = [];
  // The server lookups and the locks, in the order they happen.
  const order: string[] = [];
  const dispatched: Action[] = [];
  const ids = (ops: readonly Operation[]): string => ops.map((o) => o.id).join(',');
  let seq = 0;
  const opLogStore = {
    appendBatchSkipDuplicates: async (ops: Operation[], source: string) => {
      events.push(`write ${source} ${ids(ops)}`);
      return { seqs: ops.map(() => ++seq), writtenOps: ops, skippedCount: 0 };
    },
    appendMixedSourceBatchSkipDuplicates: async (
      batches: {
        ops: Operation[];
        source: string;
        options?: { unsentOnTopOpIds?: readonly string[] };
      }[],
    ) => {
      const onTop = (b: (typeof batches)[number]): string =>
        b.options?.unsentOnTopOpIds ? ` (on top: ${b.options.unsentOnTopOpIds})` : '';
      events.push(
        `write ${batches.map((b) => `${b.source} ${ids(b.ops)}${onTop(b)}`).join(' + ')}`,
      );
      const written = batches.flatMap((b) =>
        b.ops.map((o) => ({ seq: ++seq, op: o, source: b.source })),
      );
      return { written, skippedCount: 0 };
    },
    mergeRemoteOpClocks: async () => undefined,
    markReducersCommittedAndMergeClocks: async () => undefined,
    markApplied: async () => undefined,
    markFailed: async () => undefined,
    clearFullStateOpsExcept: async () => 0,
    getUnsynced: async () => unsent.map((o) => ({ op: o, source: 'local' })),
  };
  const applier = {
    applyOperations: async (
      ops: Operation[],
      options: {
        onReducersCommitted?: (ops: Operation[], failures: never[]) => Promise<void>;
      } = {},
    ) => {
      events.push(`apply ${ids(ops)}`);
      await options.onReducersCommitted?.(ops, []);
      return { appliedOps: ops };
    },
  };
  const injector = Injector.create({
    providers: [
      { provide: INJECTOR_SCOPE, useValue: 'root' },
      {
        provide: Store,
        useValue: {
          dispatch: (action: Action) => dispatched.push(action),
          pipe: (take: OperatorFunction<unknown, unknown>) => of({}).pipe(take),
        },
      },
      { provide: OperationLogStoreService, useValue: opLogStore },
      { provide: OperationApplierService, useValue: applier },
      {
        provide: OperationLogSnapshotService,
        useValue: { saveCurrentStateAsSnapshot: async () => undefined },
      },
      {
        provide: SchemaMigrationService,
        useValue: { getCurrentVersion: () => 4, migrateOperation: (o: Operation) => o },
      },
      {
        provide: SyncImportFilterService,
        useValue: {
          filterOpsInvalidatedBySyncImport: async (ops: Operation[]) => ({
            validOps: ops,
            invalidatedOps: [],
            isLocalUnsyncedImport: false,
          }),
        },
      },
      {
        provide: LockService,
        useValue: {
          request: (name: string, run: () => unknown) => {
            order.push(name === LOCK_NAMES.UPLOAD ? 'lock the upload' : `lock ${name}`);
            return run();
          },
        },
      },
      {
        provide: OperationWriteFlushService,
        useValue: { flushThenRunExclusive: (run: () => unknown) => run() },
      },
      {
        provide: HydrationStateService,
        useValue: { acquireApplyingRemoteOpsHold: () => () => undefined },
      },
      {
        provide: SyncProviderManager,
        useValue: {
          syncEpoch: 0,
          getActiveProvider: () => undefined,
          assertSyncEpochUnchanged: () => undefined,
        },
      },
      { provide: SnackService, useValue: { open: () => undefined } },
      { provide: CLIENT_ID_PROVIDER, useValue: { loadClientId: async () => A } },
      // Not reached by a checkpoint apply.
      ...[
        ConflictResolutionService,
        ValidateStateService,
        SyncSessionValidationService,
        VectorClockService,
        OperationLogCompactionService,
        UnsentEditOnTopService,
      ].map((token) => ({ provide: token, useValue: {} })),
    ],
  });
  const serverOrder = injector.get(ServerOrderService);
  vi.spyOn(serverOrder, 'ownServerSeq').mockImplementation((id) => ownServerSeqs[id]);
  const lookups = { notStored: new Set<string>(), deleteTimes: new Map() };
  vi.spyOn(serverOrder, 'askBeforeLocks').mockImplementation(async () => {
    order.push('ask the server');
    return lookups;
  });
  vi.spyOn(serverOrder, 'learnUnsentServerSeqs').mockImplementation(async (answers) => {
    order.push(answers === lookups ? 'learn with the answers' : 'learn');
  });
  vi.spyOn(serverOrder, 'decideCheckpointBringBacks').mockImplementation(
    async (_ops, answers) => {
      order.push(answers === lookups ? 'decide with the answers' : 'decide');
      return { saves, missingKeys: new Set(saves.map((s) => `TASK:${s.entityId}`)) };
    },
  );
  const service = injector.get(RemoteOpsProcessingService);
  const internals = service as unknown as Record<string, unknown>;
  internals['_withLocalOnlySyncSettingsForFullStateOps'] = async (ops: Operation[]) =>
    ops;
  internals['_logFullStateApplyDiagnostics'] = async () => undefined;
  internals['validateAfterSync'] = async () => true;
  return { service, events, dispatched, order };
};

describe('a checkpoint with a "bring it back" save', () => {
  const checkpoint = checkpointOf(start());
  const save = {
    ...rename(A, 'brought back'),
    id: 'bring-back',
    actionType: '[TASK] LWW Update',
  } as unknown as Operation;
  const unsent = { ...rename(A, 'unsent'), id: 'unsent' } as Operation;

  it('logs the save in the same write as the checkpoint, before the checkpoint replaces anything', async () => {
    const { service, events } = checkpointHarness([save], [unsent]);

    await service.processRemoteOps([checkpoint]);

    expect(events).toEqual([
      'write remote checkpoint (on top: unsent) + local bring-back',
      'apply checkpoint',
      'apply unsent',
      'apply bring-back',
    ]);
  });

  it('records on the checkpoint, in the same write, the unsent edits it puts on top, leaving out those the server holds in it', async () => {
    const held = { ...rename(A, 'held'), id: 'held' } as Operation;
    // The checkpoint's base is 7: the server stored "held" at 5, before it.
    const { service, events } = checkpointHarness([], [held, unsent], { held: 5 });

    await service.processRemoteOps([checkpoint]);

    expect(events).toEqual([
      'write remote checkpoint (on top: unsent)',
      'apply checkpoint',
      'apply unsent',
    ]);
  });

  it('asks the server before it takes the locks, and decides inside them with those answers', async () => {
    const { service, order } = checkpointHarness([save], [unsent]);

    await service.processRemoteOps([checkpoint]);

    expect(order).toEqual([
      'ask the server',
      'lock the upload',
      'learn with the answers',
      'decide with the answers',
    ]);
  });

  it('reports the save for upload, and puts back the edits under the ones typed meanwhile', async () => {
    const { service, dispatched } = checkpointHarness([save], [unsent]);

    const result = await service.processRemoteOps([checkpoint]);

    expect(result.localWinOpsCreated).toBe(1);
    const reapply = dispatched.find(
      (a) => a.type === reapplyEditsReplacedByCheckpoint.type,
    ) as unknown as {
      onTop: Operation[];
    };
    expect(reapply.onTop.map((o) => o.id)).toEqual(['unsent', 'bring-back']);
  });
});

describe('a startup without the snapshot saved after a checkpoint', () => {
  it('replays an older unsent edit after the checkpoint and its download, and before the "bring it back" save that holds it', () => {
    const entry = (
      seq: number,
      o: Operation,
      source: 'local' | 'remote',
    ): OperationLogEntry => ({
      seq,
      op: o,
      appliedAt: seq,
      source,
      ...(source === 'remote' ? { syncedAt: seq } : {}),
    });
    const timeAdded = { ...rename(A, 'unsent'), id: 'unsent-time' } as Operation;
    const bringBack = { ...rename(A, 'brought back'), id: 'bring-back' } as Operation;
    const unsent = entry(1, timeAdded, 'local');
    const save = entry(4, bringBack, 'local');
    const log = [
      unsent,
      entry(2, checkpointOf(start()), 'remote'),
      entry(3, { ...rename(B, 'remote'), id: 'remote-after' } as Operation, 'remote'),
      save,
    ];

    const replayed = withUnsentEditsAfterCheckpoint(log, [unsent, save]);

    expect(replayed.map((e) => e.op.id)).toEqual([
      'checkpoint',
      'remote-after',
      'unsent-time',
      'bring-back',
    ]);
  });

  it('replays the edits its apply put on top after the checkpoint, however late or soon their upload was acknowledged', () => {
    const sameTick = {
      ...rename(A, 'acknowledged in the same tick'),
      id: 'same-tick',
    } as Operation;
    const later = { ...rename(A, 'kept edit'), id: 'later' } as Operation;
    const cp = checkpointOf(start());
    const shown = apply(start(), [cp, sameTick, later]);
    const log: OperationLogEntry[] = [
      { seq: 1, op: sameTick, appliedAt: 1000, source: 'local', syncedAt: 2000 },
      { seq: 2, op: later, appliedAt: 1001, source: 'local', syncedAt: 3000 },
      {
        seq: 3,
        op: cp,
        appliedAt: 2000,
        source: 'remote',
        syncedAt: 2000,
        unsentOnTopOpIds: ['same-tick', 'later'],
      },
    ];

    const replayed = withUnsentEditsAfterCheckpoint(log, log);

    expect(replayed.map((e) => e.op.id)).toEqual(['checkpoint', 'same-tick', 'later']);
    expect(
      titleOf(
        apply(
          start(),
          replayed.map((e) => e.op),
        ),
      ),
    ).toBe(titleOf(shown));
  });

  it.each(['the snapshot from before the checkpoint', 'no snapshot'])(
    'replays the edits put on top after the checkpoint and its own download, and before a later download, starting from %s',
    (from) => {
      const edit = { ...rename(A, 'A kept edit'), id: 'edit' } as Operation;
      const cp = checkpointOf(start());
      const ownDownload = {
        ...rename(B, 'B in the checkpoint download'),
        id: 'own',
      } as Operation;
      const later = { ...rename(B, 'B later edit'), id: 'later' } as Operation;
      const shown = apply(start(), [cp, ownDownload, edit, later]);
      const log: OperationLogEntry[] = [
        { seq: 1, op: edit, appliedAt: 1000, source: 'local', syncedAt: 3000 },
        {
          seq: 2,
          op: cp,
          appliedAt: 2000,
          source: 'remote',
          syncedAt: 2000,
          unsentOnTopOpIds: ['edit'],
          unsentOnTopAfterSeq: 3,
        },
        { seq: 3, op: ownDownload, appliedAt: 2000, source: 'remote', syncedAt: 2000 },
        { seq: 4, op: later, appliedAt: 4000, source: 'remote', syncedAt: 4000 },
      ];
      const fromSnapshot = from !== 'no snapshot';

      const replayed = withUnsentEditsAfterCheckpoint(fromSnapshot ? log.slice(1) : log, [
        log[0],
      ]);

      expect(replayed.map((e) => e.op.id)).toEqual([
        'checkpoint',
        'own',
        'edit',
        'later',
      ]);
      const initial = fromSnapshot ? apply(start(), [edit]) : start();
      expect(
        titleOf(
          apply(
            initial,
            replayed.map((e) => e.op),
          ),
        ),
      ).toBe(titleOf(shown));
    },
  );

  it('leaves in place the edits the server already held in the checkpoint, acknowledged after it', () => {
    const olderTitle = rename(A, 'A older title');
    const time = makeOp(A, '[TimeTracking] Sync time spent', 'UPD', 't1', {
      taskId: 't1',
      date: '2026-11-21',
      duration: 60000,
    });
    const cp = checkpointOf(
      apply(start(), [olderTitle, rename(B, 'B later title'), time]),
    );
    const log: OperationLogEntry[] = [
      { seq: 1, op: olderTitle, appliedAt: 1000, source: 'local', syncedAt: 3000 },
      { seq: 2, op: time, appliedAt: 1001, source: 'local', syncedAt: 3000 },
      {
        seq: 3,
        op: cp,
        appliedAt: 2000,
        source: 'remote',
        syncedAt: 2000,
        unsentOnTopOpIds: [],
      },
    ];

    const after = apply(
      start(),
      withUnsentEditsAfterCheckpoint(log, log).map((e) => e.op),
    );

    expect(titleOf(after)).toBe('B later title');
    const tasks = after.tasks as {
      entities: Record<string, { timeSpentOnDay: Record<string, number> }>;
    };
    expect(tasks.entities.t1.timeSpentOnDay['2026-11-21']).toBe(60000);
  });
});

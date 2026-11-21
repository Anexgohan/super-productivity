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
import type { Operation } from '../../../src/app/op-log/core/operation.types';
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
): { service: RemoteOpsProcessingService; events: string[]; dispatched: Action[] } => {
  const events: string[] = [];
  const dispatched: Action[] = [];
  const ids = (ops: readonly Operation[]): string => ops.map((o) => o.id).join(',');
  let seq = 0;
  const opLogStore = {
    appendBatchSkipDuplicates: async (ops: Operation[], source: string) => {
      events.push(`write ${source} ${ids(ops)}`);
      return { seqs: ops.map(() => ++seq), writtenOps: ops, skippedCount: 0 };
    },
    appendMixedSourceBatchSkipDuplicates: async (
      batches: { ops: Operation[]; source: string }[],
    ) => {
      events.push(`write ${batches.map((b) => `${b.source} ${ids(b.ops)}`).join(' + ')}`);
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
        useValue: { request: (_: string, run: () => unknown) => run() },
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
  vi.spyOn(serverOrder, 'learnUnsentServerSeqs').mockResolvedValue();
  vi.spyOn(serverOrder, 'decideCheckpointBringBacks').mockResolvedValue({
    saves,
    missingKeys: new Set(saves.map((s) => `TASK:${s.entityId}`)),
  });
  const service = injector.get(RemoteOpsProcessingService);
  const internals = service as unknown as Record<string, unknown>;
  internals['_withLocalOnlySyncSettingsForFullStateOps'] = async (ops: Operation[]) =>
    ops;
  internals['_logFullStateApplyDiagnostics'] = async () => undefined;
  internals['validateAfterSync'] = async () => true;
  return { service, events, dispatched };
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
      'write remote checkpoint + local bring-back',
      'apply checkpoint',
      'apply unsent',
      'apply bring-back',
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

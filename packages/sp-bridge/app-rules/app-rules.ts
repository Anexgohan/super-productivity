/**
 * The app's own state rules, headless (anex/app-rules).
 *
 * Applies downloaded ops the way a browser does, using the app's own code at every step:
 *  1. integrity-check what was decrypted (the checks OperationEncryptionService runs), then convert (syncOpToOperation);
 *     decryption itself happens on the bridge's main thread, which already holds the derived key (see AppRulesRow);
 *  2. receive-side schema migration (SchemaMigrationService), stopping at an op too new to read;
 *  3. drop ops a full import superseded (SyncImportFilterService);
 *  4. one bulk reducer pass, then archive side effects op by op (replayOperationBatch with ArchiveOperationHandler).
 *
 * What is replaced, and why:
 *  - IndexedDB archive storage → an in-memory store, persisted with the app rules' cache.
 *  - The op-log store → a stub that only answers "what was the latest full-state op", the one question the import filter asks.
 *  - The apply-window and deferred-action hooks → no-ops: they suppress a browser's own effects, and the app rules have none.
 *
 * What a browser does that the app rules deliberately do not: create ops, upload, show conflict dialogs, run the post-sync
 * repair, or keep device-local sync settings across a full import. It only ever reads.
 */
import '@angular/compiler';
import { Injector, ɵINJECTOR_SCOPE as INJECTOR_SCOPE } from '@angular/core';
import { Store, type Action } from '@ngrx/store';
import { of, type Observable } from 'rxjs';
import { replayOperationBatch } from '@sp/sync-core';
import { Log, LogLevel } from '../../../src/app/core/log';
import {
  ArchiveOperationHandler,
  isArchiveAffectingAction,
} from '../../../src/app/op-log/apply/archive-operation-handler.service';
import { convertOpToAction } from '../../../src/app/op-log/apply/operation-converter.util';
import { bulkApplyOperations } from '../../../src/app/op-log/apply/bulk-hydration.action';
import {
  runWithBulkReplayFailureCollector,
  type BulkReplayReducerFailure,
} from '../../../src/app/op-log/apply/bulk-replay-failure-collector';
import { remoteArchiveDataApplied } from '../../../src/app/features/archive/store/archive.actions';
import { ArchiveService } from '../../../src/app/features/archive/archive.service';
import { TaskArchiveService } from '../../../src/app/features/archive/task-archive.service';
import { ArchiveCompressionService } from '../../../src/app/features/archive/archive-compression.service';
import { TimeTrackingService } from '../../../src/app/features/time-tracking/time-tracking.service';
import type { ArchiveModel } from '../../../src/app/features/archive/archive.model';
import { ArchiveStoreService } from '../../../src/app/op-log/persistence/archive-store.service';
import { OperationLogStoreService } from '../../../src/app/op-log/persistence/operation-log-store.service';
import {
  getOperationSchemaVersion,
  MIN_SUPPORTED_SCHEMA_VERSION,
  SchemaMigrationService,
} from '../../../src/app/op-log/persistence/schema-migration.service';
import { SyncImportFilterService } from '../../../src/app/op-log/sync/sync-import-filter.service';
import {
  assertDecryptedFullStateOpIntegrity,
  assertDecryptedOpMetadataIntegrity,
} from '../../../src/app/op-log/sync/verify-decrypted-op-integrity';
import { syncOpToOperation } from '../../../src/app/op-log/sync/operation-sync.util';
import type { SyncOperation } from '../../../src/app/op-log/sync-providers/provider.interface';
import { StateSnapshotService } from '../../../src/app/op-log/backup/state-snapshot.service';
import { validateFull } from '../../../src/app/op-log/validation/validation-fn';
import {
  applyLocalOnlySyncSettingsToAppData,
  stripLocalOnlySyncSettingsFromAppData,
  type LocalOnlySyncSettings,
} from '../../../src/app/features/config/local-only-sync-settings.util';
import { selectSyncConfig } from '../../../src/app/features/config/store/global-config.reducer';
import type { AppDataComplete } from '../../../src/app/op-log/model/model-config';
import {
  extractFullStateFromPayload,
  isFullStateOpType,
  isWrappedFullStatePayload,
  type Operation,
  type OperationLogEntry,
} from '../../../src/app/op-log/core/operation.types';
import type {
  AppRulesApplyResult,
  AppRulesRow,
  AppRulesCheckpoint,
  AppRulesSnapshot,
  AppRulesActResult,
} from '../src/app-rules-protocol';
import { buildRootReducer, type RootState } from './root-reducer';
import { logicalDayChange } from './logical-day';
import { nextCheckpointHold } from '../src/checkpoints';
import { encodeBackup, validationErrorsOf } from './board-transfer';
import { act } from './actions/act';
import { keptDeletedTasks, recordDeletedTasks, type DeletedTask } from './deleted-tasks';
import { TaskSharedActions } from '../../../src/app/root-store/meta/task-shared.actions';
import type { RestoreDeletedTaskPayload } from '../../../src/app/root-store/meta/undo-task-delete.meta-reducer';
import type { ActionWhen, ActStep } from '../src/action-inputs';

/** Bump when the cache shape changes; an older cache is then discarded and the app rules rebuild from seq 0. */
export const APP_RULES_CACHE_VERSION = 2;

export interface AppRulesCache {
  version: number;
  seq: number;
  state: RootState;
  archiveYoung?: ArchiveModel;
  archiveOld?: ArchiveModel;
  /** Metadata only: the import filter compares clocks and ids, never the full-state payload. */
  latestFullStateOp?: Operation;
  sawArchiveOp: boolean;
  filteredEntityIds: string[];
  /** Component-wise max of every handled op's vector clock: the basis for the API's own write clocks. */
  mergedClock: Record<string, number>;
  /** Why no checkpoint may be written as of `seq`; saved with it, so no restart resumes past an archive failure without its hold. */
  checkpointHeldBack?: string | null;
  /** The tasks deleted in the last 7 days, by task id, as the app's undo would put them back. */
  deletedTasks?: Record<string, DeletedTask>;
}

/** The one stand-in for IndexedDB. Clones on the way in and out, as a database round trip would. */
class MemoryArchiveStore {
  young: ArchiveModel | undefined;
  old: ArchiveModel | undefined;

  async loadArchiveYoung(): Promise<ArchiveModel | undefined> {
    return this.young && structuredClone(this.young);
  }
  async loadArchiveOld(): Promise<ArchiveModel | undefined> {
    return this.old && structuredClone(this.old);
  }
  async saveArchiveYoung(data: ArchiveModel): Promise<void> {
    this.young = structuredClone(data);
  }
  async saveArchiveOld(data: ArchiveModel): Promise<void> {
    this.old = structuredClone(data);
  }
  async saveArchivesAtomic(young: ArchiveModel, old: ArchiveModel): Promise<void> {
    this.young = structuredClone(young);
    this.old = structuredClone(old);
  }
  async hasArchiveYoung(): Promise<boolean> {
    return this.young !== undefined;
  }
  async hasArchiveOld(): Promise<boolean> {
    return this.old !== undefined;
  }
}

const entityIdsOf = (op: Operation): string[] => [
  ...(op.entityId ? [op.entityId] : []),
  ...(op.entityIds ?? []),
];

const withoutPayload = (op: Operation): Operation => ({ ...op, payload: null });

export class AppRules {
  private readonly _reducer = buildRootReducer();
  private _state: RootState;
  private _seq = 0;
  private _latestFullStateOp: Operation | undefined;
  private _sawArchiveOp = false;
  private _mergedClock: Record<string, number> = {};
  private _checkpointHeldBack: string | null = null;
  private _filteredEntityIds = new Set<string>();
  private _deletedTasks: Record<string, DeletedTask> = {};
  private readonly _archive = new MemoryArchiveStore();

  private readonly _archiveHandler: ArchiveOperationHandler;
  private readonly _importFilter: SyncImportFilterService;
  private readonly _migration: SchemaMigrationService;
  private readonly _snapshot: StateSnapshotService;

  constructor(private readonly _clientId: string) {
    // The app logs every sync step at VERBOSE; inside the bridge only problems belong in the container log. ERROR also lets warnings through.
    Log.setLevel(LogLevel.ERROR);
    this._state = this._reducer(undefined, { type: '@ngrx/store/init' });

    const store = {
      select: <T>(selector: (s: RootState) => T): Observable<T> =>
        of(selector(this._state)),
      dispatch: (action: Action): void => {
        this._state = this._reducer(this._state, action);
      },
    };
    const opLogStore = {
      getLatestFullStateOpEntry: async (): Promise<OperationLogEntry | undefined> =>
        this._latestFullStateOp
          ? {
              seq: 0,
              op: this._latestFullStateOp,
              appliedAt: 0,
              source: 'remote',
              syncedAt: 0,
            }
          : undefined,
    };
    const injector = Injector.create({
      providers: [
        // Without the root scope, providedIn:'root' services are not found by a standalone injector.
        { provide: INJECTOR_SCOPE, useValue: 'root' },
        { provide: Store, useValue: store },
        { provide: ArchiveStoreService, useValue: this._archive },
        { provide: OperationLogStoreService, useValue: opLogStore },
      ],
    });
    this._archiveHandler = injector.get(ArchiveOperationHandler);
    this._importFilter = injector.get(SyncImportFilterService);
    this._migration = injector.get(SchemaMigrationService);
    this._snapshot = injector.get(StateSnapshotService);
    // The archive handler creates these on first use. Creating them now turns a missing dependency into a failed start,
    // not a failure on the first archive op.
    injector.get(ArchiveService);
    injector.get(TaskArchiveService);
    injector.get(TimeTrackingService);
    injector.get(ArchiveCompressionService);
  }

  get seq(): number {
    return this._seq;
  }

  get mergedClock(): Record<string, number> {
    return { ...this._mergedClock };
  }

  get sawArchiveOp(): boolean {
    return this._sawArchiveOp;
  }

  get checkpointHeldBack(): string | null {
    return this._checkpointHeldBack;
  }

  /** `heldBack` is the hold saved beside a cache that does not keep one yet. */
  restore(cache: AppRulesCache, heldBack: string | null = null): void {
    this._state = cache.state;
    this._seq = cache.seq;
    this._archive.young = cache.archiveYoung;
    this._archive.old = cache.archiveOld;
    this._latestFullStateOp = cache.latestFullStateOp;
    this._sawArchiveOp = cache.sawArchiveOp;
    this._mergedClock = cache.mergedClock ?? {};
    this._filteredEntityIds = new Set(cache.filteredEntityIds ?? []);
    this._deletedTasks = cache.deletedTasks ?? {};
    this._checkpointHeldBack =
      cache.checkpointHeldBack === undefined ? heldBack : cache.checkpointHeldBack;
  }

  toCache(): AppRulesCache {
    this._deletedTasks = keptDeletedTasks(this._deletedTasks, Date.now());
    return {
      version: APP_RULES_CACHE_VERSION,
      seq: this._seq,
      state: this._state,
      archiveYoung: this._archive.young,
      archiveOld: this._archive.old,
      latestFullStateOp: this._latestFullStateOp,
      sawArchiveOp: this._sawArchiveOp,
      mergedClock: this._mergedClock,
      filteredEntityIds: [...this._filteredEntityIds],
      checkpointHeldBack: this._checkpointHeldBack,
      deletedTasks: this._deletedTasks,
    };
  }

  /**
   * Applies one downloaded page. Rows at or below the app rules' seq were applied already and are skipped.
   * The seq advances past every row handled, dropped ones included, as a browser's cursor does; it stops before a blocked op.
   */
  async applyRows(rows: AppRulesRow[]): Promise<AppRulesApplyResult> {
    const fresh = rows.filter((r) => r.serverSeq > this._seq);
    const result: AppRulesApplyResult = {
      seq: this._seq,
      applied: 0,
      filteredOpIds: [],
      filteredEntityIds: [],
      reducerFailures: [],
      sawArchiveOp: this._sawArchiveOp,
      mergedClock: { ...this._mergedClock },
      checkpointHeldBack: this._checkpointHeldBack,
    };
    if (fresh.length === 0) return result;
    const dayChange = logicalDayChange(this._state, Date.now());
    if (dayChange) this._state = this._reducer(this._state, dayChange);

    // The same checks OperationEncryptionService.decryptOperation runs after decrypting, with the same effect: a failure throws.
    const decrypted: SyncOperation[] = [];
    for (const row of fresh) {
      const op = row.op as unknown as SyncOperation;
      if (row.wasEncrypted) {
        assertDecryptedOpMetadataIntegrity(op, op.payload);
        await assertDecryptedFullStateOpIntegrity(op, op.payload);
      }
      decrypted.push(op);
    }
    const ops = decrypted.map(syncOpToOperation);

    // Receive-side migration, as RemoteOpsProcessingService.processRemoteOps does it.
    const currentVersion = this._migration.getCurrentVersion();
    const migrated: Operation[] = [];
    let handled = fresh.length;
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      let reason: string | undefined;
      try {
        const version = getOperationSchemaVersion(op as { schemaVersion?: unknown });
        if (version < MIN_SUPPORTED_SCHEMA_VERSION) reason = 'VERSION_UNSUPPORTED';
        else if (version > currentVersion) reason = 'VERSION_TOO_NEW';
      } catch {
        reason = 'INVALID_SCHEMA_VERSION';
      }
      if (!reason) {
        try {
          const out = this._migration.migrateOperation(op);
          if (Array.isArray(out)) migrated.push(...out);
          else if (out !== null) migrated.push(out);
        } catch {
          reason = 'MIGRATION_FAILED';
        }
      }
      if (reason) {
        result.blocked = { opId: op.id, reason };
        handled = i;
        break;
      }
    }

    const { validOps, invalidatedOps } =
      await this._importFilter.filterOpsInvalidatedBySyncImport(migrated);
    result.filteredOpIds = invalidatedOps.map((op) => op.id);
    result.filteredEntityIds = [...new Set(invalidatedOps.flatMap(entityIdsOf))];
    for (const id of result.filteredEntityIds) this._filteredEntityIds.add(id);

    if (validOps.length > 0) {
      const failures: BulkReplayReducerFailure[] = [];
      let replay!: Awaited<ReturnType<typeof replayOperationBatch>>;
      const deleted = await recordDeletedTasks(async () => {
        replay = await replayOperationBatch({
          ops: this._withOwnSyncSettings(validOps),
          dispatcher: {
            dispatch: (action: Action) =>
              runWithBulkReplayFailureCollector(
                (failure) => failures.push(failure),
                () => {
                  this._state = this._reducer(this._state, action);
                },
              ),
          },
          createBulkApplyAction: (operations: Operation[]) =>
            bulkApplyOperations({ operations, localClientId: this._clientId }),
          getReducerFailures: () => failures,
          remoteApplyWindow: {
            startApplyingRemoteOps: () => undefined,
            endApplyingRemoteOps: () => undefined,
            startPostSyncCooldown: () => undefined,
          },
          deferredLocalActions: { processDeferredActions: () => undefined },
          archiveSideEffects: this._archiveHandler,
          operationToAction: convertOpToAction,
          isArchiveAffectingAction,
          onRemoteArchiveDataApplied: () => {
            this._sawArchiveOp = true;
            this._state = this._reducer(this._state, remoteArchiveDataApplied());
          },
        });
      });
      this._keepDeletedTasks(deleted, validOps);

      result.applied = replay.appliedOps.length;
      result.reducerFailures = (replay.reducerFailures ?? []).map((f) => ({
        opId: f.op.id,
        actionType: f.op.actionType,
      }));
      if (replay.failedOp) {
        result.archiveFailure = {
          opId: replay.failedOp.op.id,
          actionType: replay.failedOp.op.actionType,
          error: replay.failedOp.error.message.slice(0, 200),
        };
      }
      const lastFullState = [...validOps]
        .reverse()
        .find((op) => isFullStateOpType(op.opType));
      if (lastFullState) this._latestFullStateOp = withoutPayload(lastFullState);
    }

    if (handled > 0) this._seq = fresh[handled - 1].serverSeq;
    // Every handled op counts, dropped ones too: a write clock must dominate everything the server has seen from us.
    for (const row of fresh.slice(0, handled)) {
      const clock = (row.op as { vectorClock?: unknown }).vectorClock;
      if (!clock || typeof clock !== 'object') continue;
      for (const [component, value] of Object.entries(clock as Record<string, unknown>)) {
        if (
          typeof value !== 'number' ||
          component === '__proto__' ||
          component === 'constructor' ||
          component === 'prototype'
        )
          continue;
        if ((this._mergedClock[component] ?? 0) < value)
          this._mergedClock[component] = value;
      }
    }
    result.mergedClock = { ...this._mergedClock };
    result.seq = this._seq;
    result.sawArchiveOp = this._sawArchiveOp;
    this._checkpointHeldBack = nextCheckpointHold(
      this._checkpointHeldBack,
      result,
      fresh,
    );
    result.checkpointHeldBack = this._checkpointHeldBack;
    return result;
  }

  /** Keeps what each delete just applied would put back, with its op's time; a later delete of the same task replaces it. */
  private _keepDeletedTasks(
    deleted: RestoreDeletedTaskPayload[],
    ops: Operation[],
  ): void {
    if (deleted.length === 0) return;
    const deletedAt = new Map(
      ops
        .filter(
          (op) => op.actionType === TaskSharedActions.deleteTask.type && op.entityId,
        )
        .map((op) => [op.entityId as string, op.timestamp]),
    );
    for (const payload of deleted) {
      const id = payload.task.id;
      this._deletedTasks[id] = { deletedAt: deletedAt.get(id) ?? Date.now(), payload };
    }
  }

  /** What the app's undo would put back for a task deleted in the last 7 days. */
  deletedTask(id: string): RestoreDeletedTaskPayload | undefined {
    const entry = keptDeletedTasks(this._deletedTasks, Date.now())[id];
    return entry?.payload;
  }

  /**
   * A full state keeps this board's own device-only sync settings, as RemoteOpsProcessingService does for a browser
   * (`_withLocalOnlySyncSettingsForFullStateOps`): full states travel without them, the bridge's checkpoints included.
   */
  private _withOwnSyncSettings(ops: Operation[]): Operation[] {
    if (!ops.some((op) => isFullStateOpType(op.opType))) return ops;
    const current = selectSyncConfig(this._state as never);
    const own: LocalOnlySyncSettings = {
      isEnabled: current.isEnabled,
      isEncryptionEnabled: current.isEncryptionEnabled,
      syncProvider: current.syncProvider,
      syncInterval: current.syncInterval,
      isManualSyncOnly: current.isManualSyncOnly,
    };
    return ops.map((op) => {
      if (!isFullStateOpType(op.opType)) return op;
      const fullState = extractFullStateFromPayload(op.payload);
      const withOwn = applyLocalOnlySyncSettingsToAppData(fullState, own);
      if (withOwn === fullState) return op;
      return {
        ...op,
        payload: isWrappedFullStatePayload(op.payload)
          ? { ...op.payload, appDataComplete: withOwn }
          : withOwn,
      };
    });
  }

  /**
   * A checkpoint's state (anex/checkpoints): the snapshot a browser puts in a REPAIR, run through the app's own
   * validateFull, which every browser runs on the state it receives. Errors carry paths and expected types, not values.
   */
  async checkpoint(): Promise<AppRulesCheckpoint> {
    const snap = await this.snapshot();
    const seq = snap.seq;
    // Validated as a browser holds it, with its device-only sync settings; uploaded without them, as a browser
    // strips them before uploading a full state and every receiver puts its own back before validating.
    const result = validateFull(snap.appData as unknown as AppDataComplete);
    const appData = stripLocalOnlySyncSettingsFromAppData(snap.appData) as Record<
      string,
      unknown
    >;
    return {
      seq,
      appData,
      validation: { isValid: result.isValid, errors: validationErrorsOf(result) },
    };
  }

  /** The ops a browser would upload for app actions on this board, as it stands; the board itself is left as it is. */
  act(steps: ActStep[], when: ActionWhen): Promise<AppRulesActResult> {
    return act(
      {
        clientId: this._clientId,
        state: this._state,
        reducer: this._reducer,
        archive: this._archive,
        deletedTask: (id) => this.deletedTask(id),
      },
      steps,
      when,
    );
  }

  /** The board as the app's own backup file, archives included, as of `seq`. */
  async exportBackup(): Promise<{ seq: number; bytes: ArrayBuffer }> {
    const seq = this._seq;
    const appData = await this._snapshot.getStateSnapshotAsync();
    return { seq, bytes: encodeBackup(appData as unknown as Record<string, unknown>) };
  }

  /** The state as a browser would upload it in a full import: the app's own snapshot service, archives included. */
  async snapshot(): Promise<AppRulesSnapshot> {
    const appData = (await this._snapshot.getStateSnapshotAsync()) as unknown as Record<
      string,
      unknown
    >;
    return {
      seq: this._seq,
      appData: structuredClone(appData),
      heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1048576),
      filteredEntityIds: [...this._filteredEntityIds],
      sawArchiveOp: this._sawArchiveOp,
    };
  }
}

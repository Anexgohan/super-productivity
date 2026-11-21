/**
 * anex fork, Stage 9: a browser follows the server's order.
 *
 * Holds what a server-order replay needs between syncs, all in memory (a reload starts over and rebuilds when the
 * order matters): the state the server confirmed and its server number, this browser's saves the server accepted but
 * the confirmed state does not hold yet, and the server numbers of downloaded changes. It also builds the two extra
 * pieces a replay can need: the confirmed state rebuilt from the newest checkpoint, and a "bring it back" save for a task
 * or note another browser deleted earlier, by device time, than this browser's edit to it.
 *
 * RemoteOpsProcessingService drives the apply; the reducer side is server-order-replay.meta-reducer.ts and the plan is
 * planServerOrderApply in @sp/sync-core.
 */
import { inject, Injectable, Injector } from '@angular/core';
import { Action, Store } from '@ngrx/store';
import { firstValueFrom } from 'rxjs';
import { take } from 'rxjs/operators';
import {
  deleteTimesWithParents,
  findEditsThatBeatDeletes,
  findRecreationsBeatenByDeletes,
  findUnaccountedServerSeq,
  planServerOrderApply,
  type EditBeatingDelete,
  type ItemDelete,
  type ServerOrderedOp,
  type ServerOrderPlan,
} from '@sp/sync-core';
import {
  EntityType,
  extractFullStateFromPayload,
  FULL_STATE_OP_TYPES,
  Operation,
  OpType,
} from '../core/operation.types';
import { bulkApplyOperations } from '../apply/bulk-hydration.action';
import { bringBackTaskStates } from './server-order-bring-back.util';
import {
  bringBackNoteStates,
  editsShown,
  itemsMissingFromCheckpoint,
  itemsRemovedBy,
  recreatesItem,
} from './server-order-delete-rule.util';
import {
  isDeleteTimesCapable,
  isStoredServerSeqsCapable,
} from '../sync-providers/provider.interface';
import { OperationApplierService } from '../apply/operation-applier.service';
import { historyBeforeBatch, opsAsDownloadApplies } from './server-order-rebuild.util';
import { SchemaMigrationService } from '../persistence/schema-migration.service';
import { SyncImportFilterService } from './sync-import-filter.service';
import { OperationLogStoreService } from '../persistence/operation-log-store.service';
import { OperationLogDownloadService } from './operation-log-download.service';
import { ConflictResolutionService } from './conflict-resolution.service';
import { SyncProviderManager } from '../sync-providers/provider-manager.service';
import { SyncProviderId } from '../sync-providers/provider.const';
import { WrappedProviderService } from '../sync-providers/wrapped-provider.service';
import { CLIENT_ID_PROVIDER } from '../util/client-id.provider';
import { OperationCaptureService } from '../capture/operation-capture.service';
import { TaskTimeSyncService } from '../../features/tasks/task-time-sync.service';
import { SimpleCounterService } from '../../features/simple-counter/simple-counter.service';
import { TaskState } from '../../features/tasks/task.model';
import { TASK_FEATURE_NAME } from '../../features/tasks/store/task.reducer';
import { NoteState } from '../../features/note/note.model';
import { NOTE_FEATURE_NAME } from '../../features/note/store/note.reducer';
import {
  serverOrderRebuild,
  serverOrderReplay,
  setUnsavedLocalTimeSource,
  takeReplayedConfirmedState,
} from '../apply/server-order-replay.meta-reducer';
import {
  UnsavedLocalTime,
  withoutUnsavedTaskTime,
} from '../apply/server-order-local-state.util';
import { OpLog } from '../../core/log';

/** Downloaded changes whose server number is kept until they are applied; old ones are dropped beyond this. */
const MAX_REMEMBERED_SEQS = 20_000;

const rememberSeq = (
  seqs: Map<string, number>,
  opId: string,
  serverSeq: number,
): void => {
  seqs.set(opId, serverSeq);
  // Map keeps insertion order: the oldest numbers go first.
  for (const id of seqs.keys()) {
    if (seqs.size <= MAX_REMEMBERED_SEQS) break;
    seqs.delete(id);
  }
};

interface Confirmed {
  state: object;
  seq: number;
}

export interface ServerOrderPrepared {
  plan: ServerOrderPlan<Operation>;
  downloaded: ServerOrderedOp<Operation>[];
}

/** What a checkpoint apply brings back, and the shown items it lacks, as `TYPE:id`. */
export interface CheckpointBringBack {
  saves: Operation[];
  missingKeys: ReadonlySet<string>;
}

export const NO_CHECKPOINT_BRING_BACK: CheckpointBringBack = {
  saves: [],
  missingKeys: new Set(),
};

const itemKeyOf = (op: { entityType: string; entityId?: string }): string =>
  `${op.entityType}:${op.entityId ?? ''}`;

@Injectable({ providedIn: 'root' })
export class ServerOrderService {
  private store = inject(Store);
  private opLogStore = inject(OperationLogStoreService);
  private providerManager = inject(SyncProviderManager);
  private clientIdProvider = inject(CLIENT_ID_PROVIDER);
  // Resolved lazily: these sit around the sync services in the dependency graph.
  private injector = inject(Injector);

  private confirmed: Confirmed | undefined;
  private accepted: ServerOrderedOp<Operation>[] = [];
  private seqByOpId = new Map<string, number>();
  private ownSeqByOpId = new Map<string, number>();
  private ownLatestSeq: number | undefined;
  private epoch = this.providerManager.syncEpoch;

  /** Only SuperSync numbers every change; other providers keep today's conflict handling. */
  isActive(): boolean {
    return this.providerManager.getActiveProvider()?.id === SyncProviderId.SuperSync;
  }

  /** Forgets the confirmed state and this browser's accepted saves (full-state change, error, new sync target). */
  reset(reason: string): void {
    if (this.confirmed || this.accepted.length > 0) {
      OpLog.normal(`ServerOrderService: confirmed state reset (${reason})`);
    }
    this.confirmed = undefined;
    this.accepted = [];
  }

  /** Server numbers of downloaded or piggybacked changes, read when they are applied. */
  recordServerSeqs(
    serverOps: readonly { serverSeq: number; op: { id: string } }[],
  ): void {
    for (const { serverSeq, op } of serverOps) {
      rememberSeq(this.seqByOpId, op.id, serverSeq);
    }
  }

  /** The highest number the server said it holds for this browser's saves, sent with a download. */
  recordOwnLatestSeq(serverSeq: number | undefined): void {
    if (serverSeq === undefined) return;
    this.syncEpoch();
    this.ownLatestSeq = Math.max(this.ownLatestSeq ?? 0, serverSeq);
  }

  /** The number the server gave one of this browser's saves, if this browser saw the answer. */
  ownServerSeq(opId: string): number | undefined {
    return this.ownSeqByOpId.get(opId);
  }

  forgetServerSeqs(ops: readonly Operation[]): void {
    for (const op of ops) this.seqByOpId.delete(op.id);
  }

  /** This browser's saves the server accepted, with the numbers it gave them; a save it already held comes back as a duplicate with its number. */
  recordAccepted(
    ops: readonly Operation[],
    results: readonly {
      opId: string;
      accepted: boolean;
      serverSeq?: number;
      errorCode?: string;
    }[],
  ): void {
    this.syncEpoch();
    const byId = new Map(ops.map((op) => [op.id, op]));
    const known = new Set(this.accepted.map(({ op }) => op.id));
    for (const result of results) {
      const op = byId.get(result.opId);
      const isStored = result.accepted || result.errorCode === 'DUPLICATE_OPERATION';
      if (!op || !isStored || result.serverSeq === undefined) continue;
      rememberSeq(this.ownSeqByOpId, op.id, result.serverSeq);
      // A duplicate the confirmed state already holds must not be replayed again.
      if (
        known.has(op.id) ||
        (this.confirmed && result.serverSeq <= this.confirmed.seq)
      ) {
        continue;
      }
      if (FULL_STATE_OP_TYPES.has(op.opType)) {
        this.reset('full-state save accepted');
        return;
      }
      this.accepted.push({ op, serverSeq: result.serverSeq });
    }
  }

  /** Every downloaded change has a server number recorded; without them the order is unknown. */
  hasServerSeqs(ops: readonly Operation[]): boolean {
    return ops.every((op) => this.seqByOpId.has(op.id));
  }

  /**
   * What to do with a batch of downloaded changes, given this browser's unsent edits and the bring-back saves about to join them.
   * Runs inside the cutoff.
   */
  async prepare(
    validOps: Operation[],
    receivedOps: readonly Operation[],
    bringBack: readonly Operation[] = [],
  ): Promise<ServerOrderPrepared> {
    this.syncEpoch();
    const downloaded = validOps.map((op) => ({
      op,
      serverSeq: this.seqByOpId.get(op.id) ?? 0,
    }));
    // Changes received in this batch but dropped before the apply (migrated away, before an import) are accounted for.
    const receivedSeqs = receivedOps
      .map((op) => this.seqByOpId.get(op.id))
      .filter((seq): seq is number => seq !== undefined);
    const plan = planServerOrderApply({
      downloaded,
      accepted: this.accepted,
      unsent: [...(await this.readUnsent()), ...bringBack],
      hasConfirmedState: this.isConfirmedStateUsable(downloaded, receivedSeqs),
      ownLatestSeq: this.ownLatestSeq,
    });
    return { plan, downloaded };
  }

  /**
   * Rebuilds the confirmed state up to just before the downloaded batch: the newest checkpoint plus the changes after
   * it, this browser's included. Returns false when the server's history cannot give that state.
   */
  async rebuildConfirmedState(
    downloaded: ServerOrderedOp<Operation>[],
  ): Promise<boolean> {
    // Provider and epoch read together, as every download does (#9074).
    const rawProvider = this.providerManager.getActiveProvider();
    const fenceEpoch = this.providerManager.syncEpoch;
    const provider = rawProvider
      ? await this.injector
          .get(WrappedProviderService)
          .getOperationSyncCapable(rawProvider, { fenceEpoch })
      : null;
    const clientId = await this.clientIdProvider.loadClientId();
    if (!provider || !clientId) return false;
    const firstBatchSeq = Math.min(...downloaded.map(({ serverSeq }) => serverSeq));
    const batchIds = new Set(downloaded.map(({ op }) => op.id));

    const result = await this.injector
      .get(OperationLogDownloadService)
      .downloadRemoteOps(provider, {
        forceFromSeq0: true,
        includeOwnAndAppliedOps: true,
      });
    const history = result.newOps
      .map((op) => ({ op, serverSeq: this.seqByOpId.get(op.id) }))
      .filter(
        (entry): entry is ServerOrderedOp<Operation> => entry.serverSeq !== undefined,
      )
      .sort((a, b) => a.serverSeq - b.serverSeq);
    if (!result.success || history.length !== result.newOps.length) return false;
    // Numbers older than the batch are not needed again; later ones may belong to the rest of this download.
    this.forgetServerSeqs(
      history.filter(({ serverSeq }) => serverSeq < firstBatchSeq).map(({ op }) => op),
    );
    const before = historyBeforeBatch(history, firstBatchSeq);
    const ops =
      before &&
      (await opsAsDownloadApplies(
        before.map(({ op }) => op),
        this.injector.get(SchemaMigrationService),
        this.injector.get(SyncImportFilterService),
      ));
    if (!before || !ops) {
      OpLog.warn(
        'ServerOrderService: server history cannot rebuild the confirmed state',
        {
          firstBatchSeq,
          historyStart: history[0]?.serverSeq,
        },
      );
      return false;
    }

    this.store.dispatch(serverOrderRebuild({ ops, localClientId: clientId }));
    const state = takeReplayedConfirmedState();
    if (!state) return false;

    // This browser's saves numbered after the rebuilt state belong in the replay, even those sent before a reload.
    const inConfirmed = new Set(before.map(({ op }) => op.id));
    const ownLater = history.filter(
      ({ op, serverSeq }) =>
        serverSeq >= firstBatchSeq && op.clientId === clientId && !batchIds.has(op.id),
    );
    const known = new Set(this.accepted.map(({ op }) => op.id));
    this.accepted = [
      ...this.accepted.filter(({ op }) => !inConfirmed.has(op.id)),
      ...ownLater.filter(({ op }) => !known.has(op.id)),
    ].sort((a, b) => a.serverSeq - b.serverSeq);
    this.confirmed = { state, seq: firstBatchSeq - 1 };
    OpLog.normal('ServerOrderService: confirmed state rebuilt from the server history', {
      seq: this.confirmed.seq,
      ops: before.length,
    });
    return true;
  }

  /**
   * Before a download is applied, inside the cutoff: saves that bring back the tasks and notes it deletes that this browser edited later.
   * Later means by device time.
   * Unsent recreations that a later delete beats are withdrawn first. The saves are not written: the apply logs them right after the download.
   */
  async decideBringBacks(validOps: readonly Operation[]): Promise<Operation[]> {
    const deleteOps: Operation[] = [];
    for (const op of validOps) {
      if (
        op.opType === OpType.Delete &&
        (op.entityType === 'TASK' || op.entityType === 'NOTE') &&
        !(await this.opLogStore.hasOp(op.id))
      ) {
        deleteOps.push(op);
      }
    }
    if (deleteOps.length === 0) return [];
    const state = await this.readState();
    const tasks = state[TASK_FEATURE_NAME] as TaskState | undefined;
    const deletes = itemsRemovedBy(deleteOps, tasks);
    await this.withdrawBeatenRecreations(deletes);
    const winners = findEditsThatBeatDeletes({
      deletes,
      own: await this.readOwnChanges(),
    });
    return this.buildBringBackSaves(
      winners,
      new Set(deletes.filter((d) => d.entityType === 'TASK').map((d) => d.entityId)),
      state,
    );
  }

  /**
   * Before a checkpoint is applied: asks the server for the numbers of the unsent saves whose number this browser does not know.
   * A save stored before the checkpoint's base is in it already; a reload or a lost upload answer leaves its number unknown here.
   * Throws when the server cannot answer, so this apply stops before anything changes and the next sync retries it.
   */
  async learnUnsentServerSeqs(): Promise<void> {
    const provider = this.providerManager.getActiveProvider();
    if (!isStoredServerSeqsCapable(provider)) return;
    this.syncEpoch();
    const unknown = new Set(
      (await this.readUnsent())
        .map((op) => op.id)
        .filter((opId) => !this.ownSeqByOpId.has(opId)),
    );
    if (unknown.size === 0) return;
    for (const { opId, serverSeq } of await provider.getStoredServerSeqs([...unknown])) {
      if (unknown.has(opId)) rememberSeq(this.ownSeqByOpId, opId, serverSeq);
    }
  }

  /**
   * Before a checkpoint is applied: asks the server when the shown tasks and notes the checkpoint lacks, and this browser edited, were deleted.
   * Each one edited later than its delete gets a "bring it back" save, written and applied after the checkpoint.
   * Throws when the server cannot answer, so this apply stops before anything changes and the next sync retries it.
   */
  async decideCheckpointBringBacks(
    validOps: readonly Operation[],
  ): Promise<CheckpointBringBack> {
    const checkpoint = validOps.filter((op) => FULL_STATE_OP_TYPES.has(op.opType)).pop();
    const provider = this.providerManager.getActiveProvider();
    if (!checkpoint || !isDeleteTimesCapable(provider)) return NO_CHECKPOINT_BRING_BACK;
    const state = await this.readState();
    const tasks = state[TASK_FEATURE_NAME] as TaskState | undefined;
    const missing = itemsMissingFromCheckpoint(
      { tasks, notes: state[NOTE_FEATURE_NAME] as NoteState | undefined },
      extractFullStateFromPayload(checkpoint.payload),
    );
    const missingKeys = new Set(missing.map(itemKeyOf));
    if (missing.length === 0) return { saves: [], missingKeys };

    const own = await this.readOwnChanges();
    const edited = new Set(
      own.filter((op) => op.opType === OpType.Update).map(itemKeyOf),
    );
    const candidates = missing.filter((item) => edited.has(itemKeyOf(item)));
    if (candidates.length === 0) return { saves: [], missingKeys };
    const asked = new Map<string, { entityType: 'TASK' | 'NOTE'; entityId: string }>();
    for (const { entityType, entityId, parentId } of candidates) {
      asked.set(itemKeyOf({ entityType, entityId }), { entityType, entityId });
      if (parentId) {
        asked.set(itemKeyOf({ entityType, entityId: parentId }), {
          entityType,
          entityId: parentId,
        });
      }
    }
    const records = await provider.getDeleteTimes([...asked.values()]);
    const deletes = deleteTimesWithParents(candidates, records);
    await this.withdrawBeatenRecreations(deletes);
    const saves = await this.buildBringBackSaves(
      findEditsThatBeatDeletes({ deletes, own }),
      new Set(
        missing.filter((item) => item.entityType === 'TASK').map((i) => i.entityId),
      ),
      state,
    );
    return { saves, missingKeys };
  }

  /** After a checkpoint and the unsent edits on top: logs the bring-back saves after them and applies them. Returns how many applied. */
  async writeAndApplyBringBacks(saves: Operation[]): Promise<number> {
    if (saves.length === 0) return 0;
    // The batch rebases each save on the stored clock, so the written ops are the ones to apply and upload.
    const { written } = await this.opLogStore.appendMixedSourceBatchSkipDuplicates([
      { ops: saves, source: 'local' },
    ]);
    return this.applyOnTop(written.map((entry) => entry.op));
  }

  /** Applies this browser's saves on top of the state shown, as received ops are applied. Returns how many applied. */
  async applyOnTop(ops: Operation[]): Promise<number> {
    if (ops.length === 0) return 0;
    const result = await this.injector
      .get(OperationApplierService)
      .applyOperations(ops, { skipDeferredLocalActions: true });
    if (result.failedOp) {
      OpLog.err('ServerOrderService: a "bring it back" save failed to apply', {
        opId: result.failedOp.op.id,
      });
    }
    return result.appliedOps.length;
  }

  /** How many of the unsent edits applied on top of a checkpoint show. */
  async countEditsShown(
    applied: readonly Operation[],
    missingKeys: ReadonlySet<string>,
  ): Promise<number> {
    return missingKeys.size === 0
      ? applied.length
      : editsShown(applied, missingKeys, await this.readState()).length;
  }

  /** The bulk action for a replay, built from the downloaded changes the crash-safe apply actually applies. */
  replayActionFactory(
    prepared: ServerOrderPrepared,
  ): (ops: Operation[], localClientId?: string) => Action {
    const { plan } = prepared;
    if (plan.kind !== 'replay' || !this.confirmed) {
      throw new Error(
        'ServerOrderService: a replay needs a replay plan and a confirmed state',
      );
    }
    const confirmed = this.confirmed.state;
    const downloadedIds = new Set(prepared.downloaded.map(({ op }) => op.id));
    this.registerUnsavedTimeSource();
    return (ops, localClientId) => {
      const applying = new Set(ops.map((op) => op.id));
      return serverOrderReplay({
        confirmed,
        ordered: plan.ordered.filter(
          (op) => !downloadedIds.has(op.id) || applying.has(op.id),
        ),
        onTop: plan.onTop,
        downloadedOpIds: [...applying],
        localClientId,
      });
    };
  }

  /** The bulk apply for a checkpoint: it replaces the synced data and keeps what lives only in this browser. */
  checkpointApplyAction(): (ops: Operation[], localClientId?: string) => Action {
    this.registerUnsavedTimeSource();
    return (operations, localClientId) =>
      bulkApplyOperations({ operations, localClientId, keepsLocalOnlyState: true });
  }

  /** After a replay: the replayed confirmed state becomes the base, and the placed saves leave the list. */
  commitReplay(prepared: ServerOrderPrepared): void {
    const { plan } = prepared;
    const state = takeReplayedConfirmedState();
    if (plan.kind !== 'replay' || !state) {
      this.reset('replay left no confirmed state');
      return;
    }
    const placed = new Set(plan.placedOpIds);
    this.accepted = this.accepted.filter(({ op }) => !placed.has(op.id));
    this.confirmed = { state, seq: plan.confirmedSeq };
  }

  /**
   * After a download applied as today: with nothing of this browser's own waiting, the state shown is the confirmed
   * state, less the tracked time not saved yet. Edits held back during the apply are in it too, so then it is unknown.
   */
  async commitInOrder(
    prepared: ServerOrderPrepared,
    hasHeldBackEdits: boolean,
  ): Promise<void> {
    const { plan } = prepared;
    if (plan.kind !== 'in-order') return;
    this.accepted = this.accepted.filter(
      ({ serverSeq }) => serverSeq > plan.confirmedSeq,
    );
    if (hasHeldBackEdits) {
      this.confirmed = undefined;
      return;
    }
    this.confirmed = {
      state: withoutUnsavedTaskTime(await this.readState(), this.readUnsavedTime()),
      seq: plan.confirmedSeq,
    };
  }

  /**
   * The confirmed state fits this batch only if every server number between it and the end of the batch is accounted
   * for: downloaded now or one of this browser's accepted saves. Anything else (a save from another tab, a dropped
   * download) means the replay would start from the wrong state. Numbers already in the confirmed state mean the same.
   */
  private isConfirmedStateUsable(
    downloaded: ServerOrderedOp<Operation>[],
    receivedSeqs: readonly number[],
  ): boolean {
    if (!this.confirmed) return false;
    const missing = findUnaccountedServerSeq({
      confirmedSeq: this.confirmed.seq,
      downloadedSeqs: downloaded.map(({ serverSeq }) => serverSeq),
      knownSeqs: [...receivedSeqs, ...this.accepted.map(({ serverSeq }) => serverSeq)],
    });
    if (missing !== undefined) {
      OpLog.warn('ServerOrderService: the confirmed state does not fit this download', {
        seq: missing,
        confirmedSeq: this.confirmed.seq,
      });
      return false;
    }
    return true;
  }

  private async readUnsent(): Promise<Operation[]> {
    const accepted = new Set(this.accepted.map(({ op }) => op.id));
    return (await this.opLogStore.getUnsynced())
      .filter(
        (entry) =>
          entry.source === 'local' &&
          !accepted.has(entry.op.id) &&
          !FULL_STATE_OP_TYPES.has(entry.op.opType),
      )
      .map((entry) => entry.op);
  }

  /**
   * "Bring it back" saves for the items whose edit here beats their delete: a task with its deleted parent first, a note on its own.
   * Each save carries the time of the edit it answers, so a later delete still beats it.
   */
  private async buildBringBackSaves(
    winners: readonly EditBeatingDelete[],
    deletedTaskIds: ReadonlySet<string>,
    state: Record<string, unknown>,
  ): Promise<Operation[]> {
    if (winners.length === 0) return [];
    const clientId = await this.clientIdProvider.loadClientId();
    if (!clientId) return [];
    const resolver = this.injector.get(ConflictResolutionService);
    const clock = resolver.mergeAndIncrementClocks(
      [(await this.opLogStore.getVectorClock()) ?? {}],
      clientId,
    );
    const editAt = new Map(winners.map((winner) => [itemKeyOf(winner), winner.editAt]));
    const idsOfType = (entityType: string): string[] =>
      winners.filter((w) => w.entityType === entityType).map((w) => w.entityId);
    const tasks = bringBackTaskStates(
      idsOfType('TASK'),
      deletedTaskIds,
      state[TASK_FEATURE_NAME] as TaskState | undefined,
      this.readUnsavedTime().taskTime,
    );
    // A parent brought back for its subtask answers the latest edit among them.
    const parentEditAt = (taskId: string): number =>
      Math.max(
        ...tasks
          .filter((task) => task.parentId === taskId)
          .map(
            (task) =>
              editAt.get(itemKeyOf({ entityType: 'TASK', entityId: task.id })) ?? 0,
          ),
      );
    const save = (entityType: EntityType, entity: { id: string }): Operation => {
      const key = itemKeyOf({ entityType, entityId: entity.id });
      const op = resolver.createLWWUpdateOp(
        entityType,
        entity.id,
        entity,
        clientId,
        clock,
        editAt.get(key) ?? parentEditAt(entity.id),
      );
      return {
        ...op,
        payload: { ...(op.payload as object), recreatesEntityAfterDelete: true },
      } as Operation;
    };
    const saves = [
      ...tasks.map((task) => save('TASK', task)),
      ...bringBackNoteStates(
        idsOfType('NOTE'),
        state[NOTE_FEATURE_NAME] as NoteState | undefined,
      ).map((note) => save('NOTE', note)),
    ];
    if (saves.length > 0) {
      OpLog.normal(
        `ServerOrderService: ${saves.length} "bring it back" save(s) for items deleted before this browser's edit`,
        { ids: saves.map((op) => op.entityId) },
      );
    }
    return saves;
  }

  /** Withdraws this browser's unsent recreations of items whose delete is later, before they are sent. */
  private async withdrawBeatenRecreations(deletes: readonly ItemDelete[]): Promise<void> {
    const beaten = findRecreationsBeatenByDeletes({
      deletes,
      unsent: await this.readUnsent(),
      recreatesItem,
    });
    if (beaten.length === 0) return;
    await this.opLogStore.markRejected(beaten.map((op) => op.id));
    OpLog.normal(
      `ServerOrderService: withdrew ${beaten.length} unsent save(s) that a later delete beats`,
      { opIds: beaten.map((op) => op.id) },
    );
  }

  /** This browser's own changes still in its change log, sent or not, in the order they were made. */
  private async readOwnChanges(): Promise<Operation[]> {
    return (await this.opLogStore.getOpsAfterSeq(0))
      .filter((entry) => entry.source === 'local' && !entry.rejectedAt)
      .map((entry) => entry.op);
  }

  private readState(): Promise<Record<string, unknown>> {
    return firstValueFrom(this.store.pipe(take(1))) as Promise<Record<string, unknown>>;
  }

  private readUnsavedTime(): UnsavedLocalTime {
    return {
      taskTime: [
        ...this.injector.get(TaskTimeSyncService).getPendingEntries(),
        ...this.injector.get(OperationCaptureService).getPendingTaskTimeEntries(),
      ],
      stopwatch: this.injector.get(SimpleCounterService).getPendingStopwatchEntries(),
    };
  }

  private registerUnsavedTimeSource(): void {
    setUnsavedLocalTimeSource(() => this.readUnsavedTime());
  }

  /** A new sync target or a destructive replacement bumps the epoch; what was held belongs to the old one. */
  private syncEpoch(): void {
    const epoch = this.providerManager.syncEpoch;
    if (epoch !== this.epoch) {
      this.epoch = epoch;
      this.reset('sync epoch changed');
      this.ownSeqByOpId.clear();
      this.ownLatestSeq = undefined;
    }
  }
}

export type { ServerOrderPlan };

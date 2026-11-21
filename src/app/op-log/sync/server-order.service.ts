/**
 * anex fork, Stage 9: a browser follows the server's order.
 *
 * Holds what a server-order replay needs between syncs, all in memory (a reload starts over and rebuilds when the
 * order matters): the state the server confirmed and its server number, this browser's saves the server accepted but
 * the confirmed state does not hold yet, and the server numbers of downloaded changes. It also builds the two extra
 * pieces a replay can need: the confirmed state rebuilt from the newest checkpoint, and a "bring it back" save for a task
 * another browser deleted before this browser's edit to it (the Stage 8 behaviour, kept by the user's decision).
 *
 * RemoteOpsProcessingService drives the apply; the reducer side is server-order-replay.meta-reducer.ts and the plan is
 * planServerOrderApply in @sp/sync-core.
 */
import { inject, Injectable, Injector } from '@angular/core';
import { Action, Store } from '@ngrx/store';
import { firstValueFrom } from 'rxjs';
import { take } from 'rxjs/operators';
import {
  findEditsAfterRemoteDelete,
  findUnaccountedServerSeq,
  planServerOrderApply,
  type ServerOrderedOp,
  type ServerOrderPlan,
} from '@sp/sync-core';
import {
  EntityType,
  FULL_STATE_OP_TYPES,
  Operation,
  OpType,
} from '../core/operation.types';
import { bulkApplyOperations } from '../apply/bulk-hydration.action';
import { bringBackTaskStates } from './server-order-bring-back.util';
import { historyBeforeBatch, opsAsDownloadApplies } from './server-order-rebuild.util';
import { SchemaMigrationService } from '../persistence/schema-migration.service';
import { SyncImportFilterService } from './sync-import-filter.service';
import { OperationLogStoreService } from '../persistence/operation-log-store.service';
import { OperationLogSnapshotService } from '../persistence/operation-log-snapshot.service';
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
/** A replay can reorder what the startup rebuild would replay in local order, so the state is saved soon after. */
const SNAPSHOT_AFTER_REPLAY_DELAY_MS = 2_000;

interface Confirmed {
  state: object;
  seq: number;
}

export interface ServerOrderPrepared {
  plan: ServerOrderPlan<Operation>;
  downloaded: ServerOrderedOp<Operation>[];
}

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
  private epoch = this.providerManager.syncEpoch;
  private snapshotTimer: ReturnType<typeof setTimeout> | undefined;

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

  /** The number the server gave one of this browser's saves, if this browser saw the answer. */
  ownServerSeq(opId: string): number | undefined {
    return this.ownSeqByOpId.get(opId);
  }

  forgetServerSeqs(ops: readonly Operation[]): void {
    for (const op of ops) this.seqByOpId.delete(op.id);
  }

  /** This browser's saves the server accepted, with the numbers it gave them. */
  recordAccepted(
    ops: readonly Operation[],
    results: readonly { opId: string; accepted: boolean; serverSeq?: number }[],
  ): void {
    this.syncEpoch();
    const byId = new Map(ops.map((op) => [op.id, op]));
    const known = new Set(this.accepted.map(({ op }) => op.id));
    for (const result of results) {
      const op = byId.get(result.opId);
      if (!op || !result.accepted || result.serverSeq === undefined) continue;
      rememberSeq(this.ownSeqByOpId, op.id, result.serverSeq);
      if (known.has(op.id)) continue;
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

  /** What to do with a batch of downloaded changes, given this browser's unsent edits. Inside the cutoff. */
  async prepare(
    validOps: Operation[],
    receivedOps: readonly Operation[],
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
      unsent: await this.readUnsent(),
      hasConfirmedState: this.isConfirmedStateUsable(downloaded, receivedSeqs),
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
   * "Bring it back" saves for tasks another browser deleted before this browser's edit to them, in server order: an
   * edit applied after the delete would change nothing, here and on the server. Written to the change log as local
   * saves (uploaded as usual) and returned for the replay to apply on top. Before the replay: reads the state shown.
   */
  async writeBringBackSaves(prepared: ServerOrderPrepared): Promise<Operation[]> {
    const { plan, downloaded } = prepared;
    if (plan.kind !== 'replay') return [];
    const placed = new Set(plan.placedOpIds);
    const acceptedSeq = new Map(
      this.accepted.map(({ op, serverSeq }) => [op.id, serverSeq]),
    );
    const editsByTask = findEditsAfterRemoteDelete({
      downloaded,
      own: [...plan.ordered.filter((op) => placed.has(op.id)), ...plan.onTop].map(
        (op) => ({
          op,
          serverSeq: acceptedSeq.get(op.id),
        }),
      ),
      entityType: 'TASK',
    });
    if (editsByTask.size === 0) return [];

    const clientId = await this.clientIdProvider.loadClientId();
    if (!clientId) return [];
    const tasks = (await this.readState())[TASK_FEATURE_NAME] as TaskState | undefined;
    const resolver = this.injector.get(ConflictResolutionService);
    const clock = resolver.mergeAndIncrementClocks(
      [(await this.opLogStore.getVectorClock()) ?? {}],
      clientId,
    );
    const deletedTaskIds = new Set<string>();
    for (const { op } of downloaded) {
      if (op.entityType === 'TASK' && op.opType === OpType.Delete) {
        [op.entityId, ...(op.entityIds ?? [])].forEach(
          (id) => id && deletedTaskIds.add(id),
        );
      }
    }
    const lastEditAt = (taskId: string): number =>
      Math.max(
        ...(editsByTask.get(taskId) ?? [...editsByTask.values()].flat()).map(
          (op) => op.timestamp,
        ),
      );
    // Only task saves, no copies of project or parent lists (server-order-bring-back.util.ts).
    const saves: Operation[] = bringBackTaskStates(
      editsByTask.keys(),
      deletedTaskIds,
      tasks,
      this.readUnsavedTime().taskTime,
    ).map((task) => {
      const save = resolver.createLWWUpdateOp(
        'TASK' as EntityType,
        task.id,
        task,
        clientId,
        clock,
        lastEditAt(task.id),
      );
      return {
        ...save,
        payload: { ...(save.payload as object), recreatesEntityAfterDelete: true },
      } as Operation;
    });
    if (saves.length === 0) return [];

    // The batch rebases each save on the stored clock, so the written ops are the ones to apply and upload.
    const { written } = await this.opLogStore.appendMixedSourceBatchSkipDuplicates([
      { ops: saves, source: 'local' },
    ]);
    OpLog.normal(
      `ServerOrderService: ${written.length} "bring it back" save(s) for tasks deleted on another device`,
      { taskIds: saves.map((op) => op.entityId) },
    );
    return written.map((entry) => entry.op);
  }

  /** The bulk action for a replay, built from the downloaded changes the crash-safe apply actually applies. */
  replayActionFactory(
    prepared: ServerOrderPrepared,
    bringBack: Operation[],
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
        onTop: [...plan.onTop, ...bringBack],
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
    this.scheduleSnapshot();
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
    }
  }

  private scheduleSnapshot(): void {
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = undefined;
      this.injector
        .get(OperationLogSnapshotService)
        .saveCurrentStateAsSnapshot()
        .catch((e: unknown) =>
          OpLog.err('ServerOrderService: saving the state after a replay failed', {
            name: (e as Error | undefined)?.name,
          }),
        );
    }, SNAPSHOT_AFTER_REPLAY_DELAY_MS);
  }
}

export type { ServerOrderPlan };

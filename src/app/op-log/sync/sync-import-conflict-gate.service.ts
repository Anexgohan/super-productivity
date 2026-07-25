import { inject, Injectable } from '@angular/core';
import { OperationLogStoreService } from '../persistence/operation-log-store.service';
import {
  ActionType,
  extractActionPayload,
  FULL_STATE_OP_TYPES,
  Operation,
  OperationLogEntry,
  OpType,
} from '../core/operation.types';
import { OperationWriteFlushService } from './operation-write-flush.service';
import { SyncImportConflictData } from './dialog-sync-import-conflict/dialog-sync-import-conflict.component';
import { isExampleTaskCreateOp } from '../validation/is-example-task-op.util';

/**
 * Enabling/configuring sync on a never-synced client necessarily writes the
 * sync config section before the first download. That setup-only operation is
 * not local user data divergence. Other GLOBAL_CONFIG sections remain protected.
 */
const isInitialSyncSetupOp = (entry: OperationLogEntry): boolean =>
  entry.op.actionType === ActionType.GLOBAL_CONFIG_UPDATE_SECTION &&
  entry.op.opType === OpType.Update &&
  entry.op.entityType === 'GLOBAL_CONFIG' &&
  entry.op.entityId === 'sync';

/**
 * A `misc` update whose only change is `uiPrefs` — SyncedUiPrefsService pushing
 * this browser's preferences up to the account.
 *
 * Never blocks an incoming import: preferences are not user data, and losing
 * them costs nothing because seedMissingFromLocal() re-adopts them on the next
 * start. Without this the app raised a conflict dialog over its own
 * housekeeping write, which is what a fresh browser met on first sign-in.
 */
const isSyncedUiPrefsOp = (entry: OperationLogEntry): boolean => {
  if (
    entry.op.actionType !== ActionType.GLOBAL_CONFIG_UPDATE_SECTION ||
    entry.op.opType !== OpType.Update ||
    entry.op.entityType !== 'GLOBAL_CONFIG' ||
    entry.op.entityId !== 'misc'
  ) {
    return false;
  }
  const action = extractActionPayload(entry.op.payload) as {
    sectionCfg?: Record<string, unknown>;
  };
  const keys = Object.keys(action?.sectionCfg ?? {});
  return keys.length === 1 && keys[0] === 'uiPrefs';
};

/**
 * Types a first launch writes for itself before anyone has used the app:
 * configuration sections, the sidebar menu tree, the empty planner. Furniture,
 * not content.
 *
 * Content types are deliberately absent — TASK, PROJECT, TAG, NOTE obviously,
 * but also TIME_TRACKING and SIMPLE_COUNTER, which record something a person
 * actually did. Someone who types a task or tracks a minute in the seconds
 * before the first sync completes has done real work, and it must still block
 * an incoming full-state import. The asymmetry is the whole point: this list
 * can only ever fail by asking too often, never by discarding what someone made.
 *
 * Only consulted on a client that has never completed an initial sync. Once
 * synced, a config change is a deliberate edit and counts like anything else.
 */
const BOOTSTRAP_ONLY_ENTITY_TYPES = new Set(['GLOBAL_CONFIG', 'MENU_TREE', 'PLANNER']);

const isFirstLaunchScaffolding = (
  entry: OperationLogEntry,
  hasCompletedInitialSync: boolean,
): boolean =>
  !hasCompletedInitialSync && BOOTSTRAP_ONLY_ENTITY_TYPES.has(entry.op.entityType);

/** Sections worth naming in the dialog. Anything else is noise to a person. */
const SUMMARY_SECTIONS: [key: string, label: string][] = [
  ['task', 'tasks'],
  ['project', 'projects'],
  ['tag', 'tags'],
  ['note', 'notes'],
];

/**
 * Counts what an incoming full-state payload actually contains.
 *
 * The dialog used to name a number of local changes and say nothing at all
 * about the other side, which made "Use Server Data" a leap of faith. The
 * payload is the server's whole state, so the answer is already in hand.
 */
const summarizeFullState = (op: Operation): { label: string; count: number }[] => {
  const raw = op.payload as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== 'object') return [];
  const state = ('appDataComplete' in raw ? raw.appDataComplete : raw) as Record<
    string,
    unknown
  >;
  if (!state || typeof state !== 'object') return [];

  const out: { label: string; count: number }[] = [];
  for (const [key, label] of SUMMARY_SECTIONS) {
    const section = state[key] as { ids?: unknown[] } | undefined;
    const count = Array.isArray(section?.ids) ? section.ids.length : 0;
    if (count > 0) out.push({ label, count });
  }
  return out;
};

/**
 * Groups the at-risk local ops by what a person would recognise — "3 tasks
 * changed" rather than seven opaque operations. Entity type is the only thing
 * every op reliably carries, so it is what we group on.
 */
const summarizePendingOps = (
  ops: OperationLogEntry[],
): { label: string; count: number }[] => {
  const byType = new Map<string, number>();
  for (const entry of ops) {
    const type = (entry.op.entityType || 'other').toLowerCase().replace(/_/g, ' ');
    byType.set(type, (byType.get(type) ?? 0) + 1);
  }
  return [...byType.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);
};

interface PendingOpClassificationOptions {
  hasCompletedInitialSync: boolean;
}

export interface IncomingFullStateConflictGateResult {
  fullStateOp?: Operation;
  pendingOps: OperationLogEntry[];
  hasMeaningfulPending: boolean;
  discardablePendingOpIds: string[];
  dialogData?: SyncImportConflictData;
}

/**
 * Decides whether an incoming full-state operation would discard meaningful local work.
 *
 * This service intentionally stops at detection: it reads pending local ops and builds
 * dialog data, but leaves dialog display and resolution side effects to
 * OperationLogSyncService. That keeps the same decision usable from both download
 * and piggyback-upload paths without coupling the gate to sync-provider actions.
 */
@Injectable({
  providedIn: 'root',
})
export class SyncImportConflictGateService {
  private opLogStore = inject(OperationLogStoreService);
  private writeFlushService = inject(OperationWriteFlushService);

  /**
   * Every pending op is user work unless it is an onboarding example-task create,
   * or the sync-section setup write on a client that has never completed sync.
   * Full-state ops are always meaningful because applying a newer full-state op
   * can invalidate their local import/repair semantics.
   *
   * The lifecycle default is deliberately conservative: a caller that does not
   * know whether initial sync completed must protect startup-entity changes.
   */
  hasMeaningfulPendingOps(
    ops: OperationLogEntry[],
    options: PendingOpClassificationOptions = {
      hasCompletedInitialSync: true,
    },
  ): boolean {
    return ops.some((entry) => {
      if (FULL_STATE_OP_TYPES.has(entry.op.opType as OpType)) {
        return true;
      }
      if (isExampleTaskCreateOp(entry)) {
        return false;
      }
      if (isInitialSyncSetupOp(entry)) {
        return options.hasCompletedInitialSync;
      }
      if (isSyncedUiPrefsOp(entry)) {
        return false;
      }
      // A never-synced client's own boot writes are not work to protect.
      // Without this, opening the app for the first time against a stack that
      // holds a full-state op raised a conflict dialog over furniture.
      if (isFirstLaunchScaffolding(entry, options.hasCompletedInitialSync)) {
        return false;
      }
      return true;
    });
  }

  getDiscardablePendingOpIds(
    ops: OperationLogEntry[],
    options: PendingOpClassificationOptions,
  ): string[] {
    return ops
      .filter(
        (entry) =>
          isExampleTaskCreateOp(entry) ||
          isSyncedUiPrefsOp(entry) ||
          (!options.hasCompletedInitialSync && isInitialSyncSetupOp(entry)) ||
          isFirstLaunchScaffolding(entry, options.hasCompletedInitialSync),
      )
      .map((entry) => entry.op.id);
  }

  /**
   * @param options.preCapturedPendingOps - Exact pending ops selected by the upload
   *        round, unioned with a live read. NOTE: accepted ops of the current round
   *        are still in the live set when this gate runs (acknowledgement is
   *        deferred until piggyback processing commits), so the union is NOT what
   *        protects them. Its own coverage is the narrower set of ops removed from
   *        the live set mid-upload: a local SYNC_IMPORT deleted on
   *        SYNC_IMPORT_EXISTS, full-state ops perma-rejected by the server, and a
   *        concurrent tab marking ops synced between lock release and this read.
   */
  async checkIncomingFullStateConflict(
    incomingOps: Operation[],
    options: {
      flushPendingWrites?: boolean;
      isNeverSynced?: boolean;
      preCapturedPendingOps?: OperationLogEntry[];
    } = {},
  ): Promise<IncomingFullStateConflictGateResult> {
    const fullStateOp = incomingOps.find((op) => FULL_STATE_OP_TYPES.has(op.opType));

    if (!fullStateOp) {
      return {
        pendingOps: [],
        hasMeaningfulPending: false,
        discardablePendingOpIds: [],
      };
    }

    if (options.flushPendingWrites) {
      // Download can race with captured operations that are not persisted yet.
      // Piggyback upload already flushed before uploading, so callers opt in only
      // when they need this second pre-check flush.
      await this.writeFlushService.flushPendingWrites();
    }

    const livePendingOps = await this.opLogStore.getUnsynced();
    const pendingOps = options.preCapturedPendingOps
      ? this._mergePendingOps(options.preCapturedPendingOps, livePendingOps)
      : livePendingOps;

    // Preserve the cheap example-task-only path. If nothing could be meaningful
    // even for a synced client, there is no reason to read sync history.
    const canContainMeaningfulPending = this.hasMeaningfulPendingOps(pendingOps);
    if (!canContainMeaningfulPending) {
      return {
        fullStateOp,
        pendingOps,
        hasMeaningfulPending: false,
        discardablePendingOpIds: this.getDiscardablePendingOpIds(livePendingOps, {
          hasCompletedInitialSync: true,
        }),
      };
    }

    const isNeverSynced =
      options.isNeverSynced ?? !(await this.opLogStore.hasSyncedOps());
    const classificationOptions = {
      hasCompletedInitialSync: !isNeverSynced,
    };
    const hasMeaningfulPending = this.hasMeaningfulPendingOps(
      pendingOps,
      classificationOptions,
    );
    // Only live pending ops may be rejected. A pre-captured upload snapshot can
    // include ops already acknowledged by the server, which must not be rewritten
    // as rejected locally.
    const discardablePendingOpIds = this.getDiscardablePendingOpIds(
      livePendingOps,
      classificationOptions,
    );

    const result = {
      fullStateOp,
      pendingOps,
      hasMeaningfulPending,
      discardablePendingOpIds,
    };

    if (!hasMeaningfulPending) {
      return result;
    }

    return {
      ...result,
      dialogData: {
        filteredOpCount: pendingOps.length,
        localImportTimestamp: fullStateOp.timestamp ?? Date.now(),
        syncImportReason: fullStateOp.syncImportReason,
        scenario: 'INCOMING_IMPORT',
        isNeverSynced,
        remoteSummary: summarizeFullState(fullStateOp),
        localSummary: summarizePendingOps(pendingOps),
      },
    };
  }

  private _mergePendingOps(
    uploadSnapshot: OperationLogEntry[],
    livePendingOps: OperationLogEntry[],
  ): OperationLogEntry[] {
    const merged = [...uploadSnapshot];
    const seenOpIds = new Set(uploadSnapshot.map((entry) => entry.op.id));

    for (const entry of livePendingOps) {
      if (!seenOpIds.has(entry.op.id)) {
        merged.push(entry);
        seenOpIds.add(entry.op.id);
      }
    }

    return merged;
  }
}

import { inject, Injectable } from '@angular/core';
import { OperationLogStoreService } from '../persistence/operation-log-store.service';
import { OpType, RepairSummary } from '../core/operation.types';
import { OpLog } from '../../core/log';
import { SnackService } from '../../core/snack/snack.service';
import { T } from '../../t.const';
import { DownloadCallback, RejectedOpInfo } from '../core/types/sync-results.types';
import { handleStorageQuotaError } from './sync-error-utils';
import { REPAIR_STALE_ERROR_CODE } from '../core/operation-log.const';
import { RepairOperationService } from '../validation/repair-operation.service';

const REPAIR_SUMMARY_KEYS: readonly (keyof RepairSummary)[] = [
  'entityStateFixed',
  'orphanedEntitiesRestored',
  'invalidReferencesRemoved',
  'relationshipsFixed',
  'structureRepaired',
  'typeErrorsFixed',
];

const getRepairSummary = (payload: unknown): RepairSummary | undefined => {
  if (typeof payload !== 'object' || payload === null) {
    return undefined;
  }
  const summary = (payload as Record<string, unknown>)['repairSummary'];
  if (typeof summary !== 'object' || summary === null) {
    return undefined;
  }
  const summaryRecord = summary as Record<string, unknown>;
  if (
    !REPAIR_SUMMARY_KEYS.every(
      (key) =>
        typeof summaryRecord[key] === 'number' &&
        Number.isFinite(summaryRecord[key]) &&
        (summaryRecord[key] as number) >= 0,
    )
  ) {
    return undefined;
  }
  return summaryRecord as unknown as RepairSummary;
};

// Re-export for consumers that import from this service
export type {
  DownloadResultForRejection,
  DownloadCallback,
  RejectedOpInfo,
} from '../core/types/sync-results.types';

/**
 * Result of handling rejected operations. Validation failure (if any during
 * a nested download) is surfaced via the SyncSessionValidationService latch
 * — the wrapper reads it once before deciding IN_SYNC vs ERROR. (#7330)
 */
export type RejectionHandlingResult =
  | {
      kind: 'completed';
      /** Number of replacement ops created (rebased repairs; these need to be uploaded) */
      mergedOpsCreated: number;
      /** Number of operations that were permanently rejected (validation errors, etc.) */
      permanentRejectionCount: number;
    }
  | {
      /** User cancelled a nested SYNC_IMPORT conflict dialog. */
      kind: 'cancelled';
    };

/**
 * Handles operations that were rejected by the server during upload.
 *
 * Responsibilities:
 * - Categorizing rejections (transient, duplicate, stale repair, permanent)
 * - Marking permanent rejections as rejected
 * - Rebasing a repair that was based on a stale server cursor
 *
 * This service is used by OperationLogSyncService after upload to handle
 * any operations that the server rejected.
 */
@Injectable({
  providedIn: 'root',
})
export class RejectedOpsHandlerService {
  private opLogStore = inject(OperationLogStoreService);
  private snackService = inject(SnackService);
  private repairOperationService = inject(RepairOperationService);

  /**
   * Handles operations that were rejected by the server.
   *
   * This is called AFTER processing piggybacked ops, so ops those already settled are skipped.
   *
   * @param rejectedOps - Operations rejected by the server with error messages
   * @param downloadCallback - Callback to download the server suffix before rebasing a stale repair
   * @returns Result with replacement ops count and permanent rejection count
   */
  async handleRejectedOps(
    rejectedOps: RejectedOpInfo[],
    downloadCallback?: DownloadCallback,
  ): Promise<RejectionHandlingResult> {
    if (rejectedOps.length === 0) {
      return {
        kind: 'completed',
        mergedOpsCreated: 0,
        permanentRejectionCount: 0,
      };
    }

    let mergedOpsCreated = 0;

    const permanentlyRejectedOps: string[] = [];
    const staleRepairOps: Array<{
      opId: string;
      repairSummary: RepairSummary;
      clientId: string;
    }> = [];

    for (const rejected of rejectedOps) {
      // Check for storage quota exceeded - show strong alert and skip marking as rejected
      // This is a critical error that requires user action
      if (rejected.errorCode === 'STORAGE_QUOTA_EXCEEDED') {
        OpLog.error(
          `RejectedOpsHandlerService: Storage quota exceeded - sync is broken!`,
        );
        handleStorageQuotaError(rejected.errorCode);
        // Don't mark as rejected - user needs to take action to fix storage
        continue;
      }

      // INTERNAL_ERROR = transient server error (transaction rollback, DB issue, etc.)
      // These should be retried on next sync, not permanently rejected
      if (rejected.errorCode === 'INTERNAL_ERROR') {
        OpLog.normal(
          `RejectedOpsHandlerService: Transient error for op ${rejected.opId}, will retry: ${rejected.error || 'unknown'}`,
        );
        continue;
      }

      if (rejected.errorCode === 'REPAIR_CAUSALITY_UNSUPPORTED') {
        throw new Error(
          'The configured sync server must be upgraded before automatic repairs can be uploaded safely.',
        );
      }

      // DUPLICATE_OPERATION = the operation already exists on the server.
      // This is NOT an error - it means the op was successfully uploaded before but the
      // client didn't record it as synced (e.g., network timeout after server accepted).
      // Mark it as synced so the client stops retrying.
      if (rejected.errorCode === 'DUPLICATE_OPERATION') {
        const dupEntry = await this.opLogStore.getOpById(rejected.opId);
        if (dupEntry && !dupEntry.syncedAt) {
          OpLog.normal(
            `RejectedOpsHandlerService: Op ${rejected.opId} already on server (duplicate), marking as synced`,
          );
          await this.opLogStore.markSynced([dupEntry.seq]);
        }
        continue;
      }

      const entry = await this.opLogStore.getOpById(rejected.opId);
      // Skip if:
      // - Op doesn't exist (was somehow removed)
      // - Op is already synced (was accepted after all)
      // - Op is already rejected
      if (!entry || entry.syncedAt || entry.rejectedAt) {
        continue;
      }

      if (
        rejected.errorCode === REPAIR_STALE_ERROR_CODE &&
        entry.op.opType === OpType.Repair
      ) {
        const repairSummary = getRepairSummary(entry.op.payload);
        if (!repairSummary) {
          throw new Error(
            `Cannot safely rebase REPAIR ${rejected.opId}: repair summary is missing or invalid.`,
          );
        }
        if (!downloadCallback) {
          throw new Error(
            `Cannot safely rebase REPAIR ${rejected.opId}: download callback is unavailable.`,
          );
        }
        staleRepairOps.push({
          opId: rejected.opId,
          repairSummary,
          clientId: entry.op.clientId,
        });
        OpLog.normal(
          `RejectedOpsHandlerService: Repair ${rejected.opId} was based on a stale server cursor; ` +
            'downloading the concurrent suffix before replacing it.',
        );
        continue;
      }

      permanentlyRejectedOps.push(rejected.opId);
      OpLog.normal(
        `RejectedOpsHandlerService: Marking op ${rejected.opId} as rejected: ${rejected.error || 'unknown error'}`,
      );
    }

    // Mark permanent rejections (validation errors, etc.) as rejected
    if (permanentlyRejectedOps.length > 0) {
      await this.opLogStore.markRejected(permanentlyRejectedOps);
      OpLog.normal(
        `RejectedOpsHandlerService: Marked ${permanentlyRejectedOps.length} server-rejected ops as rejected`,
      );
      this.snackService.open({
        type: 'ERROR',
        msg: T.F.SYNC.S.UPLOAD_OPS_REJECTED,
        translateParams: { count: permanentlyRejectedOps.length },
      });
    }

    if (staleRepairOps.length > 0) {
      if (!downloadCallback) {
        throw new Error(
          'Cannot safely rebase stale REPAIR: download callback is unavailable.',
        );
      }
      const staleRepairOpIds = staleRepairOps.map(({ opId }) => opId);
      const downloadResult = await downloadCallback({
        ignoredLocalFullStateOpIds: staleRepairOpIds,
      });
      if (downloadResult.kind === 'cancelled') {
        return downloadResult;
      }
      if (downloadResult.latestServerSeq === undefined) {
        throw new Error(
          'Cannot safely rebase stale REPAIR: downloaded server cursor is unavailable.',
        );
      }
      for (const staleRepair of staleRepairOps) {
        await this.repairOperationService.rebaseStaleRepair({
          staleRepairOpId: staleRepair.opId,
          repairSummary: staleRepair.repairSummary,
          clientId: staleRepair.clientId,
          repairBaseServerSeq: downloadResult.latestServerSeq,
        });
      }
      mergedOpsCreated += staleRepairOps.length;
    }

    return {
      kind: 'completed',
      mergedOpsCreated,
      permanentRejectionCount: permanentlyRejectedOps.length,
    };
  }
}

import { getSyncService } from './sync.service';
import { Logger } from '../logger';
import { DEFAULT_SYNC_CONFIG, MS_PER_DAY } from './sync.types';
import { DELETED_ENTITY_RETENTION_MS } from './deleted-entities';

let cleanupTimer: NodeJS.Timeout | null = null;
let initialCleanupTimer: NodeJS.Timeout | null = null;
const reconcileTimers: Set<NodeJS.Timeout> = new Set();

// Spread post-cleanup reconciles so we never run more than one
// calculateStorageUsage scan per RECONCILE_INTERVAL_MS across the whole pool.
// Bounded by 1h total budget — beyond that, drift is left for the next day.
const RECONCILE_INTERVAL_MS = 5_000;
const RECONCILE_BUDGET_MS = 60 * 60 * 1000;
const INITIAL_CLEANUP_DELAY_MS = 10_000;

/**
 * Runs all cleanup tasks in a single daily job.
 * Uses the unified retentionMs for all time-based cleanup.
 */
const runDailyCleanup = async (): Promise<void> => {
  const syncService = getSyncService();
  const cutoffTime = Date.now() - DEFAULT_SYNC_CONFIG.retentionMs;

  // 1. Delete history behind the checkpoints (anex: by checkpoint, not by age; see checkpoint-retention.ts)
  try {
    const { totalDeleted, affectedUserIds } =
      await syncService.deleteOldSyncedOpsForAllUsers();
    if (totalDeleted > 0) {
      Logger.info(
        `Cleanup [old-ops]: removed ${totalDeleted} entries (affected ${affectedUserIds.length} users)`,
      );
    }
    // Storage counter is maintained incrementally on uploads. Doing one full
    // pg_column_size scan per affected user inside this loop was a DoS — but
    // skipping reconcile entirely lets counters drift stale-high forever, so
    // every active user eventually hits the quota-miss reconcile path at the
    // same time. Spread reconciles over RECONCILE_BUDGET_MS instead: at most
    // one scan per RECONCILE_INTERVAL_MS, fire-and-forget.
    scheduleDeferredReconciles(affectedUserIds);
  } catch (error) {
    Logger.error(`Cleanup [old-ops] failed: ${error}`);
  }

  // 2. Delete stale devices (not seen within retention period)
  try {
    const deleted = await syncService.deleteStaleDevices(cutoffTime);
    if (deleted > 0) {
      Logger.info(`Cleanup [stale-devices]: removed ${deleted} entries`);
    }
  } catch (error) {
    Logger.error(`Cleanup [stale-devices] failed: ${error}`);
  }

  // 3. Delete the records of deletes older than their 7 days
  try {
    const deleted = await syncService.deleteOldDeleteRecords(
      Date.now() - DELETED_ENTITY_RETENTION_MS,
    );
    if (deleted > 0) {
      Logger.info(`Cleanup [delete-records]: removed ${deleted} entries`);
    }
  } catch (error) {
    Logger.error(`Cleanup [delete-records] failed: ${error}`);
  }

  // 4. Clean up expired rate limit counters
  try {
    const deleted = syncService.cleanupExpiredRateLimitCounters();
    if (deleted > 0) {
      Logger.info(`Cleanup [rate-limits]: removed ${deleted} entries`);
    }
  } catch (error) {
    Logger.error(`Cleanup [rate-limits] failed: ${error}`);
  }

  // 5. Clean up expired request deduplication entries
  try {
    const deleted = syncService.cleanupExpiredRequestDedupEntries();
    if (deleted > 0) {
      Logger.info(`Cleanup [request-dedup]: removed ${deleted} entries`);
    }
  } catch (error) {
    Logger.error(`Cleanup [request-dedup] failed: ${error}`);
  }
};

export const startCleanupJobs = (): void => {
  Logger.info('Starting daily cleanup job...');

  // Brief warmup before the first pass; the per-batch/per-run throttles in
  // deleteOldSyncedOpsForAllUsers keep the work bounded so this delay only
  // needs to cover startup tasks, not the cleanup itself.
  initialCleanupTimer = setTimeout(() => {
    initialCleanupTimer = null;
    void runDailyCleanup();
  }, INITIAL_CLEANUP_DELAY_MS);
  initialCleanupTimer.unref();

  // Schedule recurring daily cleanup
  cleanupTimer = setInterval(() => {
    void runDailyCleanup();
  }, MS_PER_DAY);
  cleanupTimer.unref();

  Logger.info('Daily cleanup job scheduled');
};

export const stopCleanupJobs = (): void => {
  if (initialCleanupTimer) {
    clearTimeout(initialCleanupTimer);
    initialCleanupTimer = null;
  }
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
  for (const t of reconcileTimers) clearTimeout(t);
  reconcileTimers.clear();
  Logger.info('Cleanup jobs stopped');
};

const scheduleDeferredReconciles = (userIds: number[]): void => {
  if (userIds.length === 0) return;
  const maxScheduled = Math.min(
    userIds.length,
    Math.floor(RECONCILE_BUDGET_MS / RECONCILE_INTERVAL_MS),
  );
  // `userIds` arrives in user-id order from `deleteOldSyncedOpsForAllUsers`.
  // When the budget can't cover everyone, the tail rolls over to the next
  // pass. Deterministic, no Math.random.
  if (maxScheduled < userIds.length) {
    Logger.warn(
      `Cleanup [reconcile]: budget covers ${maxScheduled}/${userIds.length} users; ` +
        `the rest roll over to the next pass`,
    );
  }
  const syncService = getSyncService();
  for (let i = 0; i < maxScheduled; i++) {
    const userId = userIds[i];
    let timer!: NodeJS.Timeout;
    timer = setTimeout(() => {
      reconcileTimers.delete(timer);
      void syncService.updateStorageUsage(userId).catch((err) => {
        Logger.warn(
          `Cleanup [reconcile] user=${userId} failed: ${
            err instanceof Error ? err.message : err
          }`,
        );
      });
    }, i * RECONCILE_INTERVAL_MS);
    timer.unref();
    reconcileTimers.add(timer);
  }
};

/**
 * StorageQuotaService - Handles storage quota calculations and checks
 *
 * Extracted from SyncService for better separation of concerns.
 * This service handles storage usage tracking and quota enforcement.
 *
 * Cleanup/freeing operations live here because they mutate quota accounting
 * and reconcile the cached storage counter.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { prisma } from '../../db';
import { Logger } from '../../logger';
import { parsePositiveIntegerEnv, storageLimitFromEnv } from '../../util/env';
import { APPROX_BYTES_PER_OP } from '../sync.const';
import { CAUSAL_FULL_STATE_OPERATION_WHERE } from '../sync.types';
import { planCheckpointRetention } from '../checkpoint-retention';

/**
 * Default storage quota per user in bytes (100MB).
 */
const DEFAULT_STORAGE_QUOTA_BYTES = 100 * 1024 * 1024;

/**
 * anex/self-hosted: SYNC_STORAGE_LIMIT (or the older STORAGE_QUOTA_BYTES), when set, is every account's quota and wins
 * over the per-user column. The column holds the 100MB hosted-service default, and a self-hosted op log filled that in a
 * month. Without the setting, raising it meant hand-editing the database.
 */
const effectiveQuotaBytes = (
  storedQuotaBytes: bigint | number | null | undefined,
): number => {
  const configured = storageLimitFromEnv();
  if (configured > 0) return configured;
  return Number(storedQuotaBytes ?? DEFAULT_STORAGE_QUOTA_BYTES);
};
const OLD_OPS_CLEANUP_DELETE_BATCH_SIZE = 5_000;
// Checkpoints read per account by the daily cleanup; at most one an hour, so 1,000 reach back weeks past the 7 kept days.
const MAX_CHECKPOINTS_READ = 1_000;
const OLD_OPS_CLEANUP_MAX_DELETED_PER_RUN = 25_000;
// Operator-DoS guardrail: a 1M `take:` materializes 1M ids in Node memory and
// then sends a 1M-element array param to Postgres — exactly the pressure the
// throttle is meant to avoid. Cap so misconfiguration can't unwind the bound.
const OLD_OPS_CLEANUP_DELETE_BATCH_SIZE_MAX = 50_000;
const OLD_OPS_CLEANUP_MAX_DELETED_PER_RUN_MAX = 1_000_000;

const getOldOpsCleanupDeleteBatchSize = (): number =>
  parsePositiveIntegerEnv(
    'OLD_OPS_CLEANUP_DELETE_BATCH_SIZE',
    OLD_OPS_CLEANUP_DELETE_BATCH_SIZE,
    OLD_OPS_CLEANUP_DELETE_BATCH_SIZE_MAX,
  );

const getOldOpsCleanupMaxDeletedPerRun = (): number =>
  parsePositiveIntegerEnv(
    'OLD_OPS_CLEANUP_MAX_DELETED_PER_RUN',
    OLD_OPS_CLEANUP_MAX_DELETED_PER_RUN,
    OLD_OPS_CLEANUP_MAX_DELETED_PER_RUN_MAX,
  );

export class StorageQuotaService {
  /**
   * Per-user in-process mutex for storage usage mutation windows.
   *
   * This service is documented as single-instance. Within that constraint, the
   * mutex prevents exact reconciles from racing with the two-phase upload path
   * (persist operation, then update the advisory counter). Without this, a slow
   * reconcile can overwrite or double-count concurrent upload deltas.
   */
  private storageUsageLocks: Map<number, Promise<void>> = new Map();
  private storageUsageLockContext = new AsyncLocalStorage<Set<number>>();

  /**
   * Per-user in-flight reconcile promises. When multiple concurrent requests
   * for the same user hit the quota cache-miss path, only the first triggers
   * the exact SUM(payload_bytes) reconcile; the rest await the same promise.
   * Sequential calls are unaffected (entry is deleted in `finally` before resolve).
   */
  private inflightReconciles: Map<number, Promise<void>> = new Map();

  /**
   * Per-user "exact reconcile required" markers. Set when a post-write counter
   * delta fails to persist (counter is now stale-low). The next quota check
   * for that user forces a `updateStorageUsage` scan before answering so the
   * drift self-heals instead of waiting for daily cleanup.
   */
  private forcedReconciles: Set<number> = new Set();

  async runWithStorageUsageLock<T>(userId: number, fn: () => Promise<T>): Promise<T> {
    const activeLocks = this.storageUsageLockContext.getStore();
    if (activeLocks?.has(userId)) {
      return fn();
    }

    const previous = this.storageUsageLocks.get(userId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.catch(() => undefined).then(() => current);
    this.storageUsageLocks.set(userId, queued);

    await previous.catch(() => undefined);

    const nextLocks = new Set(activeLocks ?? []);
    nextLocks.add(userId);

    try {
      return await this.storageUsageLockContext.run(nextLocks, fn);
    } finally {
      release();
      if (this.storageUsageLocks.get(userId) === queued) {
        this.storageUsageLocks.delete(userId);
      }
    }
  }

  /**
   * Calculate actual storage usage for a user by summing the write-time byte
   * counters on operation rows plus the cached snapshot blob length.
   *
   * SLOW PATH — DO NOT CALL PER REQUEST. Even without detoasting JSONB payloads,
   * this still scans one user's operation rows and is reserved for:
   *   1. Quota-cache reconciliation, run at most once per quota-cleanup event
   *      (rare per user) — see SyncService.freeStorageForUpload.
   *   2. Offline / admin reconciliation scripts.
   * Hot-path tracking uses incrementStorageUsage / decrementStorageUsage with
   * deltas computed locally on the Node side.
   *
   * Rows with payload_bytes=0 are pre-backfill rows. They must not be counted
   * as zero bytes: that would let a reconcile lower the cached counter below
   * actual usage. The CASE WHEN fallback only touches unbackfilled rows, so
   * once the one-time backfill completes this remains a cheap SUM.
   *
   * `hasUnbackfilledRows` is computed in the same single scan via BOOL_OR.
   * Callers (notably `updateStorageUsage`) treat the SUM as approximate when
   * this flag is true, because the fallback's UTF-8 length differs by single
   * bytes from the JS-side `computeOpStorageBytes` value used by the hot-path
   * counter. Skipping the `users.storage_used_bytes` write while unbackfilled
   * rows exist preserves the exact incremental counter.
   */
  async calculateStorageUsage(userId: number): Promise<{
    operationsBytes: number;
    snapshotBytes: number;
    totalBytes: number;
    hasUnbackfilledRows: boolean;
  }> {
    const usageResult = await prisma.$queryRaw<
      [
        {
          operations_bytes: bigint | null;
          snapshot_bytes: number | bigint | null;
          has_unbackfilled?: boolean | null;
        },
      ]
    >`
      SELECT
        ops.operations_bytes,
        ops.has_unbackfilled,
        COALESCE(
          (
            SELECT octet_length(snapshot_data)
            FROM user_sync_state
            WHERE user_id = ${userId}
          ),
          0
        )::bigint AS snapshot_bytes
      FROM (
        SELECT
          COALESCE(
            SUM(
              CASE
                WHEN payload_bytes > 0 THEN payload_bytes
                ELSE octet_length(payload::text)::bigint +
                     octet_length(vector_clock::text)::bigint
              END
            ),
            0
          )::bigint AS operations_bytes,
          COALESCE(BOOL_OR(payload_bytes = 0), false) AS has_unbackfilled
        FROM operations
        WHERE user_id = ${userId}
      ) AS ops
    `;

    const operationsBytes = Number(usageResult[0]?.operations_bytes ?? 0);
    const snapshotBytes = Number(usageResult[0]?.snapshot_bytes ?? 0);
    const totalBytes = operationsBytes + snapshotBytes;
    const hasUnbackfilledRows = Boolean(usageResult[0]?.has_unbackfilled ?? false);

    return {
      operationsBytes,
      snapshotBytes,
      totalBytes,
      hasUnbackfilledRows,
    };
  }

  /**
   * Atomically add `deltaBytes` to the cached storage usage. Called on every
   * accepted upload with a locally-computed payload size. No table scan.
   * Rejects non-finite / non-positive inputs so `BigInt(...)` never throws.
   */
  async incrementStorageUsage(userId: number, deltaBytes: number): Promise<void> {
    return this.runWithStorageUsageLock(userId, () =>
      this.incrementStorageUsageUnlocked(userId, deltaBytes),
    );
  }

  private async incrementStorageUsageUnlocked(
    userId: number,
    deltaBytes: number,
  ): Promise<void> {
    if (!Number.isFinite(deltaBytes) || deltaBytes <= 0) return;
    const delta = BigInt(Math.floor(deltaBytes));
    await prisma.user.update({
      where: { id: userId },
      data: { storageUsedBytes: { increment: delta } },
    });
  }

  /**
   * Atomically subtract `deltaBytes` from the cached storage usage, clamped to
   * zero. Uses $executeRaw for the GREATEST(...) clamp — Prisma's `decrement`
   * has no underflow guard and the counter is approximate (advisory quota), so
   * the floor protects against negative drift from rough estimates.
   */
  async decrementStorageUsage(userId: number, deltaBytes: number): Promise<void> {
    return this.runWithStorageUsageLock(userId, () =>
      this.decrementStorageUsageUnlocked(userId, deltaBytes),
    );
  }

  private async decrementStorageUsageUnlocked(
    userId: number,
    deltaBytes: number,
  ): Promise<void> {
    if (!Number.isFinite(deltaBytes) || deltaBytes <= 0) return;
    const delta = BigInt(Math.floor(deltaBytes));
    await prisma.$executeRaw`
      UPDATE users
      SET storage_used_bytes = GREATEST(storage_used_bytes - ${delta}::bigint, 0::bigint)
      WHERE id = ${userId}
    `;
  }

  /**
   * Check if a user has quota available for additional storage.
   * Uses cached storageUsedBytes for performance. If the user has a forced
   * reconcile marker (counter known stale), runs `updateStorageUsage` first
   * so the answer is based on truth rather than drift.
   */
  async checkStorageQuota(
    userId: number,
    additionalBytes: number,
  ): Promise<{ allowed: boolean; currentUsage: number; quota: number }> {
    if (this.forcedReconciles.has(userId)) {
      try {
        await this.updateStorageUsage(userId);
      } catch {
        // Fall through to the (still drifted) cached read; better to answer
        // optimistically than to fail the request.
      }
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { storageQuotaBytes: true, storageUsedBytes: true },
    });

    const quota = effectiveQuotaBytes(user?.storageQuotaBytes);
    const currentUsage = Number(user?.storageUsedBytes ?? 0);

    return {
      allowed: currentUsage + additionalBytes <= quota,
      currentUsage,
      quota,
    };
  }

  /**
   * Recompute the cached storage usage from scratch via calculateStorageUsage.
   * Same slow-path warning applies — see calculateStorageUsage.
   *
   * Concurrent calls for the same user dedupe to a single in-flight scan; see
   * `inflightReconciles`. Sequential callers (e.g. the cleanup loop inside
   * `freeStorageForUpload`) still get fresh results because the lock is
   * cleared in `finally` before the awaiter resolves.
   */
  async updateStorageUsage(userId: number): Promise<void> {
    // If we already hold the per-user lock (reentrant call from inside a
    // request that took the lock), skip the inflightReconciles dedupe map.
    // Otherwise we could await a promise registered by a non-reentrant caller
    // that is itself queued behind our own lock → deadlock.
    const inLock = this.storageUsageLockContext.getStore()?.has(userId);
    if (inLock) {
      const { totalBytes, hasUnbackfilledRows } =
        await this.calculateStorageUsage(userId);
      if (hasUnbackfilledRows) {
        // Pre-backfill rows make the SUM approximate (CASE-WHEN fallback uses
        // postgres-side text length, not JS-side computeOpStorageBytes). Writing
        // an approximate value here would replace the exact incrementally
        // maintained counter — drift in either direction. Leave the forced
        // reconcile marker so a post-backfill call self-heals.
        Logger.warn(
          `[user:${userId}] Skipping storage usage reconcile: payload_bytes backfill incomplete for this user.`,
        );
        return;
      }
      await prisma.user.update({
        where: { id: userId },
        data: { storageUsedBytes: BigInt(totalBytes) },
      });
      this.forcedReconciles.delete(userId);
      return;
    }

    const existing = this.inflightReconciles.get(userId);
    if (existing) return existing;

    const promise = this.runWithStorageUsageLock(userId, async () => {
      const { totalBytes, hasUnbackfilledRows } =
        await this.calculateStorageUsage(userId);
      if (hasUnbackfilledRows) {
        Logger.warn(
          `[user:${userId}] Skipping storage usage reconcile: payload_bytes backfill incomplete for this user.`,
        );
        return;
      }
      await prisma.user.update({
        where: { id: userId },
        data: { storageUsedBytes: BigInt(totalBytes) },
      });
      this.forcedReconciles.delete(userId);
    });
    this.inflightReconciles.set(userId, promise);
    try {
      return await promise;
    } finally {
      if (this.inflightReconciles.get(userId) === promise) {
        this.inflightReconciles.delete(userId);
      }
    }
  }

  /**
   * Mark a user as needing an exact reconcile before their next quota check.
   * Called when a post-write counter delta fails to persist (silent drift).
   */
  markNeedsReconcile(userId: number): void {
    this.forcedReconciles.add(userId);
  }

  /**
   * Whether the user has a pending forced reconcile (set by markNeedsReconcile,
   * cleared by a successful `updateStorageUsage`).
   */
  needsReconcile(userId: number): boolean {
    return this.forcedReconciles.has(userId);
  }

  /**
   * Clear per-user in-memory state. Call when user data is wiped (clean-slate,
   * account deletion) so stale references do not leak or trigger spurious work:
   *   - `inflightReconciles`: a stale rejected promise would block future
   *     reconciles via the dedupe map.
   *   - `forcedReconciles`: a stale marker would force an unnecessary scan on
   *     the next quota check after the wipe.
   * Do NOT delete `storageUsageLocks[userId]` here: the chain is identity-
   * guarded and self-deletes on drain (see `runWithStorageUsageLock`'s
   * `finally`). Removing the head while a follower is queued behind it would
   * let a fresh caller see no `previous` and start a concurrent chain that
   * races the in-flight one on the counter.
   * `storageUsageLockContext` is per-async-context (AsyncLocalStorage), not
   * per-user state — nothing to clear there.
   */
  clearForUser(userId: number): void {
    this.inflightReconciles.delete(userId);
    this.forcedReconciles.delete(userId);
  }

  /**
   * Backfill self-check. When SUPERSYNC_BATCH_UPLOAD=true the operator is
   * trusted to have set SUPERSYNC_PAYLOAD_BYTES_BACKFILL_COMPLETE=true only
   * after `npm run migrate-payload-bytes` finished. If the flag was flipped
   * too early, batch uploads still write `payload_bytes` correctly but the
   * SUM-based reconcile in `calculateStorageUsage` would mix exact bytes with
   * the CASE-WHEN fallback for legacy rows — small drift, but unnecessary
   * given the env-flag's whole purpose.
   *
   * One indexed-probe at startup closes the trust hole. The query relies on a
   * full table scan-with-LIMIT-1; for a fully backfilled table that is one
   * row visit on the first encountered row (cheap), and for a partially
   * backfilled table it returns immediately. Worst case (zero rows in
   * `operations`, e.g. fresh deployment) is also one round-trip.
   */
  async assertPayloadBytesBackfillComplete(): Promise<void> {
    const result = await prisma.$queryRaw<[{ exists: boolean }]>`
      SELECT EXISTS (
        SELECT 1 FROM operations WHERE payload_bytes = 0 LIMIT 1
      ) AS "exists"
    `;
    if (result[0]?.exists) {
      throw new Error(
        'SUPERSYNC_BATCH_UPLOAD is enabled but the operations table still ' +
          'contains rows with payload_bytes = 0. Run ' +
          '`npm run migrate-payload-bytes` to complete the backfill before ' +
          'setting SUPERSYNC_PAYLOAD_BYTES_BACKFILL_COMPLETE=true.',
      );
    }
  }

  /**
   * Daily cleanup (anex fork, Stage 7 of the container-authority work): deletes each account's history that syncing
   * no longer needs and that is not a daily restore point. The rule is in `checkpoint-retention.ts`; accounts with
   * fewer than two checkpoints keep everything. It replaced the upstream rule (older than the retention period and
   * covered by the server's readable snapshot), which never ran for encrypted accounts and kept 45 days of history,
   * far more than the storage limit holds when long notes are saved again on every edit.
   */
  async deleteOldSyncedOpsForAllUsers(): Promise<{
    totalDeleted: number;
    affectedUserIds: number[];
  }> {
    const states = await prisma.userSyncState.findMany({
      select: { userId: true },
      orderBy: { userId: 'asc' },
    });

    let totalDeleted = 0;
    const affectedUserIds: number[] = [];
    const deleteBatchSize = getOldOpsCleanupDeleteBatchSize();
    let remainingDeleteBudget = getOldOpsCleanupMaxDeletedPerRun();

    for (const state of states) {
      if (remainingDeleteBudget <= 0) break;

      // Only causal full states count: a legacy REPAIR without a base cursor is refused as a replay boundary
      // (LegacyRepairReplayUnsupportedError), so history behind it must not be deleted on its account.
      const checkpoints = await prisma.operation.findMany({
        where: { userId: state.userId, ...CAUSAL_FULL_STATE_OPERATION_WHERE },
        orderBy: { serverSeq: 'desc' },
        take: MAX_CHECKPOINTS_READ,
        select: { serverSeq: true, receivedAt: true },
      });
      const retention = planCheckpointRetention(
        checkpoints.map((checkpoint) => ({
          serverSeq: checkpoint.serverSeq,
          receivedAt: Number(checkpoint.receivedAt),
        })),
      );
      if (!retention) continue;

      // Page by serverSeq rather than filtering the kept checkpoints out in the query, so a page made only of kept
      // checkpoints still moves the cursor on.
      let userDeleted = 0;
      let afterSeq = 0;
      while (remainingDeleteBudget > 0) {
        const batchLimit = Math.min(deleteBatchSize, remainingDeleteBudget);
        const candidates = await prisma.operation.findMany({
          where: {
            userId: state.userId,
            serverSeq: { gt: afterSeq, lt: retention.keepAllFromSeq },
          },
          orderBy: { serverSeq: 'asc' },
          take: batchLimit,
          select: { id: true, serverSeq: true },
        });
        if (candidates.length === 0) break;
        afterSeq = candidates[candidates.length - 1].serverSeq;

        const doomedIds = candidates
          .filter((op) => !retention.keptCheckpointSeqs.has(op.serverSeq))
          .map((op) => op.id);
        if (doomedIds.length > 0) {
          const { count } = await prisma.operation.deleteMany({
            where: { userId: state.userId, id: { in: doomedIds } },
          });
          // Marked on the first deleting batch, not after the loop, so a later batch that throws still leaves the
          // counter to self-heal. storageUsedBytes stays stale-high until that exact reconcile: an approximate
          // decrement could undercount and let an account bypass its quota.
          if (userDeleted === 0 && count > 0) {
            affectedUserIds.push(state.userId);
            this.markNeedsReconcile(state.userId);
          }
          userDeleted += count;
          totalDeleted += count;
          remainingDeleteBudget -= count;
        }
        if (candidates.length < batchLimit) break;
      }

      if (userDeleted > 0) {
        await this.clearSnapshotCacheBefore(state.userId, retention.keepAllFromSeq);
      }
    }

    if (remainingDeleteBudget <= 0) {
      Logger.warn(
        `Cleanup [old-ops]: per-run budget exhausted after ${totalDeleted} ops; ` +
          `some users may still have retained old ops. ` +
          `Raise OLD_OPS_CLEANUP_MAX_DELETED_PER_RUN if this happens repeatedly.`,
      );
    }

    return { totalDeleted, affectedUserIds };
  }

  /**
   * The server's readable snapshot is a replay base for restores; one older than `keepAllFromSeq` now has changes
   * missing after it, so it is dropped (encrypted accounts never have one).
   */
  private async clearSnapshotCacheBefore(
    userId: number,
    keepAllFromSeq: number,
  ): Promise<void> {
    const cachedRow = await prisma.userSyncState.findUnique({
      where: { userId },
      select: { lastSnapshotSeq: true },
    });
    if (
      cachedRow?.lastSnapshotSeq == null ||
      cachedRow.lastSnapshotSeq >= keepAllFromSeq
    ) {
      return;
    }
    await prisma.userSyncState.update({
      where: { userId },
      data: { snapshotData: null, lastSnapshotSeq: null, snapshotAt: null },
    });
    Logger.info(
      `[user:${userId}] Cleared stale snapshot cache (was at seq ${cachedRow.lastSnapshotSeq}, history kept from ${keepAllFromSeq})`,
    );
  }

  /**
   * Delete oldest restore point and all operations before it to free up storage.
   * Used when storage quota is exceeded to make room for new uploads.
   *
   * Strategy:
   * - If 2+ restore points: Delete oldest restore point AND all ops with serverSeq <= its seq
   * - If 1 restore point: Delete all ops with serverSeq < its seq (keep the restore point)
   * - If 0 restore points: Nothing to delete, return failure
   *
   * @returns Object with deletedCount, approximate freedBytes, and success flag
   */
  async deleteOldestRestorePointAndOps(
    userId: number,
  ): Promise<{ deletedCount: number; freedBytes: number; success: boolean }> {
    // Find all restore points (full-state operations) ordered by serverSeq ASC
    const restorePoints = await prisma.operation.findMany({
      where: {
        userId,
        ...CAUSAL_FULL_STATE_OPERATION_WHERE,
      },
      orderBy: { serverSeq: 'asc' },
      select: { serverSeq: true, opType: true },
      take: 2,
    });

    if (restorePoints.length === 0) {
      Logger.warn(`[user:${userId}] No restore points found, cannot free storage`);
      return { deletedCount: 0, freedBytes: 0, success: false };
    }

    const oldestRestorePoint = restorePoints[0];
    let deleteUpToSeq: number;

    if (restorePoints.length >= 2) {
      // Delete the oldest restore point AND all ops up to and including it
      deleteUpToSeq = oldestRestorePoint.serverSeq;
      Logger.info(
        `[user:${userId}] Deleting oldest restore point (seq=${deleteUpToSeq}) and all ops before it`,
      );
    } else {
      // Only one restore point - delete all ops BEFORE it, but keep the restore point
      deleteUpToSeq = oldestRestorePoint.serverSeq - 1;
      Logger.info(
        `[user:${userId}] Keeping single restore point (seq=${oldestRestorePoint.serverSeq}), deleting ops before it`,
      );
    }

    if (deleteUpToSeq < 1) {
      Logger.info(`[user:${userId}] No ops to delete (deleteUpToSeq=${deleteUpToSeq})`);
      return { deletedCount: 0, freedBytes: 0, success: false };
    }

    // Full-state ops (SYNC_IMPORT/BACKUP_IMPORT/REPAIR) can be up to 20MB each,
    // so the APPROX_BYTES_PER_OP=1024 fallback used for delta ops would undercount
    // by ~20000x and leave the cached counter permanently low if a reconcile
    // failure later rolls back to that figure. Use the write-time payload_bytes
    // value so cleanup accounting matches quota reconciliation without
    // detoasting JSONB payloads.
    const fullStateRows = await prisma.$queryRaw<
      Array<{ exact_bytes: bigint | null; full_state_count: bigint }>
    >`
      SELECT
        COALESCE(SUM(payload_bytes), 0) AS exact_bytes,
        COUNT(*)::bigint AS full_state_count
      FROM operations
      WHERE user_id = ${userId}
        AND server_seq <= ${deleteUpToSeq}
        AND op_type IN ('SYNC_IMPORT', 'BACKUP_IMPORT', 'REPAIR')
    `;
    const fullStateExactBytes = Number(fullStateRows[0]?.exact_bytes ?? 0);
    const fullStateCount = Number(fullStateRows[0]?.full_state_count ?? 0);

    // Delete the operations
    const result = await prisma.operation.deleteMany({
      where: {
        userId,
        serverSeq: { lte: deleteUpToSeq },
      },
    });

    // freedBytes is split: exact size for the 0-1 restore-point rows just
    // measured (catches the 20MB-ish payloads that the APPROX_BYTES_PER_OP
    // approximation undercounts by ~20000x), plus the approximate
    // count*APPROX_BYTES_PER_OP for the remaining delta ops (median 150-300B
    // — modest over-estimate so the cleanup loop progresses without scanning
    // every delta payload). Reconciled to exact value once at the end of
    // freeStorageForUpload via a single updateStorageUsage call.
    const deltaOpsCount = Math.max(0, result.count - fullStateCount);
    const freedBytes = fullStateExactBytes + deltaOpsCount * APPROX_BYTES_PER_OP;

    if (result.count > 0) {
      // Clear stale snapshot cache if it references deleted operations
      const cachedRow = await prisma.userSyncState.findUnique({
        where: { userId },
        select: { lastSnapshotSeq: true },
      });

      if (cachedRow?.lastSnapshotSeq && cachedRow.lastSnapshotSeq <= deleteUpToSeq) {
        await prisma.userSyncState.update({
          where: { userId },
          data: {
            snapshotData: null,
            lastSnapshotSeq: null,
            snapshotAt: null,
          },
        });
        Logger.info(
          `[user:${userId}] Cleared stale snapshot cache (was at seq ${cachedRow.lastSnapshotSeq}, deleted up to ${deleteUpToSeq})`,
        );
      }

      // Decrement counter by the approximate freed bytes so freeStorageForUpload
      // can detect progress. Final accuracy is restored by the single
      // updateStorageUsage call at the end of freeStorageForUpload.
      await this.decrementStorageUsage(userId, freedBytes);
      Logger.info(
        `[user:${userId}] Deleted ${result.count} ops (approx freed ~${Math.round(freedBytes / 1024)}KB)`,
      );
    }

    return {
      deletedCount: result.count,
      freedBytes,
      success: result.count > 0,
    };
  }

  /**
   * Iteratively delete old restore points and operations until enough storage
   * space is available for the requested upload. Always keeps at least one
   * restore point and all operations after it (minimum valid sync state).
   *
   * @param userId - User ID
   * @param requiredBytes - Number of bytes needed for the upload
   * @returns Object with success status and cleanup statistics
   */
  async freeStorageForUpload(
    userId: number,
    requiredBytes: number,
  ): Promise<{
    success: boolean;
    freedBytes: number;
    deletedRestorePoints: number;
    deletedOps: number;
  }> {
    let totalFreedBytes = 0;
    let deletedRestorePoints = 0;
    let totalDeletedOps = 0;

    const MAX_CLEANUP_ITERATIONS = 50;
    let iterations = 0;

    // Reconcile the approximate counter once at the end via a single
    // calculateStorageUsage scan. Slow but bounded to a single user per
    // quota-cleanup event (not per upload like the previous regression).
    //
    // If reconcile fails we must NOT leave the counter at its post-decrement
    // (artificially low) value — that would let the user bypass quota until
    // the next successful reconcile. Roll the optimistic decrement back so the
    // counter returns to its pre-cleanup state (which was correctly tracked by
    // incremental upload deltas).
    const reconcileCounter = async (): Promise<boolean> => {
      try {
        await this.updateStorageUsage(userId);
        return true;
      } catch (err) {
        Logger.warn(
          `[user:${userId}] Failed to reconcile storage usage after cleanup: ${
            (err as Error).message
          }`,
        );
        return false;
      }
    };
    const reconcileOrRollback = async (): Promise<void> => {
      const ok = await reconcileCounter();
      if (!ok && totalFreedBytes > 0) {
        try {
          await this.incrementStorageUsage(userId, totalFreedBytes);
          Logger.warn(
            `[user:${userId}] Rolled back ${totalFreedBytes} bytes of optimistic cleanup decrement after reconcile failure`,
          );
        } catch (err) {
          Logger.error(
            `[user:${userId}] Failed to roll back cleanup decrement: ${
              (err as Error).message
            }`,
          );
        }
      }
    };

    // Keep trying until we have enough space or hit minimum
    while (iterations < MAX_CLEANUP_ITERATIONS) {
      iterations++;

      // Check if we now have enough space. The cached counter may have been
      // moved by approximate count*const deletes, so verify once with the exact
      // reconciled counter before declaring success.
      const quotaCheck = await this.checkStorageQuota(userId, requiredBytes);
      if (quotaCheck.allowed) {
        // On the success-path we want fresh truth, but if reconcile fails we
        // also want the rollback (otherwise we'd be making the success
        // decision against an artificially-low counter).
        await reconcileOrRollback();
        const reconciledQuotaCheck = await this.checkStorageQuota(userId, requiredBytes);
        if (reconciledQuotaCheck.allowed) {
          return {
            success: true,
            freedBytes: totalFreedBytes,
            deletedRestorePoints,
            deletedOps: totalDeletedOps,
          };
        }
        Logger.warn(
          `[user:${userId}] Storage still exceeded after exact reconcile: ` +
            `${reconciledQuotaCheck.currentUsage}/${reconciledQuotaCheck.quota} bytes`,
        );
      }

      // Only need to know whether at least two restore points remain.
      const restorePoints = await prisma.operation.findMany({
        where: {
          userId,
          ...CAUSAL_FULL_STATE_OPERATION_WHERE,
        },
        orderBy: { serverSeq: 'asc' },
        select: { serverSeq: true },
        take: 2,
      });

      // Minimum: 1 restore point + all ops after it
      // If we only have 1 or fewer restore points, we can't delete any more
      if (restorePoints.length <= 1) {
        Logger.warn(
          `[user:${userId}] Cannot free more storage: only ${restorePoints.length} restore point(s) remaining`,
        );
        await reconcileOrRollback();
        return {
          success: false,
          freedBytes: totalFreedBytes,
          deletedRestorePoints,
          deletedOps: totalDeletedOps,
        };
      }

      // Delete oldest restore point + all ops before it
      const result = await this.deleteOldestRestorePointAndOps(userId);
      if (!result.success) {
        await reconcileOrRollback();
        return {
          success: false,
          freedBytes: totalFreedBytes,
          deletedRestorePoints,
          deletedOps: totalDeletedOps,
        };
      }

      totalFreedBytes += result.freedBytes;
      deletedRestorePoints++;
      totalDeletedOps += result.deletedCount;

      Logger.info(
        `[user:${userId}] Auto-cleanup iteration: freed ${Math.round(result.freedBytes / 1024)}KB, ` +
          `${restorePoints.length - 1} restore point(s) remaining in current cleanup window`,
      );
    }

    // Exhausted max iterations without freeing enough space
    Logger.warn(
      `[user:${userId}] Storage cleanup exceeded max iterations (${MAX_CLEANUP_ITERATIONS})`,
    );
    await reconcileOrRollback();
    return {
      success: false,
      freedBytes: totalFreedBytes,
      deletedRestorePoints,
      deletedOps: totalDeletedOps,
    };
  }

  /**
   * Get storage quota and usage for a user.
   * Used by status endpoint.
   */
  async getStorageInfo(userId: number): Promise<{
    storageUsedBytes: number;
    storageQuotaBytes: number;
  }> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { storageQuotaBytes: true, storageUsedBytes: true },
    });

    return {
      storageUsedBytes: Number(user?.storageUsedBytes ?? 0),
      storageQuotaBytes: effectiveQuotaBytes(user?.storageQuotaBytes),
    };
  }
}

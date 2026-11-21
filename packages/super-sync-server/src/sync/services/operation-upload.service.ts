import { Prisma } from '@prisma/client';
import { Logger } from '../../logger';
import {
  CLIENT_ID_REGEX,
  computeOpStorageBytes,
  MAX_CLIENT_ID_LENGTH,
} from '../sync.const';
import {
  AcceptedBatchOperation,
  BatchUploadCandidate,
  CAUSAL_FULL_STATE_OPERATION_WHERE,
  DEFAULT_SYNC_CONFIG,
  DUPLICATE_OP_SELECT,
  isCausalFullStateOperation,
  limitVectorClockSize,
  MAX_VECTOR_CLOCK_SIZE,
  Operation,
  OP_TYPES,
  ProcessOperationResult,
  SyncConfig,
  SYNC_ERROR_CODES,
  UploadResult,
  VectorClock,
} from '../sync.types';
import {
  getStoredEntityIds,
  isSameDuplicateOperation,
  isSameIncomingOperation,
  pruneVectorClockForStorage,
} from '../stored-operation';
import { parsePersistedVectorClock } from './operation-download.service';
import {
  ALLOWED_ENTITY_TYPES,
  ValidationService,
  type ValidationResult,
} from './validation.service';

// Observability threshold: log a warning when the full-state op aggregate scan
// exceeds this duration. Mirrors the threshold used by the legacy snapshot
// vector-clock aggregate in OperationDownloadService so production logs use a
// consistent slow-aggregate signal.
const SLOW_FULL_STATE_AGGREGATE_MS = 5_000;
const INVALID_AUDIT_FIELD = '[invalid]';
const SAFE_AUDIT_ID_REGEX = /^[A-Za-z0-9_-]+$/;

const isSafeAuditIdentifier = (value: unknown, maxLength: number): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= maxLength &&
  SAFE_AUDIT_ID_REGEX.test(value);

const getSafeAuditOperationMetadata = (
  op: Operation,
): { opId: string; entityType: string; entityId?: string; opType: string } => {
  const rawOp = op as unknown as Record<string, unknown>;
  const rawOpId = rawOp['id'];
  const rawEntityType = rawOp['entityType'];
  const rawEntityId = rawOp['entityId'];
  const rawOpType = rawOp['opType'];

  return {
    opId: isSafeAuditIdentifier(rawOpId, 255) ? rawOpId : INVALID_AUDIT_FIELD,
    entityType:
      typeof rawEntityType === 'string' && ALLOWED_ENTITY_TYPES.has(rawEntityType)
        ? rawEntityType
        : INVALID_AUDIT_FIELD,
    entityId:
      rawEntityId === undefined || rawEntityId === null
        ? undefined
        : isSafeAuditIdentifier(rawEntityId, 255)
          ? rawEntityId
          : INVALID_AUDIT_FIELD,
    opType:
      typeof rawOpType === 'string' && OP_TYPES.includes(rawOpType as Operation['opType'])
        ? rawOpType
        : INVALID_AUDIT_FIELD,
  };
};

const getSafeAuditClientId = (clientId: string): string =>
  clientId.length <= MAX_CLIENT_ID_LENGTH && CLIENT_ID_REGEX.test(clientId)
    ? clientId
    : INVALID_AUDIT_FIELD;

const toSafeServerSeq = (value: number | bigint | undefined, userId: number): number => {
  if (typeof value === 'bigint') {
    if (value < BigInt(0) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`Unsafe last_seq value returned for user ${userId}`);
    }
    const asNumber = Number(value);
    if (BigInt(asNumber) !== value) {
      throw new Error(`Precision-losing last_seq value returned for user ${userId}`);
    }
    return asNumber;
  }

  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }

  throw new Error(`Invalid last_seq value returned for user ${userId}`);
};

export class OperationUploadService {
  constructor(
    private readonly validationService: ValidationService,
    private readonly config: SyncConfig = DEFAULT_SYNC_CONFIG,
  ) {}

  private clampFutureTimestamp(
    userId: number,
    clientId: string,
    op: Operation,
    now: number,
  ): number {
    const originalTimestamp = op.timestamp;
    const maxAllowedTimestamp = now + this.config.maxClockDriftMs;
    if (op.timestamp > maxAllowedTimestamp) {
      op.timestamp = maxAllowedTimestamp;
      Logger.audit({
        event: 'TIMESTAMP_CLAMPED',
        userId,
        clientId: getSafeAuditClientId(clientId),
        ...getSafeAuditOperationMetadata(op),
        originalTimestamp,
        clampedTo: maxAllowedTimestamp,
        driftMs: originalTimestamp - now,
      });
    }
    return originalTimestamp;
  }

  private rejectedUploadResult(
    userId: number,
    clientId: string,
    op: Operation,
    error: string | undefined,
    errorCode: UploadResult['errorCode'],
    existingClock?: VectorClock,
    storedServerSeq?: number,
  ): UploadResult {
    Logger.audit({
      event: 'OP_REJECTED',
      userId,
      clientId: getSafeAuditClientId(clientId),
      ...getSafeAuditOperationMetadata(op),
      errorCode,
      reason: errorCode ?? 'OP_REJECTED',
    });

    return {
      opId: op.id,
      accepted: false,
      // A save stored before: its number, so a browser whose first answer was lost still learns where it stands.
      ...(storedServerSeq !== undefined ? { serverSeq: storedServerSeq } : {}),
      error,
      errorCode,
      existingClock,
    };
  }

  /**
   * Aggregate the per-client max vector_clock counter over all operations for
   * `userId` with `server_seq < beforeServerSeq`. Used at full-state op upload
   * time so the persisted `latest_full_state_vector_clock` reflects every
   * client whose ops may still live in conflict detection — not just the
   * clients named on the snapshot op itself.
   *
   * Logs a warning when the scan exceeds `SLOW_FULL_STATE_AGGREGATE_MS` so
   * pathological histories (millions of ops, cleanup retention too long) are
   * observable in production before they approach the 60s upload-tx timeout.
   */
  private async _aggregatePriorVectorClock(
    tx: Prisma.TransactionClient,
    userId: number,
    beforeServerSeq: number,
  ): Promise<VectorClock> {
    const startedAt = Date.now();
    const rows = await tx.$queryRaw<Array<{ client_id: string; max_counter: bigint }>>`
      SELECT kv.key AS client_id, MAX(kv.value::bigint) AS max_counter
      FROM operations, LATERAL jsonb_each_text(vector_clock) AS kv(key, value)
      WHERE user_id = ${userId}
        AND server_seq < ${beforeServerSeq}
        AND jsonb_typeof(vector_clock) = 'object'
        AND kv.value ~ '^[0-9]+$'
      GROUP BY kv.key
    `;
    const out: VectorClock = {};
    for (const row of rows) {
      out[row.client_id] = Number(row.max_counter);
    }
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs > SLOW_FULL_STATE_AGGREGATE_MS) {
      Logger.warn(
        `[user:${userId}] Full-state op aggregate scan took ${elapsedMs}ms ` +
          `(${rows.length} clients, beforeSeq=${beforeServerSeq}); approaching ` +
          `upload-tx timeout. Investigate history size and cleanup retention.`,
      );
    }
    return out;
  }

  /**
   * Aggregate the prior vector clock, merge the full-state op's clock into it
   * (max per client) and persist it as the user's latest-full-state marker.
   * Shared by the batch and legacy per-op paths so the aggregate-and-merge
   * semantics cannot drift between them. Costs 3 DB round trips (the aggregate
   * scan, the previous marker read and the userSyncState update).
   *
   * anex: the previous persisted clock is merged in as well. The daily cleanup
   * deletes history behind the checkpoints (checkpoint-retention.ts), so the
   * aggregate alone would forget devices only seen there; the previous clock
   * still holds them. Over a complete history this adds nothing the aggregate
   * lacks, since clocks only grow; a clean slate resets the marker to null.
   */
  private async persistMergedFullStateClock(
    tx: Prisma.TransactionClient,
    userId: number,
    serverSeq: number,
    opClock: VectorClock,
  ): Promise<void> {
    const priorAggregate = await this._aggregatePriorVectorClock(tx, userId, serverSeq);
    const previousMarker = await tx.userSyncState.findUnique({
      where: { userId },
      select: { latestFullStateVectorClock: true },
    });
    const mergedClock: VectorClock = {
      ...(parsePersistedVectorClock(previousMarker?.latestFullStateVectorClock) ?? {}),
    };
    for (const clock of [priorAggregate, opClock]) {
      for (const [clientId, counter] of Object.entries(clock)) {
        mergedClock[clientId] = Math.max(mergedClock[clientId] ?? 0, counter);
      }
    }
    await tx.userSyncState.update({
      where: { userId },
      data: {
        latestFullStateSeq: serverSeq,
        latestFullStateVectorClock: mergedClock as Prisma.InputJsonValue,
      },
    });
  }

  /**
   * Memoizes the causal full-state author per upload transaction. The answer can
   * only change when THIS transaction accepts a causal full-state op, which
   * {@link noteFullStateAuthor} folds back in — so one query per transaction is
   * enough. Keyed by the `tx` client (a fresh short-lived object per
   * `$transaction`), so entries cannot outlive the request that created them.
   */
  private readonly fullStateAuthorByTx = new WeakMap<
    Prisma.TransactionClient,
    { author: string | undefined }
  >();

  /**
   * The latest causal full-state author remains a required clock edge for
   * post-import operations. If pruning drops that low-counter entry, clients
   * at the boundary classify the operation as concurrent and filter it out.
   *
   * Resolved lazily: only an op whose clock actually overflows pays for it.
   */
  private async resolveFullStateAuthor(
    tx: Prisma.TransactionClient,
    userId: number,
  ): Promise<string | undefined> {
    const memoized = this.fullStateAuthorByTx.get(tx);
    if (memoized) {
      return memoized.author;
    }
    const latestFullStateOp = await tx.operation.findFirst({
      where: { userId, ...CAUSAL_FULL_STATE_OPERATION_WHERE },
      orderBy: { serverSeq: 'desc' },
      select: { clientId: true },
    });
    const author = latestFullStateOp?.clientId;
    this.fullStateAuthorByTx.set(tx, { author });
    return author;
  }

  /**
   * Records a causal full-state op accepted earlier in this same transaction, so
   * later ops protect the new author without re-reading (and without depending on
   * read-your-writes visibility).
   */
  private noteFullStateAuthor(tx: Prisma.TransactionClient, clientId: string): void {
    this.fullStateAuthorByTx.set(tx, { author: clientId });
  }

  /**
   * Protected clock IDs for storage: the uploader, plus the active causal
   * full-state author when the clock is actually oversized. Under-limit clocks are
   * never pruned, so they need no lookup at all.
   */
  private async getPruneProtectedIds(
    tx: Prisma.TransactionClient,
    userId: number,
    op: Operation,
  ): Promise<string[]> {
    if (Object.keys(op.vectorClock).length <= MAX_VECTOR_CLOCK_SIZE) {
      return [];
    }
    const author = await this.resolveFullStateAuthor(tx, userId);
    return author ? [author] : [];
  }

  async processOperationBatch(
    userId: number,
    clientId: string,
    ops: Operation[],
    now: number,
    tx: Prisma.TransactionClient,
    prevalidatedResults?: ReadonlyMap<Operation, ValidationResult>,
    requestStartOccupiedIds?: ReadonlySet<string>,
  ): Promise<{
    results: UploadResult[];
    acceptedDeltaBytes: number;
    unserializableAccepted: number;
    dbRoundtrips: number;
  }> {
    const results = new Array<UploadResult>(ops.length);
    let dbRoundtrips = 0;

    // Pipeline: validate+clamp -> intra-batch dedupe -> classify existing
    // duplicates -> reserve seq + insert -> full-state
    // clock. Each stage writes terminal rejections into `results` by index
    // and passes the surviving candidates forward; the two empty-set guards
    // short-circuit exactly as the original single function did.
    const validatedCandidates = this.validateAndClampBatch(
      userId,
      clientId,
      ops,
      now,
      results,
      prevalidatedResults,
    );

    // Intra-batch duplicate ids were already terminally rejected in stage 1:
    // validateAndClampBatch reserves each id on first occurrence (including
    // invalid first siblings), so validatedCandidates is unique by op id.
    const uniqueCandidates = validatedCandidates;

    if (uniqueCandidates.length === 0) {
      return {
        results: results as UploadResult[],
        acceptedDeltaBytes: 0,
        unserializableAccepted: 0,
        dbRoundtrips,
      };
    }

    const classified = await this.classifyExistingDuplicates(
      userId,
      clientId,
      uniqueCandidates,
      tx,
      results,
      requestStartOccupiedIds,
    );
    dbRoundtrips += classified.dbRoundtrips;
    const duplicateFreeCandidates = classified.duplicateFreeCandidates;

    const { accepted, acceptedDeltaBytes, unserializableAccepted } =
      await this.acceptBatchCandidates(userId, duplicateFreeCandidates, tx);

    if (accepted.length === 0) {
      return {
        results: results as UploadResult[],
        acceptedDeltaBytes: 0,
        unserializableAccepted: 0,
        dbRoundtrips,
      };
    }

    dbRoundtrips += await this.reserveSeqAndInsert(userId, clientId, accepted, now, tx);

    dbRoundtrips += await this.persistBatchFullStateClock(userId, accepted, tx);

    for (const acceptedOp of accepted) {
      results[acceptedOp.resultIndex] = {
        opId: acceptedOp.op.id,
        accepted: true,
        serverSeq: acceptedOp.serverSeq,
      };
    }

    return {
      results: results as UploadResult[],
      acceptedDeltaBytes,
      unserializableAccepted,
      dbRoundtrips,
    };
  }

  /**
   * Stage 1: reserve each transport-level operation ID, clamp timestamps, and
   * validate every first occurrence in memory (no DB). Invalid first ops and
   * every later same-ID sibling get terminal results by index.
   */
  private validateAndClampBatch(
    userId: number,
    clientId: string,
    ops: Operation[],
    now: number,
    results: UploadResult[],
    prevalidatedResults?: ReadonlyMap<Operation, ValidationResult>,
  ): BatchUploadCandidate[] {
    const validatedCandidates: BatchUploadCandidate[] = [];
    const firstOperationById = new Map<
      string,
      { op: Operation; originalTimestamp: number }
    >();
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      const originalTimestamp = this.clampFutureTimestamp(userId, clientId, op, now);
      const firstOperation = firstOperationById.get(op.id);
      if (firstOperation) {
        const isExactRetry = isSameIncomingOperation(
          firstOperation.op,
          op,
          firstOperation.originalTimestamp,
          originalTimestamp,
        );
        results[i] = this.rejectedUploadResult(
          userId,
          clientId,
          op,
          isExactRetry
            ? 'Duplicate operation ID'
            : 'Operation ID already belongs to a different operation',
          isExactRetry
            ? SYNC_ERROR_CODES.DUPLICATE_OPERATION
            : SYNC_ERROR_CODES.INVALID_OP_ID,
        );
        continue;
      }
      firstOperationById.set(op.id, { op, originalTimestamp });

      const validation =
        prevalidatedResults?.get(op) ?? this.validationService.validateOp(op, clientId);

      if (!validation.valid) {
        results[i] = this.rejectedUploadResult(
          userId,
          clientId,
          op,
          validation.error,
          validation.errorCode,
        );
        continue;
      }

      validatedCandidates.push({
        op,
        resultIndex: i,
        originalTimestamp,
        fullStateVectorClock: isCausalFullStateOperation(op)
          ? { ...op.vectorClock }
          : undefined,
        payloadBytes: validation.payloadBytes,
      });
    }
    return validatedCandidates;
  }

  /**
   * Stage 3: prefetch any currently persisted ops sharing an incoming id (one
   * query) and classify each as an idempotent retry (DUPLICATE_OPERATION) or
   * an id collision with different content (INVALID_OP_ID). If quota cleanup
   * removed a row after the route's occupancy check, the request-start set
   * still rejects that ID rather than letting it consume unestimated storage.
   * Survivors are returned for storage.
   */
  private async classifyExistingDuplicates(
    userId: number,
    clientId: string,
    uniqueCandidates: BatchUploadCandidate[],
    tx: Prisma.TransactionClient,
    results: UploadResult[],
    requestStartOccupiedIds?: ReadonlySet<string>,
  ): Promise<{
    duplicateFreeCandidates: BatchUploadCandidate[];
    dbRoundtrips: number;
  }> {
    const existingOps = await tx.operation.findMany({
      where: { id: { in: uniqueCandidates.map((candidate) => candidate.op.id) } },
      select: DUPLICATE_OP_SELECT,
    });
    const existingOpById = new Map(
      existingOps.map((existingOp) => [existingOp.id, existingOp]),
    );

    const duplicateFreeCandidates: BatchUploadCandidate[] = [];
    for (const candidate of uniqueCandidates) {
      const existingOp = existingOpById.get(candidate.op.id);
      if (!existingOp) {
        if (requestStartOccupiedIds?.has(candidate.op.id)) {
          results[candidate.resultIndex] = this.rejectedUploadResult(
            userId,
            clientId,
            candidate.op,
            'Operation ID was already occupied before quota enforcement',
            SYNC_ERROR_CODES.INVALID_OP_ID,
          );
          continue;
        }
        duplicateFreeCandidates.push(candidate);
        continue;
      }

      if (
        !isSameDuplicateOperation(
          existingOp,
          userId,
          candidate.op,
          this.config.maxClockDriftMs,
          candidate.originalTimestamp,
        )
      ) {
        results[candidate.resultIndex] = this.rejectedUploadResult(
          userId,
          clientId,
          candidate.op,
          'Operation ID already belongs to a different operation',
          SYNC_ERROR_CODES.INVALID_OP_ID,
        );
        continue;
      }

      results[candidate.resultIndex] = this.rejectedUploadResult(
        userId,
        clientId,
        candidate.op,
        'Duplicate operation ID',
        SYNC_ERROR_CODES.DUPLICATE_OPERATION,
        undefined,
        existingOp.serverSeq,
      );
    }
    return { duplicateFreeCandidates, dbRoundtrips: 1 };
  }

  /**
   * Stage 4: every valid op is stored in arrival order (anex, Stage 9). Another device's change to the same item is no
   * reason to refuse: browsers and the bridge apply the server's order, so nothing is compared by clock here. Accepted
   * ops are sized for the storage counter.
   */
  private async acceptBatchCandidates(
    userId: number,
    duplicateFreeCandidates: BatchUploadCandidate[],
    tx: Prisma.TransactionClient,
  ): Promise<{
    accepted: AcceptedBatchOperation[];
    acceptedDeltaBytes: number;
    unserializableAccepted: number;
  }> {
    const accepted: AcceptedBatchOperation[] = [];
    let acceptedDeltaBytes = 0;
    let unserializableAccepted = 0;

    for (const candidate of duplicateFreeCandidates) {
      const { op } = candidate;
      if (isCausalFullStateOperation(op)) {
        this.noteFullStateAuthor(tx, op.clientId);
      }
      const protectedIds = await this.getPruneProtectedIds(tx, userId, op);
      pruneVectorClockForStorage(op, protectedIds);
      // Reuse the payload byte size measured during validation; the clock is
      // (re)measured inside computeOpStorageBytes because it was just pruned.
      const sized = computeOpStorageBytes(op, candidate.payloadBytes);
      acceptedDeltaBytes += sized.bytes;
      if (sized.fallback) unserializableAccepted++;

      const acceptedOperation: AcceptedBatchOperation = {
        ...candidate,
        serverSeq: 0,
        storageBytes: sized.bytes,
      };
      accepted.push(acceptedOperation);
    }

    return { accepted, acceptedDeltaBytes, unserializableAccepted };
  }

  /**
   * Stage 5: reserve a contiguous server_seq range for the accepted ops in one
   * INSERT ... ON CONFLICT (which also serializes concurrent batches via the
   * user_sync_state row lock), assign each op its seq, and bulk-insert. Returns
   * the DB round trips consumed (2).
   */
  private async reserveSeqAndInsert(
    userId: number,
    clientId: string,
    accepted: AcceptedBatchOperation[],
    now: number,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const syncStateRows = await tx.$queryRaw<Array<{ lastSeq: number | bigint }>>`
      INSERT INTO user_sync_state (user_id, last_seq)
      VALUES (${userId}, ${accepted.length})
      ON CONFLICT (user_id) DO UPDATE
        SET last_seq = user_sync_state.last_seq + EXCLUDED.last_seq
      RETURNING last_seq AS "lastSeq"
    `;
    const lastSeq = toSafeServerSeq(syncStateRows[0]?.lastSeq, userId);
    if (lastSeq < accepted.length) {
      throw new Error(`Failed to reserve server sequence range for user ${userId}`);
    }
    const firstSeq = lastSeq - accepted.length + 1;
    for (let i = 0; i < accepted.length; i++) {
      accepted[i].serverSeq = firstSeq + i;
    }

    await tx.operation.createMany({
      data: accepted.map((candidate) => ({
        id: candidate.op.id,
        userId,
        clientId,
        serverSeq: candidate.serverSeq,
        actionType: candidate.op.actionType,
        opType: candidate.op.opType,
        entityType: candidate.op.entityType,
        entityId: candidate.op.entityId ?? null,
        // Persist the full entity set for multi-entity ops, not just
        // entityIds[0]; single-entity ops store [] and use the scalar (#8334).
        entityIds: getStoredEntityIds(candidate.op),
        payload: candidate.op.payload as Prisma.InputJsonValue,
        payloadBytes: BigInt(candidate.storageBytes),
        vectorClock: candidate.op.vectorClock as Prisma.InputJsonValue,
        schemaVersion: candidate.op.schemaVersion,
        clientTimestamp: BigInt(candidate.op.timestamp),
        receivedAt: BigInt(now),
        isPayloadEncrypted: candidate.op.isPayloadEncrypted ?? false,
        syncImportReason: candidate.op.syncImportReason ?? null,
        repairBaseServerSeq: candidate.op.repairBaseServerSeq ?? null,
      })),
    });
    return 2;
  }

  /**
   * Stage 6: if the batch accepted any full-state op, persist the merged
   * latest-full-state vector clock once for the last such op (last write
   * wins). Returns the DB round trips consumed (2 if a full-state op was
   * accepted, else 0).
   */
  private async persistBatchFullStateClock(
    userId: number,
    accepted: AcceptedBatchOperation[],
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    let lastFullStateOp: AcceptedBatchOperation | null = null;
    for (const acceptedOp of accepted) {
      if (acceptedOp.fullStateVectorClock) {
        lastFullStateOp = acceptedOp;
      }
    }

    if (lastFullStateOp?.fullStateVectorClock) {
      await this.persistMergedFullStateClock(
        tx,
        userId,
        lastFullStateOp.serverSeq,
        lastFullStateOp.fullStateVectorClock,
      );
      return 2;
    }
    return 0;
  }

  /**
   * Process a single operation within a transaction.
   * Handles validation, the duplicate check, and persistence.
   */
  async processOperation(
    userId: number,
    clientId: string,
    op: Operation,
    now: number,
    tx: Prisma.TransactionClient,
    prevalidatedResult?: ValidationResult,
    wasOccupiedAtRequestStart?: boolean,
    firstRequestOperation?: { op: Operation; originalTimestamp: number },
  ): Promise<ProcessOperationResult> {
    // Rejected ops have no storage cost; the caller only reads storageBytes when
    // result.accepted is true.
    const reject = (result: UploadResult): ProcessOperationResult => ({
      result,
      storageBytes: 0,
      fallback: false,
    });

    // Clamp future timestamps instead of rejecting them (prevents silent data
    // loss). Shares the exact clamp + audit with the batch path.
    const originalTimestamp = this.clampFutureTimestamp(userId, clientId, op, now);

    // Validate operation (including clientId match)
    const validation =
      prevalidatedResult ?? this.validationService.validateOp(op, clientId);
    if (firstRequestOperation) {
      const isExactRetry = isSameIncomingOperation(
        firstRequestOperation.op,
        op,
        firstRequestOperation.originalTimestamp,
        originalTimestamp,
      );
      return reject(
        this.rejectedUploadResult(
          userId,
          clientId,
          op,
          isExactRetry
            ? 'Duplicate operation ID'
            : 'Operation ID already belongs to a different operation',
          isExactRetry
            ? SYNC_ERROR_CODES.DUPLICATE_OPERATION
            : SYNC_ERROR_CODES.INVALID_OP_ID,
        ),
      );
    }

    if (!validation.valid) {
      return reject(
        this.rejectedUploadResult(
          userId,
          clientId,
          op,
          validation.error,
          validation.errorCode,
        ),
      );
    }

    // Capture the *unpruned* vector clock for full-state ops. The op row stores
    // the pruned clock (see `limitVectorClockSize` call below); persisting the
    // unpruned copy on `user_sync_state` lets the download path re-prune at
    // read time with knowledge of `preserveClientIds` (excludeClient, snapshot
    // author), keeping more relevant entries than a pre-pruned snapshot would.
    const fullStateVectorClock = isCausalFullStateOperation(op)
      ? { ...op.vectorClock }
      : undefined;

    // Check for a duplicate operation before sequence allocation, so rejected
    // duplicates do not advance lastSeq.
    const existingOp = await tx.operation.findUnique({
      where: { id: op.id },
      select: DUPLICATE_OP_SELECT,
    });

    if (existingOp) {
      if (
        !isSameDuplicateOperation(
          existingOp,
          userId,
          op,
          this.config.maxClockDriftMs,
          originalTimestamp,
        )
      ) {
        return reject(
          this.rejectedUploadResult(
            userId,
            clientId,
            op,
            'Operation ID already belongs to a different operation',
            SYNC_ERROR_CODES.INVALID_OP_ID,
          ),
        );
      }

      return reject(
        this.rejectedUploadResult(
          userId,
          clientId,
          op,
          'Duplicate operation ID',
          SYNC_ERROR_CODES.DUPLICATE_OPERATION,
          undefined,
          existingOp.serverSeq,
        ),
      );
    }

    if (wasOccupiedAtRequestStart) {
      return reject(
        this.rejectedUploadResult(
          userId,
          clientId,
          op,
          'Operation ID was already occupied before quota enforcement',
          SYNC_ERROR_CODES.INVALID_OP_ID,
        ),
      );
    }

    // anex, Stage 9: no refusal because of another device's change to the same item; every valid op is stored in
    // arrival order and browsers and the bridge apply that order.
    // Get next sequence number
    const updatedState = await tx.userSyncState.update({
      where: { userId },
      data: { lastSeq: { increment: 1 } },
    });
    const serverSeq = updatedState.lastSeq;

    // Prune the vector clock just before storage.
    const beforeSize = Object.keys(op.vectorClock).length;
    // Note this op's own authorship first: a causal full-state op is its own
    // active author, so the memo answers without a query (and later ops in the
    // same transaction see it).
    if (isCausalFullStateOperation(op)) {
      this.noteFullStateAuthor(tx, op.clientId);
    }
    const protectedIds = await this.getPruneProtectedIds(tx, userId, op);
    op.vectorClock = limitVectorClockSize(op.vectorClock, [op.clientId, ...protectedIds]);
    const afterSize = Object.keys(op.vectorClock).length;
    if (afterSize < beforeSize) {
      Logger.debug(
        `[client:${op.clientId}] Vector clock pruned from ${beforeSize} to ${afterSize} before storage`,
      );
    }

    // Size the op once, here, after the clock prune above (so the stored clock is
    // measured) and reusing the payload byte size from validation (so the
    // payload isn't re-stringified). Reused for the payloadBytes column and the
    // caller's acceptedDeltaBytes accumulation.
    const sized = computeOpStorageBytes(op, validation.payloadBytes);

    const createResult = await tx.operation.createMany({
      data: [
        {
          id: op.id,
          userId,
          clientId,
          serverSeq,
          actionType: op.actionType,
          opType: op.opType,
          entityType: op.entityType,
          entityId: op.entityId ?? null,
          // Persist the full entity set for multi-entity ops, not just
          // entityIds[0]; single-entity ops store [] and use the scalar (#8334).
          entityIds: getStoredEntityIds(op),
          payload: op.payload as Prisma.InputJsonValue,
          payloadBytes: BigInt(sized.bytes),
          vectorClock: op.vectorClock as Prisma.InputJsonValue,
          schemaVersion: op.schemaVersion,
          clientTimestamp: BigInt(op.timestamp),
          receivedAt: BigInt(now),
          isPayloadEncrypted: op.isPayloadEncrypted ?? false,
          syncImportReason: op.syncImportReason ?? null,
          repairBaseServerSeq: op.repairBaseServerSeq ?? null,
        },
      ],
      skipDuplicates: true,
    });

    // A concurrent retry can pass the duplicate pre-check and then lose the
    // insert race. `createMany(..., skipDuplicates)` maps that to count=0
    // instead of aborting the PostgreSQL transaction with P2002/25P02.
    if (createResult.count === 0) {
      const duplicateOp = await tx.operation.findUnique({
        where: { id: op.id },
        select: DUPLICATE_OP_SELECT,
      });

      if (!duplicateOp) {
        throw new Error(
          `Operation insert skipped by non-id unique constraint (userId=${userId}, opId=${op.id}, serverSeq=${serverSeq})`,
        );
      }

      await tx.userSyncState.update({
        where: { userId },
        data: { lastSeq: { decrement: 1 } },
      });

      if (
        !isSameDuplicateOperation(
          duplicateOp,
          userId,
          op,
          this.config.maxClockDriftMs,
          originalTimestamp,
        )
      ) {
        return reject(
          this.rejectedUploadResult(
            userId,
            clientId,
            op,
            'Operation ID already belongs to a different operation',
            SYNC_ERROR_CODES.INVALID_OP_ID,
          ),
        );
      }

      return reject(
        this.rejectedUploadResult(
          userId,
          clientId,
          op,
          'Duplicate operation ID',
          SYNC_ERROR_CODES.DUPLICATE_OPERATION,
          undefined,
          duplicateOp.serverSeq,
        ),
      );
    }

    if (fullStateVectorClock) {
      // Persist the aggregate of (prior history ∪ this op's clock), not just the
      // op's own clock. BACKUP_IMPORT uses a fresh `{ clientId: 1 }` by design
      // (backup.service.ts) and a compaction-built SYNC_IMPORT clock can be
      // pruned. Either case leaves out client_ids that still have pre-snapshot
      // ops alive in the conflict-detection set, so a downloader that reset to
      // the bare op clock would have its first edit go CONCURRENT against those
      // surviving rows. Doing the aggregate here moves the cost from per-download
      // to per-snapshot — full-state ops are rare so the upload-time scan is
      // strictly cheaper overall. Stored unpruned; the download path applies
      // `limitVectorClockSize` with `preserveClientIds` known to that read.
      await this.persistMergedFullStateClock(tx, userId, serverSeq, fullStateVectorClock);
    }

    return {
      result: { opId: op.id, accepted: true, serverSeq },
      storageBytes: sized.bytes,
      fallback: sized.fallback,
    };
  }
}

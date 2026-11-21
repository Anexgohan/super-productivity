/** How an uploaded op is stored and recognised again: duplicate retries, the stored entity_ids shape and clock pruning. */
import { Logger } from '../logger';
import {
  DuplicateOperationCandidate,
  Operation,
  limitVectorClockSize,
} from './sync.types';

export const isSameDuplicateOperation = (
  existingOp: DuplicateOperationCandidate,
  userId: number,
  op: Operation,
  maxClockDriftMs: number,
  originalTimestamp: number = op.timestamp,
): boolean => {
  // Reproduce the normalization of the already-stored row. Storage may protect
  // a low-counter causal full-state author in addition to the uploader, so use
  // the stored clock's IDs as the authoritative protected set. Otherwise a
  // genuine retry of an oversized post-import op compares as an ID collision.
  //
  // Tradeoff, deliberate: for an oversized incoming clock this projects onto the
  // stored key set, so an id collision that ALSO differs only by an extra clock
  // entry now reads as a duplicate instead of being caught. Accepted because
  // every other structural field below (clientId, payload, entity, timestamp)
  // must still match — and when they all do, acking beats rejecting a retry
  // whose only sin is having learned about one more client.
  const storedClockClientIds =
    existingOp.vectorClock !== null &&
    typeof existingOp.vectorClock === 'object' &&
    !Array.isArray(existingOp.vectorClock)
      ? Object.keys(existingOp.vectorClock)
      : [];
  const storedVectorClock = limitVectorClockSize(op.vectorClock, [
    op.clientId,
    ...storedClockClientIds,
  ]);
  const incomingEncrypted = op.isPayloadEncrypted ?? false;

  // encrypt() uses a fresh random IV per call, so retried ciphertext differs
  // from the stored bytes. Skip byte-equality when both sides are encrypted;
  // the structural fields below still guard against id collisions.
  const payloadsMatch =
    (existingOp.isPayloadEncrypted && incomingEncrypted) ||
    areJsonValuesEqual(existingOp.payload, op.payload);

  return (
    existingOp.userId === userId &&
    existingOp.clientId === op.clientId &&
    existingOp.actionType === op.actionType &&
    existingOp.opType === op.opType &&
    existingOp.entityType === op.entityType &&
    existingOp.entityId === (op.entityId ?? null) &&
    // Compare against the same normalization the row was persisted with
    // (getStoredEntityIds: single-entity sets collapse to []), so a genuine
    // retry matches while a batch op differing only in entityIds does not.
    areJsonValuesEqual(existingOp.entityIds, getStoredEntityIds(op)) &&
    payloadsMatch &&
    areJsonValuesEqual(existingOp.vectorClock, storedVectorClock) &&
    existingOp.schemaVersion === op.schemaVersion &&
    isSameDuplicateTimestamp(
      existingOp.clientTimestamp,
      existingOp.receivedAt,
      op.timestamp,
      originalTimestamp,
      maxClockDriftMs,
    ) &&
    existingOp.isPayloadEncrypted === incomingEncrypted &&
    existingOp.syncImportReason === (op.syncImportReason ?? null) &&
    existingOp.repairBaseServerSeq === (op.repairBaseServerSeq ?? null)
  );
};

/** Complete identity comparison for two validated operations in one request. */
export const isSameIncomingOperation = (
  first: Operation,
  second: Operation,
  firstOriginalTimestamp: number = first.timestamp,
  secondOriginalTimestamp: number = second.timestamp,
): boolean => {
  const bothEncrypted =
    (first.isPayloadEncrypted ?? false) && (second.isPayloadEncrypted ?? false);
  return (
    first.clientId === second.clientId &&
    first.actionType === second.actionType &&
    first.opType === second.opType &&
    first.entityType === second.entityType &&
    first.entityId === second.entityId &&
    areJsonValuesEqual(getStoredEntityIds(first), getStoredEntityIds(second)) &&
    (bothEncrypted || areJsonValuesEqual(first.payload, second.payload)) &&
    areJsonValuesEqual(
      limitVectorClockSize(first.vectorClock, [first.clientId]),
      limitVectorClockSize(second.vectorClock, [second.clientId]),
    ) &&
    first.schemaVersion === second.schemaVersion &&
    firstOriginalTimestamp === secondOriginalTimestamp &&
    (first.isPayloadEncrypted ?? false) === (second.isPayloadEncrypted ?? false) &&
    (first.syncImportReason ?? null) === (second.syncImportReason ?? null) &&
    (first.repairBaseServerSeq ?? null) === (second.repairBaseServerSeq ?? null)
  );
};

export const isSameDuplicateTimestamp = (
  existingTimestamp: bigint | number | string,
  existingReceivedAt: bigint | number | string,
  incomingStoredTimestamp: number,
  incomingOriginalTimestamp: number,
  maxClockDriftMs: number,
): boolean => {
  if (existingTimestamp.toString() === incomingStoredTimestamp.toString()) {
    return true;
  }

  // A retry can arrive after server time advances enough that the original
  // timestamp no longer needs clamping, so original===stored does not rule
  // out a duplicate.
  // Future timestamps are clamped at receive time. A retry of the same op may
  // be clamped to a later value, or stop clamping once server time reaches the
  // original timestamp's allowed drift window. Allow exact-content duplicates
  // whose stored timestamp came from an earlier clamp of that same original
  // client timestamp.
  const existingTimestampValue = BigInt(existingTimestamp);
  const existingReceivedAtValue = BigInt(existingReceivedAt);
  return (
    existingTimestampValue === existingReceivedAtValue + BigInt(maxClockDriftMs) &&
    existingTimestampValue <= BigInt(incomingOriginalTimestamp)
  );
};

export const areJsonValuesEqual = (a: unknown, b: unknown): boolean => {
  return stableJsonStringify(a) === stableJsonStringify(b);
};

export const stableJsonStringify = (value: unknown): string => {
  return JSON.stringify(toStableJsonValue(value)) ?? 'undefined';
};

export const toStableJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => toStableJsonValue(item));
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, toStableJsonValue((value as Record<string, unknown>)[key])]),
    );
  }

  return value;
};

/**
 * The entity_ids array to persist: empty when the set is exactly [entity_id], which keeps single-entity ops out of the GIN index, otherwise the full set.
 * A batch whose ids dedup to one value other than entity_id is still stored in full, so the row keeps that entity.
 */
export const getStoredEntityIds = (op: Operation): string[] => {
  // Preserve the historical storage normalization: the scalar is persisted in
  // entity_id and only the declared multi-entity set belongs in entity_ids.
  const ids = Array.from(
    new Set(op.entityIds?.length ? op.entityIds : op.entityId ? [op.entityId] : []),
  );
  if (ids.length <= 1 && ids[0] === op.entityId) {
    return [];
  }
  return ids;
};

export const pruneVectorClockForStorage = (
  op: Operation,
  preserveClientIds: readonly string[] = [],
): void => {
  const beforeSize = Object.keys(op.vectorClock).length;
  op.vectorClock = limitVectorClockSize(op.vectorClock, [
    op.clientId,
    ...preserveClientIds,
  ]);
  const afterSize = Object.keys(op.vectorClock).length;
  if (afterSize < beforeSize) {
    Logger.debug(
      `[client:${op.clientId}] Vector clock pruned from ${beforeSize} to ${afterSize} before storage`,
    );
  }
};

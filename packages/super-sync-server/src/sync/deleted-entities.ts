/**
 * The deletes of tasks and notes from the last 7 days, kept so a browser can tell whether its edit to an item a checkpoint lacks came after the delete.
 * Only the ids an op names are recorded, since payloads are end-to-end encrypted: a browser finds a subtask through its parent.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { MS_PER_DAY, Operation } from './sync.types';

export const DELETED_ENTITY_TYPES: ReadonlySet<string> = new Set(['TASK', 'NOTE']);
export const DELETED_ENTITY_RETENTION_MS = 7 * MS_PER_DAY;

export interface EntityDeleteTime {
  entityType: string;
  entityId: string;
  /** Device time of the latest delete, as the deleting device stamped it. */
  deletedAt: number;
}

const keyOf = (entityType: string, entityId: string): string =>
  `${entityType}\u0000${entityId}`;

/** The task and note ids the delete ops name, each with the latest delete time among them. */
export const deletesNamedBy = (
  ops: readonly Pick<
    Operation,
    'opType' | 'entityType' | 'entityId' | 'entityIds' | 'timestamp'
  >[],
): EntityDeleteTime[] => {
  const latest = new Map<string, EntityDeleteTime>();
  for (const op of ops) {
    if (op.opType !== 'DEL' || !DELETED_ENTITY_TYPES.has(op.entityType)) continue;
    for (const entityId of new Set([op.entityId, ...(op.entityIds ?? [])])) {
      if (!entityId) continue;
      const key = keyOf(op.entityType, entityId);
      const known = latest.get(key);
      if (!known || known.deletedAt < op.timestamp) {
        latest.set(key, { entityType: op.entityType, entityId, deletedAt: op.timestamp });
      }
    }
  }
  return [...latest.values()];
};

/**
 * Records the deletes among ops just stored, in the upload's transaction, so a stored delete always has its record.
 * A row keeps the latest device time of its deletes; the server time is refreshed with every delete.
 */
export const recordDeletes = async (
  tx: Prisma.TransactionClient,
  userId: number,
  ops: readonly Operation[],
  now: number,
): Promise<void> => {
  const deletes = deletesNamedBy(ops);
  if (deletes.length === 0) return;
  const existing = await tx.deletedEntity.findMany({
    where: {
      userId,
      OR: deletes.map(({ entityType, entityId }) => ({ entityType, entityId })),
    },
    select: { entityType: true, entityId: true, deletedAt: true },
  });
  const existingAt = new Map(
    existing.map((row) => [keyOf(row.entityType, row.entityId), Number(row.deletedAt)]),
  );
  const recordedAt = BigInt(now);
  const fresh: EntityDeleteTime[] = [];
  for (const entry of deletes) {
    const { entityType, entityId, deletedAt } = entry;
    const previous = existingAt.get(keyOf(entityType, entityId));
    if (previous !== undefined) {
      // The cleanup runs outside the user's lock, so a row read above may be gone by now; it is then created again.
      const { count } = await tx.deletedEntity.updateMany({
        where: { userId, entityType, entityId },
        data: { deletedAt: BigInt(Math.max(previous, deletedAt)), recordedAt },
      });
      if (count > 0) continue;
    }
    fresh.push(entry);
  }
  if (fresh.length > 0) {
    await tx.deletedEntity.createMany({
      data: fresh.map(({ entityType, entityId, deletedAt }) => ({
        userId,
        entityType,
        entityId,
        deletedAt: BigInt(deletedAt),
        recordedAt,
      })),
      skipDuplicates: true,
    });
  }
};

/**
 * The bring-backs among ops that a recorded delete at or after their device time beats; a tie keeps the delete.
 * The user's sequence row is locked first, so a delete uploaded at the same moment is either on record here or stored after these saves.
 * A save already stored is left out, so its retry still gets its duplicate answer.
 */
export const findBeatenBringBacks = async (
  tx: Prisma.TransactionClient,
  userId: number,
  ops: readonly Operation[],
  latestAllowedTimestamp: number,
): Promise<Operation[]> => {
  const bringBacks = ops.filter(
    (op) =>
      op.recreatesEntityAfterDelete === true &&
      op.opType === 'UPD' &&
      DELETED_ENTITY_TYPES.has(op.entityType) &&
      !!op.entityId,
  );
  if (bringBacks.length === 0) return [];
  await tx.userSyncState.upsert({
    where: { userId },
    create: { userId, lastSeq: 0 },
    update: {},
  });
  await tx.$queryRaw`SELECT last_seq FROM user_sync_state WHERE user_id = ${userId} FOR UPDATE`;
  const stored = await tx.operation.findMany({
    where: { id: { in: bringBacks.map((op) => op.id) } },
    select: { id: true },
  });
  const storedIds = new Set(stored.map(({ id }) => id));
  const unstored = bringBacks.filter((op) => !storedIds.has(op.id));
  if (unstored.length === 0) return [];
  const records = await tx.deletedEntity.findMany({
    where: {
      userId,
      OR: unstored.map((op) => ({ entityType: op.entityType, entityId: op.entityId })),
    },
    select: { entityType: true, entityId: true, deletedAt: true },
  });
  const deletedAt = new Map(
    records.map((row) => [keyOf(row.entityType, row.entityId), Number(row.deletedAt)]),
  );
  // Compared as the upload will store it: a time too far ahead is clamped to the latest one allowed.
  return unstored.filter((op) => {
    const at = deletedAt.get(keyOf(op.entityType, op.entityId as string));
    return at !== undefined && at >= Math.min(op.timestamp, latestAllowedTimestamp);
  });
};

/** The recorded delete times of the asked items, for this user only; items without a record are left out. */
export const getDeleteTimes = async (
  userId: number,
  items: readonly { entityType: string; entityId: string }[],
): Promise<EntityDeleteTime[]> => {
  const wanted = items.filter(({ entityType }) => DELETED_ENTITY_TYPES.has(entityType));
  if (wanted.length === 0) return [];
  const rows = await prisma.deletedEntity.findMany({
    where: {
      userId,
      OR: wanted.map(({ entityType, entityId }) => ({ entityType, entityId })),
    },
    select: { entityType: true, entityId: true, deletedAt: true },
  });
  return rows.map((row) => ({
    entityType: row.entityType,
    entityId: row.entityId,
    deletedAt: Number(row.deletedAt),
  }));
};

/** Deletes the records stored before the cutoff, by server time, for every user. */
export const deleteOldDeleteRecords = async (cutoffTime: number): Promise<number> => {
  const { count } = await prisma.deletedEntity.deleteMany({
    where: { recordedAt: { lt: BigInt(cutoffTime) } },
  });
  return count;
};

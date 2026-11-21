/**
 * anex fork, Stage 9 of the container-authority work: every browser follows the server's order.
 *
 * The server stores every valid change in the order it arrives, and the bridge applies them in that
 * order. A browser shows the state the server confirmed with its own unsent changes on top. It
 * applies a download as it always has when that already gives the server's order. Otherwise it goes
 * back to the confirmed state and replays the downloaded changes and its own accepted ones by their
 * server numbers, with what the server has not confirmed yet on top.
 *
 * Pure functions: the host supplies the changes with their server numbers and runs the reducers.
 */

import { OpType } from './operation.types';
import type { Operation } from './operation.types';

/** A change with the number the server stored it under. */
export interface ServerOrderedOp<TOperation extends Operation<string> = Operation> {
  op: TOperation;
  serverSeq: number;
}

export interface ServerOrderInput<TOperation extends Operation<string> = Operation> {
  /** Other browsers' changes just downloaded. */
  downloaded: readonly ServerOrderedOp<TOperation>[];
  /** This browser's changes the server accepted after the confirmed state, already shown. */
  accepted: readonly ServerOrderedOp<TOperation>[];
  /** This browser's changes the server has not accepted yet, already shown, in the order they were made. */
  unsent: readonly TOperation[];
  /** False when the confirmed state is not known, as after a reload. */
  hasConfirmedState: boolean;
  /** The highest number the server holds for this browser's saves, when the server said; it covers saves sent before a reload. */
  ownLatestSeq?: number;
}

export type ServerOrderPlan<TOperation extends Operation<string> = Operation> =
  /** Applying the download after everything shown already gives the server's order. */
  | { kind: 'in-order'; confirmedSeq: number }
  /**
   * Go back to the confirmed state, apply `ordered`, keep the result as the confirmed state as of
   * `confirmedSeq`, then apply `onTop`.
   */
  | {
      kind: 'replay';
      ordered: TOperation[];
      onTop: TOperation[];
      confirmedSeq: number;
      /** This browser's accepted changes now inside the confirmed state. */
      placedOpIds: string[];
    }
  /** The order matters but the confirmed state is unknown: rebuild it from the server. */
  | { kind: 'rebuild' };

const bySeq = <TOperation extends Operation<string>>(
  a: ServerOrderedOp<TOperation>,
  b: ServerOrderedOp<TOperation>,
): number => a.serverSeq - b.serverSeq;

/** Numbers must be distinct; two changes under one number mean the input is inconsistent. */
const hasDistinctSeqs = (seqs: readonly number[]): boolean =>
  new Set(seqs).size === seqs.length;

/**
 * How to apply a download so the browser ends up in the server's order.
 *
 * Applying it as today is right when nothing of this browser's comes after the first downloaded change: no unsent change, no save numbered later.
 * Otherwise the downloaded changes and this browser's accepted ones up to the last downloaded number are replayed in server order.
 * Accepted changes numbered after it and unsent ones go on top, in that order.
 */
export const planServerOrderApply = <TOperation extends Operation<string>>({
  downloaded,
  accepted,
  unsent,
  hasConfirmedState,
  ownLatestSeq,
}: ServerOrderInput<TOperation>): ServerOrderPlan<TOperation> => {
  if (downloaded.length === 0) {
    throw new Error('planServerOrderApply: nothing was downloaded.');
  }
  const seqs = [...downloaded, ...accepted].map((entry) => entry.serverSeq);
  if (!hasDistinctSeqs(seqs) || seqs.some((seq) => !Number.isInteger(seq) || seq < 1)) {
    return { kind: 'rebuild' };
  }

  const downloadedInOrder = [...downloaded].sort(bySeq);
  const firstDownloaded = downloadedInOrder[0].serverSeq;
  const lastDownloaded = downloadedInOrder[downloadedInOrder.length - 1].serverSeq;

  if (
    unsent.length === 0 &&
    accepted.every((entry) => entry.serverSeq < firstDownloaded) &&
    (ownLatestSeq ?? 0) < firstDownloaded
  ) {
    return { kind: 'in-order', confirmedSeq: lastDownloaded };
  }
  if (!hasConfirmedState) {
    return { kind: 'rebuild' };
  }

  const acceptedInOrder = [...accepted].sort(bySeq);
  const placed = acceptedInOrder.filter((entry) => entry.serverSeq <= lastDownloaded);
  const later = acceptedInOrder.filter((entry) => entry.serverSeq > lastDownloaded);
  return {
    kind: 'replay',
    ordered: [...downloadedInOrder, ...placed].sort(bySeq).map((entry) => entry.op),
    onTop: [...later.map((entry) => entry.op), ...unsent],
    confirmedSeq: lastDownloaded,
    placedOpIds: placed.map((entry) => entry.op.id),
  };
};

/**
 * The first server number between the confirmed state and the end of a download that is neither downloaded nor known
 * (this browser's accepted saves, changes dropped before the apply), or undefined when none is missing. A missing
 * number, or a download at or before the confirmed state, means the confirmed state does not fit the download.
 */
export const findUnaccountedServerSeq = ({
  confirmedSeq,
  downloadedSeqs,
  knownSeqs,
}: {
  confirmedSeq: number;
  downloadedSeqs: readonly number[];
  knownSeqs: readonly number[];
}): number | undefined => {
  if (downloadedSeqs.length === 0) return undefined;
  const lowest = Math.min(...downloadedSeqs);
  if (lowest <= confirmedSeq) return lowest;
  const seen = new Set([...downloadedSeqs, ...knownSeqs]);
  const last = Math.max(...downloadedSeqs);
  for (let seq = confirmedSeq + 1; seq <= last; seq++) {
    if (!seen.has(seq)) return seq;
  }
  return undefined;
};

/** A delete of one task or note, with the deleting device's time. */
export interface ItemDelete {
  entityType: string;
  entityId: string;
  deletedAt: number;
}

/** An item this browser edited after its delete, with the time of that edit. */
export interface EditBeatingDelete {
  entityType: string;
  entityId: string;
  editAt: number;
}

const itemKey = (entityType: string, entityId: string): string =>
  `${entityType}:${entityId}`;

/** An edit wins over a delete only when its device time is later; a tie keeps the delete. */
export const editBeatsDelete = (editAt: number, deletedAt: number): boolean =>
  editAt > deletedAt;

/** The latest delete time per item. */
const latestDeleteTimes = (deletes: readonly ItemDelete[]): Map<string, ItemDelete> => {
  const latest = new Map<string, ItemDelete>();
  for (const entry of deletes) {
    const key = itemKey(entry.entityType, entry.entityId);
    const known = latest.get(key);
    if (!known || known.deletedAt < entry.deletedAt) latest.set(key, entry);
  }
  return latest;
};

/**
 * The deleted items whose latest edit by this browser is later than their latest delete.
 * Only an update of that one item counts as an edit; an item whose last change here is this browser's own delete stays deleted.
 * `own` is this browser's change log in the order the changes were made.
 */
export const findEditsThatBeatDeletes = ({
  deletes,
  own,
}: {
  deletes: readonly ItemDelete[];
  own: readonly Operation<string>[];
}): EditBeatingDelete[] => {
  const latest = latestDeleteTimes(deletes);
  if (latest.size === 0) return [];
  const editAt = new Map<string, number | undefined>();
  for (const op of own) {
    if (op.opType === OpType.Delete) {
      for (const id of [op.entityId, ...(op.entityIds ?? [])]) {
        if (id) editAt.set(itemKey(op.entityType, id), undefined);
      }
      continue;
    }
    const isSingleItem = !op.entityIds || op.entityIds.every((id) => id === op.entityId);
    if (op.opType !== OpType.Update || !op.entityId || !isSingleItem) continue;
    const key = itemKey(op.entityType, op.entityId);
    if (!latest.has(key)) continue;
    editAt.set(key, Math.max(editAt.get(key) ?? -Infinity, op.timestamp));
  }
  const winners: EditBeatingDelete[] = [];
  for (const [key, entry] of latest) {
    const at = editAt.get(key);
    if (at !== undefined && editBeatsDelete(at, entry.deletedAt)) {
      winners.push({
        entityType: entry.entityType,
        entityId: entry.entityId,
        editAt: at,
      });
    }
  }
  return winners;
};

/** This browser's unsent changes that would recreate a deleted item although the delete is later, to withdraw before they are sent. */
export const findRecreationsBeatenByDeletes = <TOperation extends Operation<string>>({
  deletes,
  unsent,
  recreatesItem,
}: {
  deletes: readonly ItemDelete[];
  unsent: readonly TOperation[];
  recreatesItem: (op: TOperation) => boolean;
}): TOperation[] => {
  const latest = latestDeleteTimes(deletes);
  return unsent.filter((op) => {
    const entry = latest.get(itemKey(op.entityType, op.entityId ?? ''));
    return (
      entry !== undefined &&
      recreatesItem(op) &&
      !editBeatsDelete(op.timestamp, entry.deletedAt)
    );
  });
};

/**
 * The delete time of each asked item from the server's records: its own record, or else its parent's.
 * A delete names only the top task, so a subtask's delete is recorded under its parent.
 */
export const deleteTimesWithParents = (
  asked: readonly { entityType: string; entityId: string; parentId?: string }[],
  records: readonly ItemDelete[],
): ItemDelete[] => {
  const latest = latestDeleteTimes(records);
  return asked.flatMap(({ entityType, entityId, parentId }) => {
    const found =
      latest.get(itemKey(entityType, entityId)) ??
      (parentId ? latest.get(itemKey(entityType, parentId)) : undefined);
    return found ? [{ entityType, entityId, deletedAt: found.deletedAt }] : [];
  });
};

/**
 * This browser's unsent changes to apply on top of a checkpoint: those the server accepted at or before its base number are in it.
 * A change whose number this browser does not know is kept.
 */
export const editsNotInCheckpoint = <TOperation extends Operation<string>>({
  unsent,
  checkpointBaseSeq,
  ownServerSeq,
}: {
  unsent: readonly TOperation[];
  checkpointBaseSeq: number;
  ownServerSeq: (opId: string) => number | undefined;
}): TOperation[] =>
  unsent.filter((op) => {
    const serverSeq = ownServerSeq(op.id);
    return serverSeq === undefined || serverSeq > checkpointBaseSeq;
  });

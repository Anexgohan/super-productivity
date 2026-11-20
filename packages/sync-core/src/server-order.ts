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
 * Applying it as today is right when nothing of this browser's waits after it: no unsent change,
 * and every accepted change numbered before every downloaded one. Otherwise the downloaded changes
 * and this browser's accepted changes up to the last downloaded number are replayed in server
 * order; accepted changes numbered after it and unsent ones go on top, in that order.
 */
export const planServerOrderApply = <TOperation extends Operation<string>>({
  downloaded,
  accepted,
  unsent,
  hasConfirmedState,
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
    accepted.every((entry) => entry.serverSeq < firstDownloaded)
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

/**
 * Items another browser deleted before this browser's edit to them, in server order: an accepted edit numbered after
 * the delete, or an unsent one (always after the download). Applied in that order the edit would change nothing, so
 * the host sends the item back instead (the Stage 8 behaviour). Returns the edits per item id.
 */
export const findEditsAfterRemoteDelete = <TOperation extends Operation<string>>({
  downloaded,
  own,
  entityType,
}: {
  downloaded: readonly ServerOrderedOp<TOperation>[];
  /** This browser's changes in the replay: accepted ones with their numbers, unsent ones without. */
  own: readonly { op: TOperation; serverSeq?: number }[];
  entityType: string;
}): Map<string, TOperation[]> => {
  const deletedAt = new Map<string, number>();
  for (const { op, serverSeq } of downloaded) {
    if (op.entityType !== entityType || op.opType !== OpType.Delete) continue;
    for (const id of [op.entityId, ...(op.entityIds ?? [])]) {
      if (id && (deletedAt.get(id) ?? Infinity) > serverSeq) deletedAt.set(id, serverSeq);
    }
  }
  const edits = new Map<string, TOperation[]>();
  if (deletedAt.size === 0) return edits;
  for (const { op, serverSeq } of own) {
    if (op.entityType !== entityType || op.opType !== OpType.Update || !op.entityId)
      continue;
    const deleteSeq = deletedAt.get(op.entityId);
    if (deleteSeq === undefined || (serverSeq !== undefined && serverSeq < deleteSeq)) {
      continue;
    }
    edits.set(op.entityId, [...(edits.get(op.entityId) ?? []), op]);
  }
  return edits;
};

import {
  isCheckpointFullStateOp,
  isFullStateOpType,
  OperationLogEntry,
} from '../core/operation.types';

/**
 * Replay order for the startup rebuild (anex/checkpoints, Stage 6): this browser's unsent edits logged before the
 * newest checkpoint are replayed after it, so the rebuilt state is the checkpoint plus the edits still on their way,
 * as it was shown when the checkpoint arrived.
 *
 * In log order the checkpoint, a full state, would wipe them. Normally the snapshot saved right after the checkpoint
 * is applied means it is not replayed at all; this covers a startup without that snapshot (a crash in between, or a
 * snapshot that could not be saved). Edits from before the snapshot the rebuild starts from count too: the snapshot
 * holds them, but the checkpoint replayed after it wipes them. The change log itself is never reordered.
 *
 * A full import or a REPAIR without its base keeps log order: those replace the state with clean-slate semantics.
 *
 * @param entries the ops the rebuild replays, in log order
 * @param unsynced every op not yet acknowledged by the server (`getUnsynced()`)
 */
export const withUnsentEditsAfterCheckpoint = (
  entries: OperationLogEntry[],
  unsynced: OperationLogEntry[],
): OperationLogEntry[] => {
  let checkpointSeq: number | undefined;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isFullStateOpType(entries[i].op.opType)) {
      if (isCheckpointFullStateOp(entries[i].op)) checkpointSeq = entries[i].seq;
      break;
    }
  }
  if (checkpointSeq === undefined) return entries;
  const before = checkpointSeq;

  const moved = unsynced
    .filter(
      (entry) =>
        entry.seq < before &&
        entry.source === 'local' &&
        !entry.syncedAt &&
        !entry.rejectedAt &&
        !isFullStateOpType(entry.op.opType),
    )
    .sort((a, b) => a.seq - b.seq);
  if (moved.length === 0) return entries;

  const movedIds = new Set(moved.map((entry) => entry.op.id));
  return [...entries.filter((entry) => !movedIds.has(entry.op.id)), ...moved];
};

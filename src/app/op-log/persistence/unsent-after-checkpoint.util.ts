import {
  isCheckpointFullStateOp,
  isFullStateOpType,
  OperationLogEntry,
} from '../core/operation.types';

/**
 * Startup replay order: this browser's unsent edits logged before the newest checkpoint replay after it, where the checkpoint apply put them.
 * That is after the checkpoint and its download, before this browser's later saves, such as the "bring it back" saves that already hold them.
 * In log order the checkpoint, a full state, would wipe them; this covers a startup without the snapshot saved after the checkpoint applied.
 * Edits held by the snapshot the rebuild starts from count too, since the checkpoint replayed after it wipes them.
 * A full import or a REPAIR without its base keeps log order: those replace the state with clean-slate semantics.
 * The change log itself is never reordered.
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
  const kept = entries.filter((entry) => !movedIds.has(entry.op.id));
  const firstLocalAfter = kept.findIndex(
    (entry) => entry.seq > before && entry.source === 'local',
  );
  const at = firstLocalAfter < 0 ? kept.length : firstLocalAfter;
  return [...kept.slice(0, at), ...moved, ...kept.slice(at)];
};

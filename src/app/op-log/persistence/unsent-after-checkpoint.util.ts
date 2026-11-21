import {
  isCheckpointFullStateOp,
  isFullStateOpType,
  OperationLogEntry,
} from '../core/operation.types';

/** The newest full-state entry when it is a checkpoint, the one the startup rebuild replays edits after. */
export const newestCheckpointEntry = (
  entries: OperationLogEntry[],
): OperationLogEntry | undefined => {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isFullStateOpType(entries[i].op.opType)) {
      return isCheckpointFullStateOp(entries[i].op) ? entries[i] : undefined;
    }
  }
  return undefined;
};

/**
 * Startup replay order: the edits the checkpoint apply put on top of the newest checkpoint replay after it, where that apply put them.
 * That is right after the last remote entry the apply logged, which the checkpoint records, so later downloads and saves stay after them.
 * Those saves include the "bring it back" saves that already hold them.
 * Without that end on the checkpoint entry, they go before this browser's first later save.
 * In log order the checkpoint, a full state, would wipe them; this covers a startup without the snapshot saved after the checkpoint applied.
 * The apply records their ids on the checkpoint's log entry, decided by the server's stored numbers, so a later acknowledgement changes nothing.
 * A checkpoint entry without that record moves this browser's edits that are still unsent.
 * Edits held by the snapshot the rebuild starts from count too, since the checkpoint replayed after it wipes them.
 * A full import or a REPAIR without its base keeps log order: those replace the state with clean-slate semantics.
 * The change log itself is never reordered.
 *
 * @param entries the ops the rebuild replays, in log order
 * @param logged the entries to move from: those the record names, or without a record every op not yet acknowledged (`getUnsynced()`)
 */
export const withUnsentEditsAfterCheckpoint = (
  entries: OperationLogEntry[],
  logged: OperationLogEntry[],
): OperationLogEntry[] => {
  const checkpoint = newestCheckpointEntry(entries);
  if (!checkpoint) return entries;
  const before = checkpoint.seq;
  const recorded = checkpoint.unsentOnTopOpIds && new Set(checkpoint.unsentOnTopOpIds);

  const moved = logged
    .filter(
      (entry) =>
        entry.seq < before &&
        (recorded
          ? recorded.has(entry.op.id)
          : entry.source === 'local' &&
            !entry.syncedAt &&
            !entry.rejectedAt &&
            !isFullStateOpType(entry.op.opType)),
    )
    .sort((a, b) => a.seq - b.seq);
  if (moved.length === 0) return entries;

  const movedIds = new Set(moved.map((entry) => entry.op.id));
  const kept = entries.filter((entry) => !movedIds.has(entry.op.id));
  const end = checkpoint.unsentOnTopAfterSeq;
  const firstAfter = kept.findIndex((entry) =>
    end !== undefined ? entry.seq > end : entry.seq > before && entry.source === 'local',
  );
  const at = firstAfter < 0 ? kept.length : firstAfter;
  return [...kept.slice(0, at), ...moved, ...kept.slice(at)];
};

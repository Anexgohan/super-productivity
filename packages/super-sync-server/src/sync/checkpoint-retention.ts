/**
 * Which history the daily cleanup keeps (anex fork, Stage 7 of the container-authority work).
 *
 * Syncing only ever needs the newest checkpoint and what came after it: a client asking from
 * further back is moved forward to the newest checkpoint (operation-download.service.ts). The
 * cleanup keeps one checkpoint more than that, with every change after it, so a wrong newest
 * checkpoint can still be rebuilt from the one before. It also keeps the newest checkpoint of
 * each of the last {@link RETAINED_CHECKPOINT_DAYS} days that have one, as restore points.
 * Everything else is deleted, whatever its age.
 *
 * Days are counted by days that have a checkpoint, not by calendar: a busy day can hold many
 * checkpoints (at most one an hour), and a quiet fortnight holds none, so neither shrinks the
 * week of restore points.
 */

export const RETAINED_CHECKPOINT_DAYS = 7;

export interface CheckpointRow {
  serverSeq: number;
  /** When the server stored it, ms since epoch. */
  receivedAt: number;
}

export interface CheckpointRetention {
  /** Every change from here on is kept: the second-newest checkpoint. */
  keepAllFromSeq: number;
  /** Checkpoints before {@link keepAllFromSeq} that are kept as daily restore points. */
  keptCheckpointSeqs: ReadonlySet<number>;
}

/** Calendar day in the server's time zone (the TZ the process runs with). */
export const localDayKey = (ms: number): string => {
  const date = new Date(ms);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
};

/**
 * @param checkpoints causal full-state ops of one account, any order
 * @returns null when there are fewer than two checkpoints: nothing may be deleted then
 */
export const planCheckpointRetention = (
  checkpoints: readonly CheckpointRow[],
  dayKey: (ms: number) => string = localDayKey,
  days: number = RETAINED_CHECKPOINT_DAYS,
): CheckpointRetention | null => {
  if (checkpoints.length < 2) return null;
  const newestFirst = [...checkpoints].sort((a, b) => b.serverSeq - a.serverSeq);
  const keepAllFromSeq = newestFirst[1].serverSeq;

  const keptCheckpointSeqs = new Set<number>();
  const seenDays = new Set<string>();
  for (const checkpoint of newestFirst) {
    const day = dayKey(checkpoint.receivedAt);
    if (seenDays.has(day)) continue;
    if (seenDays.size >= days) break;
    seenDays.add(day);
    if (checkpoint.serverSeq < keepAllFromSeq)
      keptCheckpointSeqs.add(checkpoint.serverSeq);
  }
  return { keepAllFromSeq, keptCheckpointSeqs };
};

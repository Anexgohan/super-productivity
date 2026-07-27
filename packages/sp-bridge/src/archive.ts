/**
 * Reading completed work out of the archive.
 *
 * Tasks are archived daily, so `GET /api/tasks?isDone=true` only shows what was finished since the last sweep. Older work lives here, which makes
 * this the only way to answer "what did this person actually get done last week".
 *
 * Young (under 21 days) and old are merged on read: that split is a storage detail the client manages, not something a caller should reason about.
 * Pure functions over plain state, so the filtering is unit-testable without a live board.
 */

/** Enough to answer a month's worth of questions without ever streaming years of history by accident. */
export const DEFAULT_ARCHIVE_LIMIT = 500;

export interface ArchiveTaskFilter {
  /** Inclusive YYYY-MM-DD bounds on the day the task was completed. */
  from?: string;
  to?: string;
  projectId?: string;
  tagId?: string;
  search?: string;
  limit?: number;
  /** Comma-split field names, projected the same way `/api/tasks` does it, with `id` always kept. */
  fields?: string[];
}

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};

/** Local calendar day as YYYY-MM-DD (en-CA formats exactly so), matching how the rest of the bridge derives a day. */
export const dayOf = (epochMs: unknown): string | null =>
  typeof epochMs === 'number' && Number.isFinite(epochMs)
    ? new Date(epochMs).toLocaleDateString('en-CA')
    : null;

/**
 * Every archived task from both buckets, keyed by id.
 *
 * An id in both wins from young, the fresher copy: compaction rewrites tasks on the way to old (subtask time is merged into parents after a
 * year), so preferring young avoids handing back a lossier version of something still held in full.
 */
const mergedTasks = (state: Record<string, unknown>): Record<string, unknown>[] => {
  const bucket = (key: string): Record<string, unknown> =>
    asRecord(asRecord(asRecord(state[key]).task).entities);
  const merged = { ...bucket('ARCHIVE_OLD'), ...bucket('ARCHIVE_YOUNG') };
  return Object.values(merged).map(asRecord);
};

/**
 * Archived tasks matching `filter`, newest completion first, capped.
 *
 * The cap is a guard, not pagination: the archive grows without bound, and no default would turn one careless call into a full-history scan.
 */
export const listArchiveTasks = (
  state: Record<string, unknown>,
  filter: ArchiveTaskFilter = {},
): Record<string, unknown>[] => {
  let tasks = mergedTasks(state);

  if (filter.from || filter.to) {
    tasks = tasks.filter((t) => {
      const day = dayOf(t.doneOn);
      // Never completed, or completed before the app recorded it: not attributable to a day, so it cannot satisfy a date window.
      if (!day) return false;
      if (filter.from && day < filter.from) return false;
      if (filter.to && day > filter.to) return false;
      return true;
    });
  }
  if (filter.projectId !== undefined) {
    tasks = tasks.filter((t) => t.projectId === filter.projectId);
  }
  if (filter.tagId !== undefined) {
    tasks = tasks.filter(
      (t) => Array.isArray(t.tagIds) && (t.tagIds as string[]).includes(filter.tagId!),
    );
  }
  if (filter.search) {
    const q = filter.search.toLowerCase();
    tasks = tasks.filter(
      (t) =>
        String(t.title ?? '')
          .toLowerCase()
          .includes(q) ||
        String(t.notes ?? '')
          .toLowerCase()
          .includes(q),
    );
  }

  // Undated tasks sort last rather than being dropped: they are still real archived work, and silently hiding them would misreport a total.
  tasks.sort((a, b) => {
    const av = typeof a.doneOn === 'number' ? a.doneOn : -Infinity;
    const bv = typeof b.doneOn === 'number' ? b.doneOn : -Infinity;
    return bv - av;
  });

  const limit = filter.limit ?? DEFAULT_ARCHIVE_LIMIT;
  const capped = limit >= 0 ? tasks.slice(0, limit) : tasks;

  if (!filter.fields?.length) return capped;
  const keep = new Set(['id', ...filter.fields]);
  return capped.map((t) => {
    const out: Record<string, unknown> = {};
    for (const k of keep) if (k in t) out[k] = t[k];
    return out;
  });
};

/** One archived task by id, from either bucket, or undefined. */
export const getArchiveTask = (
  state: Record<string, unknown>,
  id: string,
): Record<string, unknown> | undefined => {
  const young = asRecord(asRecord(asRecord(state.ARCHIVE_YOUNG).task).entities)[id];
  const old = asRecord(asRecord(asRecord(state.ARCHIVE_OLD).task).entities)[id];
  const hit = young ?? old;
  return hit ? asRecord(hit) : undefined;
};

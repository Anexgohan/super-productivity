import {
  BoardCfg,
  BoardPanelCfg,
  BoardPanelCfgScheduledState,
  BoardPanelCfgTaskDoneState,
  BoardPanelCfgTaskTypeFilter,
  BoardSortField,
} from './boards.model';
import { TaskCopy } from '../tasks/task.model';
import { dateStrToUtcDate } from '../../util/date-str-to-utc-date';
import { moveItemInArray } from '../../util/move-item-in-array';

const VALID_SORT_FIELDS: ReadonlySet<BoardSortField> = new Set([
  'dueDate',
  'created',
  'title',
  'timeEstimate',
]);

// Absent `projectIds` (legacy data that hasn't been sanitized yet) means
// "All Projects", same as an array containing the "" sentinel.
export const isAllProjects = (projectIds: string[] | undefined): boolean =>
  !projectIds || projectIds.includes('');

export const firstSpecificProjectId = (
  projectIds: string[] | undefined,
): string | undefined => projectIds?.find((id) => id !== '');

/**
 * Normalizes a board's own project scope.
 * Absent/non-array (legacy or corrupted data) and any array containing the ""
 * sentinel both collapse to [""] — "unassigned", which is what the boards page
 * shows under "All Projects". Idempotent.
 */
export const sanitizeBoardProjectIds = (projectIds: string[] | undefined): string[] =>
  !Array.isArray(projectIds) || isAllProjects(projectIds) ? [''] : projectIds;

/**
 * Boards visible under a project scope.
 *
 * `scope` is a project id, or '' for "All Projects" (which shows everything).
 *
 * Strict: a board left unassigned ([''] ) belongs to no project and shows only
 * under "All Projects".
 *
 * The exception is a board whose assigned projects are all unknown to
 * `liveProjectIds`. That happens two ways — the project was deleted (which is
 * permanent and takes its tasks with it), or the board was shared from another
 * account whose projects are not ours — and in both cases the board would
 * otherwise be reachable under no scope at all. Showing it beats hiding it with
 * no way to get it back.
 */
export const filterBoardsByProjectScope = (
  boards: readonly BoardCfg[],
  scope: string,
  liveProjectIds: ReadonlySet<string>,
): BoardCfg[] => {
  if (!scope) {
    return [...boards];
  }
  return boards.filter((board) => {
    if (isAllProjects(board.projectIds)) {
      return false;
    }
    const assigned = board.projectIds as string[];
    return assigned.includes(scope) || !assigned.some((id) => liveProjectIds.has(id));
  });
};

/**
 * Translates a drag within the VISIBLE board list into a full board order.
 *
 * `sortBoards` takes every board id, but the tab strip may be showing a
 * filtered subset, so the dragged indices are positions in the visible list.
 * The visible ids are reordered among themselves and written back into the
 * slots those boards already occupied, so boards hidden by the current scope
 * keep their absolute positions. Without this a drag while filtered silently
 * reorders boards the user cannot see.
 */
export const remapVisibleOrderToFullOrder = (
  allBoards: readonly BoardCfg[],
  visibleBoards: readonly BoardCfg[],
  previousIndex: number,
  currentIndex: number,
): string[] => {
  const visibleIds = new Set(visibleBoards.map((b) => b.id));
  const reordered = moveItemInArray(
    visibleBoards.map((b) => b.id),
    previousIndex,
    currentIndex,
  );
  let next = 0;
  return allBoards.map((board) =>
    visibleIds.has(board.id) ? reordered[next++] : board.id,
  );
};

/**
 * Builds the copy of a board, optionally re-scoped to another project.
 *
 * A board holds no tasks — its panels are filters — so this copies structure
 * and re-points the scope. Two details matter:
 *
 *  - `taskIds` is dropped. It is manual card order over the SOURCE project's
 *    tasks, so it is meaningless anywhere else (and stale even in place).
 *  - Titles are resolved through `resolveTitle`. The starter boards store i18n
 *    KEYS as titles (`F.BOARDS.DEFAULT.KANBAN`) which the render pipe resolves;
 *    a copy is new data nothing will resolve again, so an unresolved key would
 *    become the copy's literal, permanent name.
 *
 * Tag filters are copied verbatim: tags are global, so a column keeps working
 * whatever project the copy lands in.
 *
 * `targetProjectIds` of `undefined` keeps the source's own scope.
 */
export const buildDuplicatedBoard = (
  source: BoardCfg,
  targetProjectIds: string[] | undefined,
  resolveTitle: (title: string) => string,
  copySuffix: string,
  newId: () => string,
): BoardCfg => ({
  id: newId(),
  title: `${resolveTitle(source.title)}${copySuffix}`,
  cols: source.cols,
  projectIds: sanitizeBoardProjectIds(targetProjectIds ?? source.projectIds),
  panels: (source.panels || []).map((panel) => ({
    ...panel,
    id: newId(),
    taskIds: [],
    title: resolveTitle(panel.title),
  })),
});

/**
 * Normalizes a panel cfg for persistence and hydration:
 * - Migrates legacy `sortByDue` → `sortBy`/`sortDir`.
 * - Coerces `null` values (from Formly) on optional string-union fields to absent.
 * - Drops unknown `sortBy` values (e.g. from a newer client synced down).
 * Idempotent.
 */
export const sanitizePanelCfg = (panel: BoardPanelCfg): BoardPanelCfg => {
  const out: BoardPanelCfg = { ...panel };

  // Migrate legacy `projectId` → `projectIds`.
  // Preference given to legacy `projectId` if present (even if `projectIds`
  // exists as [""] from overlaying DEFAULT_PANEL_CFG during migration).
  // NOTE: This preference is deliberate to ensure we don't lose the user's
  // choice if they had a specific project selected in an older version.
  const legacyPanel = out as BoardPanelCfg & { projectId?: string };
  if (legacyPanel.projectId !== undefined) {
    if (
      out.projectIds === undefined ||
      (Array.isArray(out.projectIds) &&
        out.projectIds.length === 1 &&
        out.projectIds[0] === '')
    ) {
      out.projectIds = [legacyPanel.projectId || ''];
    }
    delete legacyPanel.projectId;
  }

  // Ensure `projectIds` is always an array (e.g. if loaded from older client
  // that didn't run this migration yet).
  if (!Array.isArray(out.projectIds)) {
    out.projectIds = [''];
  }

  // Canonicalize any `projectIds` containing "" back to [""] (All Projects).
  // This is lossy: if "" (All Projects) co-occurs with specific IDs, the specific IDs
  // are dropped in favor of "All Projects".
  if (isAllProjects(out.projectIds)) {
    out.projectIds = [''];
  }

  if (out.sortByDue === 'asc' || out.sortByDue === 'desc') {
    out.sortBy = 'dueDate';
    out.sortDir = out.sortByDue;
  }
  delete (out as Partial<BoardPanelCfg>).sortByDue;

  // Drop `sortBy` if null/undefined OR unknown value — prevents buildComparator
  // from getting an unhandled field and returning undefined at runtime.
  if (out.sortBy == null || !VALID_SORT_FIELDS.has(out.sortBy)) {
    delete (out as Partial<BoardPanelCfg>).sortBy;
  }
  if (out.sortDir == null) {
    delete (out as Partial<BoardPanelCfg>).sortDir;
  }
  if (out.includedTagsMatch == null) {
    delete (out as Partial<BoardPanelCfg>).includedTagsMatch;
  }
  if (out.excludedTagsMatch == null) {
    delete (out as Partial<BoardPanelCfg>).excludedTagsMatch;
  }

  return out;
};

/**
 * Normalize a task's due moment to a comparable millisecond timestamp, or null
 * if undated. Timezone-safe: uses `dateStrToUtcDate` for YYYY-MM-DD strings,
 * matching task.selectors.ts.
 */
const getDueTs = (task: TaskCopy): number | null => {
  if (task.dueWithTime) return task.dueWithTime;
  if (task.dueDay) {
    return dateStrToUtcDate(task.dueDay).getTime();
  }
  return null;
};

const NO_OP_COMPARATOR = (): number => 0;

/**
 * Rewrite a task's tagIds so it will match the given panel's include/exclude
 * filter after a cross-panel drop. Pure function — never mutates inputs.
 *
 * Semantics (matches the panel-filter rules):
 * - Included tags:
 *   - Default ('all'): append every required tag (caller de-dupes if needed).
 *   - 'any': append the FIRST required tag only when the task has none of them.
 * - Excluded tags:
 *   - Default ('any'): strip ALL excluded tags the task carries.
 *   - 'all': strip only the FIRST excluded tag when the task has ALL excluded
 *     tags (breaks the AND-exclude condition without over-removing).
 *
 * Duplicates are not de-duplicated here; callers that care should pass the
 * result through `unique()`.
 */
export const rewriteTagIdsForPanel = (
  currentTagIds: readonly string[],
  panelCfg: Pick<
    BoardPanelCfg,
    'includedTagIds' | 'includedTagsMatch' | 'excludedTagIds' | 'excludedTagsMatch'
  >,
): string[] => {
  let next: string[] = [...currentTagIds];

  if (panelCfg.includedTagIds?.length) {
    if (panelCfg.includedTagsMatch === 'any') {
      const hasAny = panelCfg.includedTagIds.some((id) => next.includes(id));
      if (!hasAny) {
        next = next.concat(panelCfg.includedTagIds[0]);
      }
    } else {
      next = next.concat(panelCfg.includedTagIds);
    }
  }

  if (panelCfg.excludedTagIds?.length) {
    if (panelCfg.excludedTagsMatch === 'all') {
      const hasAll = panelCfg.excludedTagIds.every((id) => next.includes(id));
      if (hasAll) {
        const firstExcluded = panelCfg.excludedTagIds[0];
        next = next.filter((id) => id !== firstExcluded);
      }
    } else {
      const excluded = panelCfg.excludedTagIds;
      next = next.filter((id) => !excluded.includes(id));
    }
  }

  return next;
};

/**
 * Pure membership predicate: does `task` belong in a panel/column with the
 * given criteria? Companion to `rewriteTagIdsForPanel` (which rewrites a task's
 * tags TO match) — the two encode the same tag rules and must stay in sync.
 *
 * `isInBacklog` is supplied by the caller because backlog membership derives
 * from project state, not from the task itself. It is only consulted when
 * `panelCfg.backlogState` requests backlog filtering.
 */
export const doesTaskMatchPanel = (
  task: Readonly<TaskCopy>,
  panelCfg: Pick<
    BoardPanelCfg,
    | 'includedTagIds'
    | 'includedTagsMatch'
    | 'excludedTagIds'
    | 'excludedTagsMatch'
    | 'isParentTasksOnly'
    | 'taskDoneState'
    | 'projectIds'
    | 'scheduledState'
    | 'backlogState'
  >,
  isInBacklog: (task: Readonly<TaskCopy>) => boolean,
): boolean => {
  const taskTagIds = task.tagIds ?? [];

  if (panelCfg.includedTagIds?.length) {
    const matches =
      panelCfg.includedTagsMatch === 'any'
        ? panelCfg.includedTagIds.some((tagId) => taskTagIds.includes(tagId))
        : panelCfg.includedTagIds.every((tagId) => taskTagIds.includes(tagId));
    if (!matches) return false;
  }

  if (panelCfg.excludedTagIds?.length) {
    const hit =
      panelCfg.excludedTagsMatch === 'all'
        ? panelCfg.excludedTagIds.every((tagId) => taskTagIds.includes(tagId))
        : panelCfg.excludedTagIds.some((tagId) => taskTagIds.includes(tagId));
    if (hit) return false;
  }

  if (panelCfg.isParentTasksOnly && task.parentId) {
    return false;
  }

  if (panelCfg.taskDoneState === BoardPanelCfgTaskDoneState.Done && !task.isDone) {
    return false;
  }
  if (panelCfg.taskDoneState === BoardPanelCfgTaskDoneState.UnDone && task.isDone) {
    return false;
  }

  if (
    panelCfg.projectIds &&
    panelCfg.projectIds.length > 0 &&
    !isAllProjects(panelCfg.projectIds) &&
    !panelCfg.projectIds.includes(task.projectId)
  ) {
    return false;
  }

  if (
    panelCfg.scheduledState === BoardPanelCfgScheduledState.Scheduled &&
    !(task.dueWithTime || task.dueDay)
  ) {
    return false;
  }
  if (
    panelCfg.scheduledState === BoardPanelCfgScheduledState.NotScheduled &&
    (task.dueWithTime || task.dueDay)
  ) {
    return false;
  }

  if (
    panelCfg.backlogState === BoardPanelCfgTaskTypeFilter.OnlyBacklog &&
    !isInBacklog(task)
  ) {
    return false;
  }
  if (
    panelCfg.backlogState === BoardPanelCfgTaskTypeFilter.NoBacklog &&
    isInBacklog(task)
  ) {
    return false;
  }

  return true;
};

/**
 * Returns an ascending comparator for the given field. Callers multiply by -1
 * for descending. Returns a no-op comparator for unknown fields, so an invalid
 * persisted `sortBy` degrades to manual order instead of crashing the panel.
 */
export const buildComparator = (
  field: BoardSortField,
): ((a: TaskCopy, b: TaskCopy) => number) => {
  switch (field) {
    case 'title':
      return (a, b) => (a.title || '').localeCompare(b.title || '');
    case 'created':
      return (a, b) => (a.created || 0) - (b.created || 0);
    case 'timeEstimate':
      return (a, b) => (a.timeEstimate || 0) - (b.timeEstimate || 0);
    case 'dueDate':
      return (a, b) => {
        // Fast path: both have only dueDay (string) → lex compare (YYYY-MM-DD
        // is fixed-width, so < / > work and are faster than localeCompare).
        if (!a.dueWithTime && !b.dueWithTime && a.dueDay && b.dueDay) {
          return a.dueDay < b.dueDay ? -1 : a.dueDay > b.dueDay ? 1 : 0;
        }
        const aTs = getDueTs(a);
        const bTs = getDueTs(b);
        if (aTs === null && bTs === null) return 0;
        // Nulls last in ascending order — caller reverses for descending.
        if (aTs === null) return 1;
        if (bTs === null) return -1;
        return aTs - bTs;
      };
    default:
      return NO_OP_COMPARATOR;
  }
};

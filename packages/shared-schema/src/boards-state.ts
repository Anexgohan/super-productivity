/**
 * Board state rules shared by every writer: the browser's boards reducer and the bridge's materializer both call these, so a board reads the same wherever it was edited.
 * Everything here is pure and deterministic, because each client replays the same ops through it.
 */
import {
  BOARD_TAG_IDS,
  BoardCfg,
  BoardPanelCfg,
  BoardPanelCfgScheduledState,
  BoardPanelCfgTaskDoneState,
  BoardPanelCfgTaskTypeFilter,
  BoardSortField,
  sanitizeBoardProjectIds,
} from './boards';

export const DEFAULT_BOARD_CFG: BoardCfg = {
  id: '',
  cols: 1,
  panels: [],
  title: '',
  projectIds: [''],
};

/** What a new column starts as, from the board editor and from `POST /api/boards/:id/panels` alike. */
export const DEFAULT_PANEL_CFG: BoardPanelCfg = {
  id: '',
  title: '',
  taskIds: [],
  taskDoneState: BoardPanelCfgTaskDoneState.All,
  excludedTagIds: [],
  includedTagIds: [],
  scheduledState: BoardPanelCfgScheduledState.All,
  backlogState: BoardPanelCfgTaskTypeFilter.All,
  isParentTasksOnly: false,
  projectIds: [''],
};

const VALID_SORT_FIELDS: ReadonlySet<BoardSortField> = new Set([
  'dueDate',
  'created',
  'title',
  'timeEstimate',
]);

/**
 * Normalizes a panel cfg for persistence and hydration. Idempotent.
 * - Migrates legacy `projectId` → `projectIds` and collapses every "All Projects" form to [""].
 * - Migrates legacy `sortByDue` → `sortBy`/`sortDir`, and drops unknown `sortBy` values (e.g. from a newer client).
 * - Removes `null` optional fields (Formly writes them).
 */
export const sanitizePanelCfg = (panel: BoardPanelCfg): BoardPanelCfg => {
  const out: BoardPanelCfg = { ...panel };

  // A legacy `projectId` wins over a [""] that only came from overlaying defaults, so an old specific-project choice survives.
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

  out.projectIds = sanitizeBoardProjectIds(out.projectIds);

  if (out.sortByDue === 'asc' || out.sortByDue === 'desc') {
    out.sortBy = 'dueDate';
    out.sortDir = out.sortByDue;
  }
  delete (out as Partial<BoardPanelCfg>).sortByDue;

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

export const sanitizeBoard = (board: BoardCfg): BoardCfg => ({
  ...board,
  projectIds: sanitizeBoardProjectIds(board.projectIds),
  panels: (Array.isArray(board.panels) ? board.panels : []).map(sanitizePanelCfg),
});

/** #7666: corrupted stored payloads left `boardCfgs` or a board's `panels` undefined; coerce the arrays before anything else touches them. */
export const normalizeLoadedBoards = (boardCfgs: unknown): BoardCfg[] =>
  (Array.isArray(boardCfgs) ? (boardCfgs as BoardCfg[]) : []).map((board) => ({
    ...board,
    panels: Array.isArray(board?.panels) ? board.panels : [],
  }));

/**
 * #7498: the default Kanban DONE column shipped excluding the in-progress tag, which hid finished tasks still carrying it. Idempotent.
 * It runs on every load and cannot tell the old default from a user's choice; that is accepted only because excluding in-progress from a Done column is not a plausible deliberate choice (#8723 removed the Eisenhower equivalent for exactly that reason).
 */
export const fixBuggyDefaultBoardFilters = (boardCfgs: BoardCfg[]): BoardCfg[] => {
  let changed = false;
  const out = boardCfgs.map((board) => {
    if (board.id !== 'KANBAN_DEFAULT') return board;
    let boardChanged = false;
    const panels = board.panels.map((panel) => {
      if (
        panel.id !== 'DONE' ||
        !panel.excludedTagIds?.includes(BOARD_TAG_IDS.inProgress)
      ) {
        return panel;
      }
      boardChanged = true;
      return {
        ...panel,
        excludedTagIds: panel.excludedTagIds.filter(
          (id) => id !== BOARD_TAG_IDS.inProgress,
        ),
      };
    });
    if (!boardChanged) return board;
    changed = true;
    return { ...board, panels };
  });
  return changed ? out : boardCfgs;
};

/** The deterministic load repairs, applied to boards read whole from storage or a full-state import. */
export const repairLoadedBoards = (boardCfgs: BoardCfg[]): BoardCfg[] =>
  fixBuggyDefaultBoardFilters(boardCfgs).map(sanitizeBoard);

export const addBoardToState = (boardCfgs: BoardCfg[], board: BoardCfg): BoardCfg[] => [
  ...boardCfgs,
  sanitizeBoard(board),
];

export const updateBoardInState = (
  boardCfgs: BoardCfg[],
  id: string,
  updates: Partial<BoardCfg>,
): BoardCfg[] => {
  const sanitized: Partial<BoardCfg> = { ...updates };
  if (updates.panels) sanitized.panels = updates.panels.map(sanitizePanelCfg);
  if (updates.projectIds)
    sanitized.projectIds = sanitizeBoardProjectIds(updates.projectIds);
  return boardCfgs.map((cfg) => (cfg.id === id ? { ...cfg, ...sanitized } : cfg));
};

export const removeBoardFromState = (boardCfgs: BoardCfg[], id: string): BoardCfg[] =>
  boardCfgs.filter((cfg) => cfg.id !== id);

/** Boards missing from `ids` survive at the tail, so a stale sort from another client never deletes a new board. */
export const sortBoardsInState = (boardCfgs: BoardCfg[], ids: string[]): BoardCfg[] => {
  const byId = new Map(boardCfgs.map((b) => [b.id, b]));
  const ordered = ids.map((id) => byId.get(id)).filter((b): b is BoardCfg => !!b);
  const seen = new Set(ids);
  return [...ordered, ...boardCfgs.filter((b) => !seen.has(b.id))];
};

/** Only the first board holding `panelId` is touched; duplicate panel ids are a load-time repair, not something to fan out to. */
export const updatePanelTaskIdsInState = (
  boardCfgs: BoardCfg[],
  panelId: string,
  taskIds: string[],
): BoardCfg[] => {
  const owner = boardCfgs.find((cfg) => cfg.panels.some((p) => p.id === panelId));
  if (!owner) return boardCfgs;
  return boardCfgs.map((cfg) =>
    cfg === owner
      ? {
          ...cfg,
          panels: cfg.panels.map((p) => (p.id === panelId ? { ...p, taskIds } : p)),
        }
      : cfg,
  );
};

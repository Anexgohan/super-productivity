import { createFeature, createReducer, on } from '@ngrx/store';
import { BoardsActions } from './boards.actions';
import { BoardCfg } from '../boards.model';
import { DEFAULT_BOARDS } from '../boards.const';
import { loadAllData } from '../../../root-store/meta/load-all-data.action';
import { nanoid } from 'nanoid';
import {
  addBoardToState,
  fixBuggyDefaultBoardFilters as fixBuggyDefaultBoardCfgs,
  normalizeLoadedBoards,
  removeBoardFromState,
  repairLoadedBoards,
  sortBoardsInState,
  updateBoardInState,
  updatePanelTaskIdsInState,
} from '@sp/shared-schema';

export const BOARDS_FEATURE_NAME = 'boards';

export interface BoardsState {
  boardCfgs: BoardCfg[];
}

export const initialBoardsState: BoardsState = {
  boardCfgs: DEFAULT_BOARDS,
};

/** State-shaped wrapper over the shared #7498 repair (see `fixBuggyDefaultBoardFilters` in `@sp/shared-schema`). */
export const fixBuggyDefaultBoardFilters = (boardsState: BoardsState): BoardsState => {
  const boardCfgs = fixBuggyDefaultBoardCfgs(boardsState.boardCfgs);
  return boardCfgs === boardsState.boardCfgs
    ? boardsState
    : { ...boardsState, boardCfgs };
};

/**
 * Fix for #6983: Replace duplicate panel IDs across boards with unique ones.
 * Boards duplicated before the fix in 99d9fac reused panel IDs from the original,
 * causing updatePanelCfgTaskIds to always match the first board's panel.
 * Browser-only: the new ids are random and never synced, so the bridge must not mint its own.
 */
export const deduplicatePanelIds = (boardsState: BoardsState): BoardsState => {
  const seenIds = new Set<string>();
  let changed = false;

  const boardCfgs = boardsState.boardCfgs.map((board) => {
    let boardChanged = false;
    const panels = board.panels.map((panel) => {
      if (seenIds.has(panel.id)) {
        changed = true;
        boardChanged = true;
        return { ...panel, id: nanoid() };
      }
      seenIds.add(panel.id);
      return panel;
    });
    return boardChanged ? { ...board, panels } : board;
  });

  return changed ? { ...boardsState, boardCfgs } : boardsState;
};

export const boardsReducer = createReducer(
  initialBoardsState,
  on(loadAllData, (state, { appDataComplete }) =>
    appDataComplete.boards
      ? {
          ...appDataComplete.boards,
          boardCfgs: repairLoadedBoards(
            deduplicatePanelIds({
              boardCfgs: normalizeLoadedBoards(appDataComplete.boards?.boardCfgs),
            }).boardCfgs,
          ),
        }
      : state,
  ),

  on(BoardsActions.addBoard, (state, { board }) => ({
    ...state,
    boardCfgs: addBoardToState(state.boardCfgs, board),
  })),

  on(BoardsActions.updateBoard, (state, { id, updates }) => ({
    ...state,
    boardCfgs: updateBoardInState(state.boardCfgs, id, updates),
  })),

  on(BoardsActions.removeBoard, (state, { id }) => ({
    ...state,
    boardCfgs: removeBoardFromState(state.boardCfgs, id),
  })),

  on(BoardsActions.sortBoards, (state, { ids }) => ({
    ...state,
    boardCfgs: sortBoardsInState(state.boardCfgs, ids),
  })),

  on(BoardsActions.updatePanelCfgTaskIds, (state, { panelId, taskIds }) => {
    const boardCfgs = updatePanelTaskIdsInState(state.boardCfgs, panelId, taskIds);
    return boardCfgs === state.boardCfgs ? state : { ...state, boardCfgs };
  }),
);

export const boardsFeature = createFeature({
  name: BOARDS_FEATURE_NAME,
  reducer: boardsReducer,
});

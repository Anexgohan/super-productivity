import { describe, expect, it } from 'vitest';
import {
  BoardCfg,
  BoardPanelCfg,
  BoardPanelCfgTaskDoneState,
  DEFAULT_PANEL_CFG,
  addBoardToState,
  fixBuggyDefaultBoardFilters,
  normalizeLoadedBoards,
  removeBoardFromState,
  repairLoadedBoards,
  sanitizePanelCfg,
  sortBoardsInState,
  updateBoardInState,
  updatePanelTaskIdsInState,
} from '../src';

const panel = (id: string, extra: Partial<BoardPanelCfg> = {}): BoardPanelCfg => ({
  ...DEFAULT_PANEL_CFG,
  id,
  title: id,
  ...extra,
});
const board = (
  id: string,
  panels: BoardPanelCfg[] = [],
  extra: Partial<BoardCfg> = {},
): BoardCfg => ({
  id,
  title: id,
  cols: 1,
  panels,
  projectIds: [''],
  ...extra,
});

describe('DEFAULT_PANEL_CFG', () => {
  it('shows done and undone tasks with the backlog included', () => {
    expect(DEFAULT_PANEL_CFG.taskDoneState).toBe(BoardPanelCfgTaskDoneState.All);
    expect(DEFAULT_PANEL_CFG.backlogState).toBe(1);
  });
});

describe('sanitizePanelCfg', () => {
  it('migrates a legacy projectId over a defaulted sentinel', () => {
    const out = sanitizePanelCfg({
      ...panel('a', { projectIds: [''] }),
      projectId: 'p1',
    } as BoardPanelCfg);
    expect(out.projectIds).toEqual(['p1']);
    expect('projectId' in out).toBe(false);
  });

  it('collapses an empty project list to the sentinel', () => {
    expect(sanitizePanelCfg(panel('a', { projectIds: [] })).projectIds).toEqual(['']);
  });

  it('migrates sortByDue and drops unknown sort fields', () => {
    expect(sanitizePanelCfg(panel('a', { sortByDue: 'desc' })).sortBy).toBe('dueDate');
    const bad = sanitizePanelCfg(panel('a', { sortBy: 'nope' as never }));
    expect('sortBy' in bad).toBe(false);
  });

  it('is idempotent', () => {
    const once = sanitizePanelCfg(panel('a', { sortByDue: 'asc', projectIds: [] }));
    expect(sanitizePanelCfg(once)).toEqual(once);
  });
});

describe('board state changes', () => {
  it('sanitizes an added board', () => {
    const out = addBoardToState(
      [],
      board('b', [panel('a', { projectIds: [] })], { projectIds: ['', 'p1'] }),
    );
    expect(out[0].projectIds).toEqual(['']);
    expect(out[0].panels[0].projectIds).toEqual(['']);
  });

  it('sanitizes project ids and panels in an update, and touches only that board', () => {
    const other = board('o');
    const out = updateBoardInState([board('b'), other], 'b', {
      projectIds: ['', 'p1'],
      panels: [panel('a', { projectIds: [] })],
    });
    expect(out[0].projectIds).toEqual(['']);
    expect(out[0].panels[0].projectIds).toEqual(['']);
    expect(out[1]).toBe(other);
  });

  it('removes a board', () => {
    expect(removeBoardFromState([board('a'), board('b')], 'a').map((b) => b.id)).toEqual([
      'b',
    ]);
  });

  it('keeps boards missing from a sort at the tail', () => {
    const out = sortBoardsInState([board('a'), board('b'), board('c')], ['c', 'a', 'zz']);
    expect(out.map((b) => b.id)).toEqual(['c', 'a', 'b']);
  });

  it('sets card order on the first board holding the panel only', () => {
    const boards = [board('a', [panel('p')]), board('b', [panel('p')])];
    const out = updatePanelTaskIdsInState(boards, 'p', ['t1']);
    expect(out[0].panels[0].taskIds).toEqual(['t1']);
    expect(out[1]).toBe(boards[1]);
  });

  it('returns the same array when no board holds the panel', () => {
    const boards = [board('a', [panel('p')])];
    expect(updatePanelTaskIdsInState(boards, 'zz', ['t1'])).toBe(boards);
  });
});

describe('load repairs', () => {
  it('coerces corrupted arrays', () => {
    expect(normalizeLoadedBoards(undefined)).toEqual([]);
    const out = normalizeLoadedBoards([{ id: 'a', panels: undefined }]);
    expect(out[0].panels).toEqual([]);
  });

  it('drops the in-progress exclusion from the default Kanban Done column only', () => {
    const done = panel('DONE', { excludedTagIds: ['KANBAN_IN_PROGRESS', 'x'] });
    const boards = [board('KANBAN_DEFAULT', [done]), board('OTHER', [done])];
    const out = fixBuggyDefaultBoardFilters(boards);
    expect(out[0].panels[0].excludedTagIds).toEqual(['x']);
    expect(out[1]).toBe(boards[1]);
  });

  it('returns the same array when nothing needs fixing', () => {
    const boards = [board('KANBAN_DEFAULT', [panel('DONE')])];
    expect(fixBuggyDefaultBoardFilters(boards)).toBe(boards);
  });

  it('repairs and sanitizes in one pass', () => {
    const out = repairLoadedBoards([
      board('b', [panel('a', { projectIds: [] })], { projectIds: [] }),
    ]);
    expect(out[0].projectIds).toEqual(['']);
    expect(out[0].panels[0].projectIds).toEqual(['']);
  });
});

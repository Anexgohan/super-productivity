import {
  buildComparator,
  buildDuplicatedBoard,
  doesTaskMatchPanel,
  filterBoardsByProjectScope,
  remapVisibleOrderToFullOrder,
  rewriteTagIdsForPanel,
  sanitizeBoardProjectIds,
  sanitizePanelCfg,
} from './boards.util';
import {
  BoardPanelCfg,
  BoardPanelCfgScheduledState,
  BoardPanelCfgTaskDoneState,
  BoardPanelCfgTaskTypeFilter,
} from './boards.model';
import { TaskCopy } from '../tasks/task.model';
import { BoardCfg } from './boards.model';

const basePanel: any = {
  id: 'p1',
  title: 'Panel',
  taskIds: [],
  includedTagIds: [],
  excludedTagIds: [],
  taskDoneState: 1,
  scheduledState: 1,
  isParentTasksOnly: false,
  projectIds: [''],
};

describe('sanitizePanelCfg', () => {
  it('migrates legacy projectId to projectIds array', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { projectIds, ...inputWithoutProjectIds } = basePanel;
    const out = sanitizePanelCfg({ ...inputWithoutProjectIds, projectId: 'p1' } as any);
    expect(out.projectIds).toEqual(['p1']);
    expect('projectId' in out).toBe(false);
  });

  it('migrates legacy empty projectId to projectIds [""]', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { projectIds, ...inputWithoutProjectIds } = basePanel;
    const out = sanitizePanelCfg({ ...inputWithoutProjectIds, projectId: '' } as any);
    expect(out.projectIds).toEqual(['']);
    expect('projectId' in out).toBe(false);
  });

  it('ensures projectIds is always an array', () => {
    const out = sanitizePanelCfg({ ...basePanel, projectIds: null as any } as any);
    expect(out.projectIds).toEqual(['']);
  });

  it('migrates legacy projectId even if projectIds is already defaulted to [""]', () => {
    const out = sanitizePanelCfg({
      ...basePanel,
      projectIds: [''],
      projectId: 'p1',
    } as any);
    expect(out.projectIds).toEqual(['p1']);
    expect('projectId' in out).toBe(false);
  });

  it('deliberately drops specific IDs when "" co-occurs (lossy canonicalization)', () => {
    const out = sanitizePanelCfg({ ...basePanel, projectIds: ['', 'p1', 'p2'] } as any);
    expect(out.projectIds).toEqual(['']);
  });

  it('migrates sortByDue=asc to sortBy=dueDate/asc and drops sortByDue', () => {
    const out = sanitizePanelCfg({ ...basePanel, sortByDue: 'asc' } as any);
    expect(out.sortBy).toBe('dueDate');
    expect(out.sortDir).toBe('asc');
    expect('sortByDue' in out).toBe(false);
  });

  it('migrates sortByDue=desc to sortBy=dueDate/desc', () => {
    const out = sanitizePanelCfg({ ...basePanel, sortByDue: 'desc' } as any);
    expect(out.sortBy).toBe('dueDate');
    expect(out.sortDir).toBe('desc');
    expect('sortByDue' in out).toBe(false);
  });

  it('drops sortByDue=off without adding sortBy', () => {
    const out = sanitizePanelCfg({ ...basePanel, sortByDue: 'off' } as any);
    expect(out.sortBy).toBeUndefined();
    expect(out.sortDir).toBeUndefined();
    expect('sortByDue' in out).toBe(false);
  });

  it('coerces null sortBy/sortDir/match-mode fields to absent', () => {
    const out = sanitizePanelCfg({
      ...basePanel,
      sortBy: null as any,
      sortDir: null as any,
      includedTagsMatch: null as any,
      excludedTagsMatch: null as any,
    } as any);
    expect('sortBy' in out).toBe(false);
    expect('sortDir' in out).toBe(false);
    expect('includedTagsMatch' in out).toBe(false);
    expect('excludedTagsMatch' in out).toBe(false);
  });

  it('drops unknown sortBy values (e.g. from a newer client)', () => {
    const out = sanitizePanelCfg({
      ...basePanel,
      sortBy: 'priority' as any,
      sortDir: 'asc',
    } as any);
    expect('sortBy' in out).toBe(false);
    // sortDir stays — it's valid on its own; it'll just go unused.
    expect(out.sortDir).toBe('asc');
  });

  it('preserves valid sortBy/sortDir', () => {
    const out = sanitizePanelCfg({
      ...basePanel,
      sortBy: 'title',
      sortDir: 'desc',
      includedTagsMatch: 'any',
      excludedTagsMatch: 'all',
    } as any);
    expect(out.sortBy).toBe('title');
    expect(out.sortDir).toBe('desc');
    expect(out.includedTagsMatch).toBe('any');
    expect(out.excludedTagsMatch).toBe('all');
  });

  it('is idempotent', () => {
    const once = sanitizePanelCfg({ ...basePanel, sortByDue: 'asc' } as any);
    const twice = sanitizePanelCfg(once);
    expect(twice).toEqual(once);
  });
});

describe('sanitizeBoardProjectIds', () => {
  it('treats absent as unassigned', () => {
    expect(sanitizeBoardProjectIds(undefined)).toEqual(['']);
  });

  it('treats a non-array (corrupted data) as unassigned', () => {
    expect(sanitizeBoardProjectIds('P1' as unknown as string[])).toEqual(['']);
  });

  it('leaves the unassigned sentinel alone', () => {
    expect(sanitizeBoardProjectIds([''])).toEqual(['']);
  });

  it('keeps a specific project', () => {
    expect(sanitizeBoardProjectIds(['P1'])).toEqual(['P1']);
  });

  it('collapses a mix of sentinel and specific ids to unassigned', () => {
    // Same lossy canonicalization sanitizePanelCfg applies: "All" wins.
    expect(sanitizeBoardProjectIds(['', 'P1'])).toEqual(['']);
  });

  it('is idempotent', () => {
    const once = sanitizeBoardProjectIds(['P1']);
    expect(sanitizeBoardProjectIds(once)).toEqual(once);
    const allOnce = sanitizeBoardProjectIds(['', 'P1']);
    expect(sanitizeBoardProjectIds(allOnce)).toEqual(allOnce);
  });
});

const makeTestBoard = (id: string, projectIds: string[] | undefined): BoardCfg =>
  ({ id, title: id, cols: 1, panels: [], projectIds }) as BoardCfg;

describe('filterBoardsByProjectScope', () => {
  const live = new Set(['P1', 'P2']);

  it('returns every board under All Projects', () => {
    const boards = [makeTestBoard('a', ['']), makeTestBoard('b', ['P1'])];
    expect(filterBoardsByProjectScope(boards, '', live).map((b) => b.id)).toEqual([
      'a',
      'b',
    ]);
  });

  it('shows only boards assigned to the scoped project', () => {
    const boards = [makeTestBoard('a', ['P1']), makeTestBoard('b', ['P2'])];
    expect(filterBoardsByProjectScope(boards, 'P1', live).map((b) => b.id)).toEqual([
      'a',
    ]);
  });

  it('hides unassigned boards when a project is scoped', () => {
    const boards = [makeTestBoard('a', ['']), makeTestBoard('b', ['P1'])];
    expect(filterBoardsByProjectScope(boards, 'P1', live).map((b) => b.id)).toEqual([
      'b',
    ]);
  });

  it('treats absent projectIds as unassigned', () => {
    const boards = [makeTestBoard('a', undefined)];
    expect(filterBoardsByProjectScope(boards, 'P1', live)).toEqual([]);
  });

  it('shows a multi-project board under each of its projects', () => {
    const boards = [makeTestBoard('a', ['P1', 'P2'])];
    expect(filterBoardsByProjectScope(boards, 'P1', live).map((b) => b.id)).toEqual([
      'a',
    ]);
    expect(filterBoardsByProjectScope(boards, 'P2', live).map((b) => b.id)).toEqual([
      'a',
    ]);
  });

  it('keeps a board whose project was deleted visible rather than orphaning it', () => {
    const boards = [makeTestBoard('gone', ['DELETED'])];
    expect(filterBoardsByProjectScope(boards, 'P1', live).map((b) => b.id)).toEqual([
      'gone',
    ]);
  });

  it('keeps a shared board scoped to a foreign account project visible', () => {
    // Read via ?boardOf=: the owner's project ids mean nothing here.
    const boards = [makeTestBoard('shared', ['THEIR_PROJECT'])];
    expect(filterBoardsByProjectScope(boards, 'P1', live).map((b) => b.id)).toEqual([
      'shared',
    ]);
  });

  it('still hides a board that names a live project other than the scope', () => {
    const boards = [makeTestBoard('other', ['P2'])];
    expect(filterBoardsByProjectScope(boards, 'P1', live)).toEqual([]);
  });
});

describe('buildDuplicatedBoard', () => {
  // Mimics the translate pipe: starter titles are i18n keys, everything else is
  // already real text and passes through.
  const resolve = (t: string): string =>
    t === 'F.BOARDS.DEFAULT.KANBAN'
      ? 'Kanban'
      : t === 'F.BOARDS.DEFAULT.TO_DO'
        ? 'To Do'
        : t;

  let n = 0;
  const newId = (): string => `id-${++n}`;
  beforeEach(() => (n = 0));

  const source = {
    id: 'src',
    title: 'F.BOARDS.DEFAULT.KANBAN',
    cols: 3,
    projectIds: ['P1'],
    panels: [
      {
        id: 'p1',
        title: 'F.BOARDS.DEFAULT.TO_DO',
        taskIds: ['t1', 't2'],
        includedTagIds: ['TAG_A'],
        excludedTagIds: ['TAG_B'],
        taskDoneState: 1,
        scheduledState: 1,
        isParentTasksOnly: false,
        projectIds: [''],
      },
    ],
  } as unknown as BoardCfg;

  it('resolves an i18n key title so the copy is not named after the key', () => {
    const copy = buildDuplicatedBoard(source, undefined, resolve, ' (copy)', newId);
    expect(copy.title).toBe('Kanban (copy)');
    expect(copy.title).not.toContain('F.BOARDS.DEFAULT');
  });

  it('resolves panel titles too', () => {
    const copy = buildDuplicatedBoard(source, undefined, resolve, ' (copy)', newId);
    expect(copy.panels[0].title).toBe('To Do');
  });

  it('keeps the source scope when no target is given', () => {
    const copy = buildDuplicatedBoard(source, undefined, resolve, ' (copy)', newId);
    expect(copy.projectIds).toEqual(['P1']);
  });

  it('re-scopes to the target project', () => {
    const copy = buildDuplicatedBoard(source, ['P2'], resolve, ' (copy)', newId);
    expect(copy.projectIds).toEqual(['P2']);
  });

  it('normalizes an unassigned target to the sentinel', () => {
    const copy = buildDuplicatedBoard(source, [''], resolve, ' (copy)', newId);
    expect(copy.projectIds).toEqual(['']);
  });

  it("drops taskIds — manual order over the source project's tasks", () => {
    const copy = buildDuplicatedBoard(source, ['P2'], resolve, ' (copy)', newId);
    expect(copy.panels[0].taskIds).toEqual([]);
  });

  it('copies tag filters verbatim, since tags are global', () => {
    const copy = buildDuplicatedBoard(source, ['P2'], resolve, ' (copy)', newId);
    expect(copy.panels[0].includedTagIds).toEqual(['TAG_A']);
    expect(copy.panels[0].excludedTagIds).toEqual(['TAG_B']);
  });

  it('gives the board and every panel fresh ids', () => {
    const copy = buildDuplicatedBoard(source, ['P2'], resolve, ' (copy)', newId);
    expect(copy.id).not.toBe(source.id);
    expect(copy.panels[0].id).not.toBe('p1');
  });

  it('leaves the source untouched', () => {
    const before = JSON.stringify(source);
    buildDuplicatedBoard(source, ['P2'], resolve, ' (copy)', newId);
    expect(JSON.stringify(source)).toBe(before);
  });
});

describe('remapVisibleOrderToFullOrder', () => {
  it('reorders normally when nothing is filtered out', () => {
    const all = [
      makeTestBoard('a', ['']),
      makeTestBoard('b', ['']),
      makeTestBoard('c', ['']),
    ];
    expect(remapVisibleOrderToFullOrder(all, all, 0, 2)).toEqual(['b', 'c', 'a']);
  });

  it('leaves hidden boards in their absolute positions', () => {
    const all = [
      makeTestBoard('a', ['P1']),
      makeTestBoard('hidden', ['P2']),
      makeTestBoard('b', ['P1']),
    ];
    const visible = [all[0], all[2]];
    // Swap the two visible boards; 'hidden' must stay at index 1.
    expect(remapVisibleOrderToFullOrder(all, visible, 0, 1)).toEqual([
      'b',
      'hidden',
      'a',
    ]);
  });

  it('returns a full permutation of every board id', () => {
    const all = [
      makeTestBoard('a', ['P1']),
      makeTestBoard('hidden', ['P2']),
      makeTestBoard('b', ['P1']),
      makeTestBoard('c', ['P1']),
    ];
    const visible = [all[0], all[2], all[3]];
    const ids = remapVisibleOrderToFullOrder(all, visible, 2, 0);
    expect(ids.length).toBe(all.length);
    expect([...ids].sort()).toEqual(['a', 'b', 'c', 'hidden']);
  });
});

describe('buildComparator', () => {
  const mk = (partial: Partial<TaskCopy>): TaskCopy =>
    ({ id: '', title: '', created: 0, timeEstimate: 0, ...partial }) as TaskCopy;

  describe('title', () => {
    it('sorts asc by title', () => {
      const cmp = buildComparator('title');
      const items = [mk({ title: 'b' }), mk({ title: 'a' }), mk({ title: 'c' })];
      items.sort(cmp);
      expect(items.map((t) => t.title)).toEqual(['a', 'b', 'c']);
    });
  });

  describe('created', () => {
    it('sorts asc by created timestamp', () => {
      const cmp = buildComparator('created');
      const items = [mk({ created: 300 }), mk({ created: 100 }), mk({ created: 200 })];
      items.sort(cmp);
      expect(items.map((t) => t.created)).toEqual([100, 200, 300]);
    });
  });

  describe('timeEstimate', () => {
    it('treats missing timeEstimate as 0', () => {
      const cmp = buildComparator('timeEstimate');
      const items = [
        mk({ timeEstimate: 500 }),
        mk({ timeEstimate: undefined }),
        mk({ timeEstimate: 100 }),
      ];
      items.sort(cmp);
      expect(items.map((t) => t.timeEstimate ?? 0)).toEqual([0, 100, 500]);
    });
  });

  describe('dueDate', () => {
    it('orders tasks with only dueDay lexicographically', () => {
      const cmp = buildComparator('dueDate');
      const items = [
        mk({ id: 'c', dueDay: '2026-03-03' }),
        mk({ id: 'a', dueDay: '2026-01-01' }),
        mk({ id: 'b', dueDay: '2026-02-02' }),
      ];
      items.sort(cmp);
      expect(items.map((t) => t.id)).toEqual(['a', 'b', 'c']);
    });

    it('orders tasks with only dueWithTime by timestamp', () => {
      const cmp = buildComparator('dueDate');
      const items = [
        mk({ id: 'c', dueWithTime: 3000 }),
        mk({ id: 'a', dueWithTime: 1000 }),
        mk({ id: 'b', dueWithTime: 2000 }),
      ];
      items.sort(cmp);
      expect(items.map((t) => t.id)).toEqual(['a', 'b', 'c']);
    });

    it('sorts undated tasks after dated ones in asc', () => {
      const cmp = buildComparator('dueDate');
      const items = [
        mk({ id: 'none' }),
        mk({ id: 'early', dueDay: '2026-01-01' }),
        mk({ id: 'late', dueDay: '2026-06-01' }),
      ];
      items.sort(cmp);
      expect(items.map((t) => t.id)).toEqual(['early', 'late', 'none']);
    });

    it('mixes dueDay and dueWithTime correctly when they fall on the same day', () => {
      const cmp = buildComparator('dueDate');
      const sameDay = new Date('2026-01-15T14:00:00Z').getTime();
      const items = [
        mk({ id: 'ts', dueWithTime: sameDay }),
        mk({ id: 'day', dueDay: '2026-01-14' }),
      ];
      items.sort(cmp);
      // day 2026-01-14 < timestamp on 2026-01-15 regardless of TZ conversion
      expect(items[0].id).toBe('day');
      expect(items[1].id).toBe('ts');
    });
  });
});

describe('rewriteTagIdsForPanel', () => {
  type PanelFilter = Pick<
    BoardPanelCfg,
    'includedTagIds' | 'includedTagsMatch' | 'excludedTagIds' | 'excludedTagsMatch'
  >;

  const mkPanel = (overrides: Partial<PanelFilter> = {}): PanelFilter => ({
    includedTagIds: [],
    excludedTagIds: [],
    ...overrides,
  });

  it('returns the same tags when no include/exclude filters are set', () => {
    // Arrange
    const tags = ['a', 'b'];
    const panel = mkPanel();

    // Act
    const out = rewriteTagIdsForPanel(tags, panel);

    // Assert
    expect(out).toEqual(['a', 'b']);
  });

  it('"any" include mode: appends the first required tag when task has none', () => {
    // Arrange
    const tags = ['other'];
    const panel = mkPanel({
      includedTagIds: ['need1', 'need2'],
      includedTagsMatch: 'any',
    });

    // Act
    const out = rewriteTagIdsForPanel(tags, panel);

    // Assert — follow actual implementation: concat appends at the end
    expect(out).toEqual(['other', 'need1']);
  });

  it('"any" include mode: leaves tags unchanged when task already has one included', () => {
    // Arrange
    const tags = ['need2', 'keep'];
    const panel = mkPanel({
      includedTagIds: ['need1', 'need2'],
      includedTagsMatch: 'any',
    });

    // Act
    const out = rewriteTagIdsForPanel(tags, panel);

    // Assert
    expect(out).toEqual(['need2', 'keep']);
  });

  it('default ("any") exclude mode: strips ALL excluded tags present', () => {
    // Arrange
    const tags = ['x', 'keep', 'y'];
    const panel = mkPanel({ excludedTagIds: ['x', 'y'] });

    // Act
    const out = rewriteTagIdsForPanel(tags, panel);

    // Assert
    expect(out).toEqual(['keep']);
  });

  it('"all" exclude mode: strips only the FIRST excluded tag when task has every excluded', () => {
    // Arrange
    const tags = ['x', 'y', 'keep'];
    const panel = mkPanel({
      excludedTagIds: ['x', 'y'],
      excludedTagsMatch: 'all',
    });

    // Act
    const out = rewriteTagIdsForPanel(tags, panel);

    // Assert — only first excluded ('x') is dropped; 'y' stays
    expect(out).toEqual(['y', 'keep']);
  });

  it('"all" exclude mode: leaves tags unchanged when task is missing one excluded', () => {
    // Arrange — task only has 'x' so AND-exclude condition isn't met
    const tags = ['x', 'keep'];
    const panel = mkPanel({
      excludedTagIds: ['x', 'y'],
      excludedTagsMatch: 'all',
    });

    // Act
    const out = rewriteTagIdsForPanel(tags, panel);

    // Assert
    expect(out).toEqual(['x', 'keep']);
  });

  it('combines include-add and exclude-strip in a single call', () => {
    // Arrange — task has one excluded tag AND is missing the required include
    const tags = ['drop', 'keep'];
    const panel = mkPanel({
      includedTagIds: ['need'],
      includedTagsMatch: 'any',
      excludedTagIds: ['drop'],
    });

    // Act
    const out = rewriteTagIdsForPanel(tags, panel);

    // Assert — 'drop' stripped (default 'any' exclude), 'need' appended
    expect(out).toEqual(['keep', 'need']);
  });

  it('does not mutate the input tag array', () => {
    // Arrange
    const tags: readonly string[] = Object.freeze(['x', 'y']);
    const panel = mkPanel({ excludedTagIds: ['x'] });

    // Act + Assert — would throw if mutated
    expect(() => rewriteTagIdsForPanel(tags, panel)).not.toThrow();
    expect(tags).toEqual(['x', 'y']);
  });
});

describe('doesTaskMatchPanel', () => {
  const mkPanel = (overrides: Partial<BoardPanelCfg> = {}): BoardPanelCfg =>
    ({ ...basePanel, ...overrides }) as BoardPanelCfg;

  const mkTask = (partial: Partial<TaskCopy> = {}): TaskCopy =>
    ({ id: 't', title: '', tagIds: [], projectId: 'INBOX', ...partial }) as TaskCopy;

  // Most criteria don't involve backlog; default the (required) predicate to
  // "nothing is in backlog" so those cases stay terse.
  const noBacklog = (): boolean => false;
  const match = (
    task: TaskCopy,
    panel: BoardPanelCfg,
    isInBacklog: (t: Readonly<TaskCopy>) => boolean = noBacklog,
  ): boolean => doesTaskMatchPanel(task, panel, isInBacklog);

  it('matches any task when no criteria are set', () => {
    expect(match(mkTask(), mkPanel())).toBe(true);
  });

  describe('included tags', () => {
    it('default ("all"): requires every included tag', () => {
      const panel = mkPanel({ includedTagIds: ['a', 'b'] });
      expect(match(mkTask({ tagIds: ['a', 'b', 'c'] }), panel)).toBe(true);
      expect(match(mkTask({ tagIds: ['a'] }), panel)).toBe(false);
    });

    it('"any": requires at least one included tag', () => {
      const panel = mkPanel({ includedTagIds: ['a', 'b'], includedTagsMatch: 'any' });
      expect(match(mkTask({ tagIds: ['b'] }), panel)).toBe(true);
      expect(match(mkTask({ tagIds: ['x'] }), panel)).toBe(false);
    });
  });

  describe('excluded tags', () => {
    it('default ("any"): excludes when any excluded tag is present', () => {
      const panel = mkPanel({ excludedTagIds: ['a', 'b'] });
      expect(match(mkTask({ tagIds: ['a'] }), panel)).toBe(false);
      expect(match(mkTask({ tagIds: ['x'] }), panel)).toBe(true);
    });

    it('"all": excludes only when every excluded tag is present', () => {
      const panel = mkPanel({ excludedTagIds: ['a', 'b'], excludedTagsMatch: 'all' });
      expect(match(mkTask({ tagIds: ['a', 'b'] }), panel)).toBe(false);
      expect(match(mkTask({ tagIds: ['a'] }), panel)).toBe(true);
    });
  });

  it('isParentTasksOnly: excludes sub-tasks', () => {
    const panel = mkPanel({ isParentTasksOnly: true });
    expect(match(mkTask({ parentId: undefined }), panel)).toBe(true);
    expect(match(mkTask({ parentId: 'parent' }), panel)).toBe(false);
  });

  describe('taskDoneState', () => {
    it('Done: requires isDone', () => {
      const panel = mkPanel({ taskDoneState: BoardPanelCfgTaskDoneState.Done });
      expect(match(mkTask({ isDone: true }), panel)).toBe(true);
      expect(match(mkTask({ isDone: false }), panel)).toBe(false);
    });

    it('UnDone: requires not isDone', () => {
      const panel = mkPanel({ taskDoneState: BoardPanelCfgTaskDoneState.UnDone });
      expect(match(mkTask({ isDone: false }), panel)).toBe(true);
      expect(match(mkTask({ isDone: true }), panel)).toBe(false);
    });
  });

  describe('projectIds', () => {
    it('All Projects ([""]): matches any project', () => {
      const panel = mkPanel({ projectIds: [''] });
      expect(match(mkTask({ projectId: 'p1' }), panel)).toBe(true);
    });

    it('specific: matches only the listed projects', () => {
      const panel = mkPanel({ projectIds: ['p1'] });
      expect(match(mkTask({ projectId: 'p1' }), panel)).toBe(true);
      expect(match(mkTask({ projectId: 'p2' }), panel)).toBe(false);
    });
  });

  describe('scheduledState', () => {
    it('Scheduled: requires a due date', () => {
      const panel = mkPanel({ scheduledState: BoardPanelCfgScheduledState.Scheduled });
      expect(match(mkTask({ dueDay: '2026-01-01' }), panel)).toBe(true);
      expect(match(mkTask(), panel)).toBe(false);
    });

    it('NotScheduled: requires no due date', () => {
      const panel = mkPanel({ scheduledState: BoardPanelCfgScheduledState.NotScheduled });
      expect(match(mkTask(), panel)).toBe(true);
      expect(match(mkTask({ dueWithTime: 123 }), panel)).toBe(false);
    });
  });

  describe('backlogState', () => {
    const isInBacklog = (t: Readonly<TaskCopy>): boolean => t.id === 'backlogged';

    it('OnlyBacklog: keeps only backlog tasks', () => {
      const panel = mkPanel({ backlogState: BoardPanelCfgTaskTypeFilter.OnlyBacklog });
      expect(match(mkTask({ id: 'backlogged' }), panel, isInBacklog)).toBe(true);
      expect(match(mkTask({ id: 'regular' }), panel, isInBacklog)).toBe(false);
    });

    it('NoBacklog: drops backlog tasks', () => {
      const panel = mkPanel({ backlogState: BoardPanelCfgTaskTypeFilter.NoBacklog });
      expect(match(mkTask({ id: 'regular' }), panel, isInBacklog)).toBe(true);
      expect(match(mkTask({ id: 'backlogged' }), panel, isInBacklog)).toBe(false);
    });
  });

  it('combines multiple criteria (AND across dimensions)', () => {
    const panel = mkPanel({
      includedTagIds: ['a'],
      excludedTagIds: ['x'],
      taskDoneState: BoardPanelCfgTaskDoneState.UnDone,
      projectIds: ['p1'],
    });
    expect(match(mkTask({ tagIds: ['a'], isDone: false, projectId: 'p1' }), panel)).toBe(
      true,
    );
    // fails the exclude dimension only
    expect(
      match(mkTask({ tagIds: ['a', 'x'], isDone: false, projectId: 'p1' }), panel),
    ).toBe(false);
  });

  it('ANDs every dimension, including scheduled + backlog', () => {
    const inBacklog = (t: Readonly<TaskCopy>): boolean => t.id === 'b';
    const panel = mkPanel({
      includedTagIds: ['a'],
      excludedTagIds: ['x'],
      taskDoneState: BoardPanelCfgTaskDoneState.UnDone,
      projectIds: ['p1'],
      scheduledState: BoardPanelCfgScheduledState.Scheduled,
      backlogState: BoardPanelCfgTaskTypeFilter.OnlyBacklog,
    });
    const matching = mkTask({
      id: 'b',
      tagIds: ['a'],
      isDone: false,
      projectId: 'p1',
      dueDay: '2026-01-01',
    });
    expect(doesTaskMatchPanel(matching, panel, inBacklog)).toBe(true);
    // identical except it fails ONLY the backlog dimension
    expect(doesTaskMatchPanel({ ...matching, id: 'not-b' }, panel, inBacklog)).toBe(
      false,
    );
  });
});

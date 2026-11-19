import { describe, expect, it } from 'vitest';
import {
  compareStates,
  countByClass,
  describe as describeDifference,
  DifferenceTracker,
  sameValue,
  type CompareContext,
} from '../src/state-check-compare';
import type { EntityMap } from '../src/materializer';

const ctx = (over: Partial<CompareContext> = {}): CompareContext => ({
  filteredEntityIds: new Set(),
  sawArchiveOp: false,
  ...over,
});

const task = (
  id: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id,
  title: `t-${id}`,
  isDone: false,
  tagIds: [],
  subTaskIds: [],
  ...over,
});

const archive = (ids: string[]): Record<string, unknown> => ({
  task: {
    ids,
    entities: Object.fromEntries(ids.map((id) => [id, task(id, { isDone: true })])),
  },
  timeTracking: { project: {}, tag: {} },
  lastTimeTrackingFlush: 0,
});

describe('sameValue', () => {
  it('ignores key order and treats an undefined property as absent', () => {
    expect(sameValue({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 })).toBe(true);
    expect(sameValue({ a: 1, b: undefined }, { a: 1 })).toBe(true);
  });

  it('still tells arrays apart by order and null apart from absent', () => {
    expect(sameValue([1, 2], [2, 1])).toBe(false);
    expect(sameValue({ a: null }, {})).toBe(false);
  });
});

describe('compareStates', () => {
  it('finds nothing when both agree, whatever the clock stamped into modified', () => {
    const bridge: EntityMap = { TASK: { a: task('a', { modified: 1 }) } };
    const appRules: EntityMap = { TASK: { a: task('a', { modified: 2 }) } };
    expect(compareStates(bridge, appRules, ctx())).toEqual([]);
  });

  it('files a done task the bridge still shows In Progress under the known gap', () => {
    const bridge: EntityMap = {
      TASK: { a: task('a', { isDone: true, tagIds: ['KANBAN_IN_PROGRESS', 'x'] }) },
    };
    const appRules: EntityMap = {
      TASK: { a: task('a', { isDone: true, tagIds: ['x'] }) },
    };
    const [d] = compareStates(bridge, appRules, ctx());
    expect(d).toMatchObject({
      section: 'TASK',
      id: 'a',
      field: 'tagIds',
      cls: 'in-progress-on-done',
    });
  });

  it('reports any other tag difference as new, so the known label never hides a fresh bug', () => {
    const bridge: EntityMap = { TASK: { a: task('a', { isDone: true, tagIds: ['x'] }) } };
    const appRules: EntityMap = {
      TASK: { a: task('a', { isDone: true, tagIds: ['y'] }) },
    };
    expect(compareStates(bridge, appRules, ctx())[0].cls).toBe('new');
  });

  it('attributes a task live in the bridge but archived by the app rules, and the lists that lost it, to the archive', () => {
    const bridge: EntityMap = {
      TASK: { a: task('a', { isDone: true }), b: task('b') },
      PROJECT: { p: { id: 'p', taskIds: ['a', 'b'] } },
    };
    const appRules: EntityMap = {
      TASK: { b: task('b') },
      PROJECT: { p: { id: 'p', taskIds: ['b'] } },
      ARCHIVE_YOUNG: archive(['a']),
    };
    const found = compareStates(bridge, appRules, ctx());
    const taskDiff = found.find((d) => d.section === 'TASK');
    const listDiff = found.find((d) => d.section === 'PROJECT');
    expect(taskDiff).toMatchObject({ id: 'a', kind: 'only-in-bridge', cls: 'archive' });
    expect(listDiff).toMatchObject({ id: 'p', field: 'taskIds', cls: 'archive' });
  });

  it('calls a project list difference new when the missing task is still live in the app rules', () => {
    const bridge: EntityMap = {
      TASK: { b: task('b') },
      PROJECT: { p: { id: 'p', taskIds: [] } },
    };
    const appRules: EntityMap = {
      TASK: { b: task('b') },
      PROJECT: { p: { id: 'p', taskIds: ['b'] } },
    };
    expect(compareStates(bridge, appRules, ctx())[0]).toMatchObject({
      field: 'taskIds',
      cls: 'new',
    });
  });

  it('labels tag task lists, settings and menu tree by their known gaps', () => {
    const bridge: EntityMap = {
      TASK: { a: task('a') },
      TAG: { t: { id: 't', taskIds: [] } },
      GLOBAL_CONFIG: { misc: { a: 1 } },
      MENU_TREE: { projectTree: [] },
    };
    const appRules: EntityMap = {
      TASK: { a: task('a') },
      TAG: { t: { id: 't', taskIds: ['a'] } },
      GLOBAL_CONFIG: { misc: { a: 2 } },
      MENU_TREE: { projectTree: ['p'] },
    };
    const classes = compareStates(bridge, appRules, ctx()).map((d) => d.cls);
    expect(classes.sort()).toEqual(['menu-tree', 'settings', 'tag-task-lists']);
  });

  it('attributes entities touched by ops a browser would drop after a full import', () => {
    const bridge: EntityMap = {
      TASK: { a: task('a', { title: 'stale' }), z: task('z') },
    };
    const appRules: EntityMap = { TASK: { a: task('a') } };
    const found = compareStates(
      bridge,
      appRules,
      ctx({ filteredEntityIds: new Set(['a', 'z']) }),
    );
    expect(found.map((d) => d.cls)).toEqual(['import-filter', 'import-filter']);
  });

  it('attributes a settings section changed by a dropped settings op, whose entity id is the section key', () => {
    const bridge: EntityMap = { GLOBAL_CONFIG: { sync: { a: 1 }, misc: { b: 1 } } };
    const appRules: EntityMap = { GLOBAL_CONFIG: { sync: { a: 2 }, misc: { b: 2 } } };
    const found = compareStates(
      bridge,
      appRules,
      ctx({ filteredEntityIds: new Set(['sync']) }),
    );
    expect(found.map((d) => [d.field, d.cls])).toEqual([
      ['misc', 'settings'],
      ['sync', 'import-filter'],
    ]);
  });

  it('only blames time tracking on the archive once the app rules have seen an archive action', () => {
    const bridge: EntityMap = { TIME_TRACKING: { project: { p: 1 } } };
    const appRules: EntityMap = { TIME_TRACKING: { project: {} } };
    expect(compareStates(bridge, appRules, ctx())[0].cls).toBe('new');
    expect(compareStates(bridge, appRules, ctx({ sawArchiveOp: true }))[0].cls).toBe(
      'archive',
    );
  });

  it('never puts a value in the description, only section, id and field', () => {
    const bridge: EntityMap = { TASK: { a: task('a', { title: 'secret title' }) } };
    const appRules: EntityMap = { TASK: { a: task('a', { title: 'other secret' }) } };
    const [d] = compareStates(bridge, appRules, ctx());
    const line = describeDifference(d);
    expect(line).toBe('new: TASK a.title (differs)');
    expect(line).not.toContain('secret');
  });
});

describe('DifferenceTracker', () => {
  it('reports only what appeared or resolved since the last comparison', () => {
    const tracker = new DifferenceTracker();
    const bridge: EntityMap = {
      TASK: { a: task('a', { title: 'x' }), b: task('b', { title: 'x' }) },
    };
    const appRules: EntityMap = { TASK: { a: task('a'), b: task('b') } };

    const first = tracker.update(compareStates(bridge, appRules, ctx()));
    expect(first.appeared).toHaveLength(2);

    const again = tracker.update(compareStates(bridge, appRules, ctx()));
    expect(again).toEqual({ appeared: [], resolved: [] });

    const fixedB: EntityMap = { TASK: { a: task('a', { title: 'x' }), b: task('b') } };
    const later = tracker.update(compareStates(fixedB, appRules, ctx()));
    expect(later.resolved.map((d) => d.id)).toEqual(['b']);
    expect(countByClass(tracker.current)).toEqual({ new: 1 });
  });
});

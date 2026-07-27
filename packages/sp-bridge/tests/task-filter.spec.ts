/**
 * Filters for GET /api/tasks.
 *
 * The reason this file exists: a wrong filter does not throw, it answers 200 with the wrong tasks.
 * Nothing downstream can tell the difference, so the only place to catch it is here.
 */
import { describe, expect, it } from 'vitest';
import { BridgeCore, type TaskFilter } from '../src/core';
import type { OpFactory } from '../src/op-factory';
import type { StateStore } from '../src/state-store';

const TODAY = '2026-07-27';

type Task = Record<string, unknown>;

const TASKS: Record<string, Task> = {
  t1: {
    id: 't1',
    title: 'Write the report',
    notes: 'draft in Notion',
    isDone: false,
    projectId: 'p1',
    tagIds: ['work'],
    dueDay: '2026-07-20',
  },
  t2: {
    id: 't2',
    title: 'Buy milk',
    isDone: true,
    projectId: 'p2',
    tagIds: ['errands'],
    dueDay: '2026-07-20',
  },
  t3: {
    id: 't3',
    title: 'Review PR',
    notes: 'REPORT back after',
    isDone: false,
    projectId: 'p1',
    tagIds: ['work', 'urgent'],
    dueDay: TODAY,
  },
  t4: {
    id: 't4',
    title: 'Subtask of the report',
    isDone: false,
    projectId: 'p1',
    parentId: 't1',
    tagIds: [],
  },
  t5: {
    id: 't5',
    title: 'Water the plants',
    isDone: false,
    projectId: 'p2',
    repeatCfgId: 'r1',
    tagIds: [],
  },
  t6: {
    id: 't6',
    title: 'Someday idea',
    isDone: false,
    projectId: 'p2',
    tagIds: [],
  },
  t7: {
    id: 't7',
    title: 'Scheduled with a time',
    isDone: false,
    projectId: 'p2',
    tagIds: [],
    dueWithTime: 1790000000000,
  },
};

/** Any future day works; it only has to be a day the planner holds and the filters do not otherwise touch. */
const PLANNER_DAY = '2026-08-01';

const STATE: Record<string, unknown> = {
  TASK: TASKS,
  // TODAY is a virtual tag: membership lives in its taskIds, not on the task.
  TAG: { TODAY: { id: 'TODAY', taskIds: ['t5'] } },
  PLANNER: { days: { [PLANNER_DAY]: ['t6'] } },
};

const core = (state: Record<string, unknown> = STATE): BridgeCore =>
  new BridgeCore({ state } as unknown as StateStore, {} as unknown as OpFactory);

/** Ids only; order is an implementation detail of Object.values and not worth asserting. */
const ids = (filter: TaskFilter, state?: Record<string, unknown>): string[] =>
  core(state)
    .listTasks(filter)
    .map((t) => t.id as string)
    .sort();

describe('no filter', () => {
  it('returns every task', () => {
    expect(ids({})).toEqual(['t1', 't2', 't3', 't4', 't5', 't6', 't7']);
  });

  it('returns an empty list when there are no tasks at all', () => {
    expect(ids({}, {})).toEqual([]);
  });
});

describe('isDone', () => {
  it('separates done from open', () => {
    expect(ids({ isDone: true })).toEqual(['t2']);
    expect(ids({ isDone: false })).toEqual(['t1', 't3', 't4', 't5', 't6', 't7']);
  });

  it('treats a missing isDone as not done', () => {
    // Tasks written by older clients may omit the flag entirely.
    const state = { TASK: { a: { id: 'a', title: 'no flag' } } };
    expect(ids({ isDone: false }, state)).toEqual(['a']);
    expect(ids({ isDone: true }, state)).toEqual([]);
  });
});

describe('projectId', () => {
  it('matches exactly', () => {
    expect(ids({ projectId: 'p1' })).toEqual(['t1', 't3', 't4']);
    expect(ids({ projectId: 'nope' })).toEqual([]);
  });
});

describe('tagId', () => {
  it('matches membership in tagIds', () => {
    expect(ids({ tagId: 'work' })).toEqual(['t1', 't3']);
    expect(ids({ tagId: 'urgent' })).toEqual(['t3']);
  });

  it('excludes tasks with no tags rather than throwing', () => {
    const state = { TASK: { a: { id: 'a', title: 'untagged' } } };
    expect(ids({ tagId: 'work' }, state)).toEqual([]);
  });
});

describe('dueDay', () => {
  it('matches the exact day', () => {
    expect(ids({ dueDay: '2026-07-20' })).toEqual(['t1', 't2']);
    expect(ids({ dueDay: TODAY })).toEqual(['t3']);
  });
});

describe('parentId', () => {
  it('finds the children of one parent', () => {
    expect(ids({ parentId: 't1' })).toEqual(['t4']);
  });

  it('treats null as top-level only', () => {
    // The API spells this "null" in the query string, which is the only way to ask for top-level tasks.
    expect(ids({ parentId: null })).toEqual(['t1', 't2', 't3', 't5', 't6', 't7']);
  });
});

describe('search', () => {
  it('matches the title, case-insensitively', () => {
    expect(ids({ search: 'report' })).toEqual(['t1', 't3', 't4']);
    expect(ids({ search: 'REPORT' })).toEqual(['t1', 't3', 't4']);
  });

  it('matches notes as well as titles', () => {
    // t3 only matches through its notes, which is the part easiest to drop in a refactor.
    expect(ids({ search: 'notion' })).toEqual(['t1']);
  });

  it('survives tasks with no notes', () => {
    expect(ids({ search: 'milk' })).toEqual(['t2']);
  });

  it('ignores an empty search rather than matching nothing', () => {
    expect(ids({ search: '' })).toHaveLength(7);
  });
});

describe('parentsOnly', () => {
  it('drops subtasks', () => {
    expect(ids({ parentsOnly: true })).toEqual(['t1', 't2', 't3', 't5', 't6', 't7']);
  });
});

describe('recurringOnly', () => {
  it('keeps only tasks with a repeat config', () => {
    expect(ids({ recurringOnly: true })).toEqual(['t5']);
  });
});

describe('overdue', () => {
  it('is strictly before the anchor day', () => {
    // t3 is due exactly today and must not count as overdue.
    expect(ids({ overdue: true, today: TODAY })).toEqual(['t1']);
  });

  it('excludes done tasks even when their due day has passed', () => {
    // t2 is due 2026-07-20 and done; surfacing it would make the overdue list useless.
    expect(ids({ overdue: true, today: TODAY })).not.toContain('t2');
  });

  it('excludes tasks with no due day', () => {
    expect(ids({ overdue: true, today: TODAY })).not.toContain('t6');
  });

  it('moves with the anchor', () => {
    expect(ids({ overdue: true, today: '2026-07-21' })).toEqual(['t1']);
    expect(ids({ overdue: true, today: '2026-07-19' })).toEqual([]);
  });
});

describe('plannedForToday', () => {
  it('includes TODAY tag members and anything due today', () => {
    // t5 via the tag, t3 via its due day. The two paths are independent.
    expect(ids({ plannedForToday: true, today: TODAY })).toEqual(['t3', 't5']);
  });

  it('works when the TODAY tag does not exist yet', () => {
    const state = { TASK: { a: { id: 'a', dueDay: TODAY } } };
    expect(ids({ plannedForToday: true, today: TODAY }, state)).toEqual(['a']);
  });
});

describe('unscheduled', () => {
  it('excludes anything dated, timed, in TODAY, or on the planner', () => {
    // t4 (subtask, no date) is the only survivor: t6 is on the planner, t5 is in TODAY, t7 has dueWithTime.
    expect(ids({ unscheduled: true })).toEqual(['t4']);
  });

  it('works when there is no planner at all', () => {
    const state = { TASK: { a: { id: 'a', title: 'loose' } } };
    expect(ids({ unscheduled: true }, state)).toEqual(['a']);
  });
});

describe('fields projection', () => {
  it('returns only the requested fields plus id', () => {
    const [task] = core().listTasks({
      projectId: 'p1',
      parentId: 't1',
      fields: ['title'],
    });
    expect(task).toEqual({ id: 't4', title: 'Subtask of the report' });
  });

  it('always keeps id even when not requested', () => {
    const [task] = core().listTasks({ dueDay: TODAY, fields: ['isDone'] });
    expect(task).toHaveProperty('id', 't3');
  });

  it('omits requested fields the task does not have', () => {
    // Absent rather than undefined, so JSON output stays clean.
    const [task] = core().listTasks({ dueDay: TODAY, fields: ['notes', 'nonexistent'] });
    expect(Object.keys(task).sort()).toEqual(['id', 'notes']);
  });

  it('is ignored when the field list is empty', () => {
    const [task] = core().listTasks({ dueDay: TODAY, fields: [] });
    expect(Object.keys(task).length).toBeGreaterThan(2);
  });
});

describe('composition', () => {
  it('applies every filter as an AND', () => {
    expect(ids({ projectId: 'p1', isDone: false, tagId: 'work', search: 'pr' })).toEqual([
      't3',
    ]);
  });

  it('returns nothing when the filters cannot all hold', () => {
    expect(ids({ projectId: 'p1', tagId: 'errands' })).toEqual([]);
  });
});

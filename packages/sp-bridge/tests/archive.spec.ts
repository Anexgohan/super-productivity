import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ARCHIVE_LIMIT,
  dayOf,
  getArchiveTask,
  listArchiveTasks,
} from '../src/archive';

/** Epoch ms for local midday on a given day, so a day-string round-trip cannot land on the wrong side of a timezone boundary. */
const at = (day: string): number => new Date(`${day}T12:00:00`).getTime();

const task = (
  id: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id,
  title: `task ${id}`,
  isDone: true,
  projectId: 'p1',
  tagIds: [],
  notes: '',
  ...over,
});

const state = (
  young: Record<string, unknown>[],
  old: Record<string, unknown>[] = [],
): Record<string, unknown> => ({
  ARCHIVE_YOUNG: {
    task: {
      ids: young.map((t) => t.id),
      entities: Object.fromEntries(young.map((t) => [t.id as string, t])),
    },
  },
  ARCHIVE_OLD: {
    task: {
      ids: old.map((t) => t.id),
      entities: Object.fromEntries(old.map((t) => [t.id as string, t])),
    },
  },
});

describe('listArchiveTasks', () => {
  it('merges both buckets, since young versus old is a storage detail', () => {
    const s = state(
      [task('a', { doneOn: at('2026-07-20') })],
      [task('b', { doneOn: at('2025-01-05') })],
    );
    expect(listArchiveTasks(s).map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('prefers the young copy of an id held in both, which is the one compaction has not rewritten', () => {
    const s = state(
      [task('a', { doneOn: at('2026-07-20'), timeSpent: 100 })],
      [task('a', { doneOn: at('2026-07-20'), timeSpent: 999 })],
    );
    const out = listArchiveTasks(s);
    expect(out).toHaveLength(1);
    expect(out[0].timeSpent).toBe(100);
  });

  it('sorts newest completion first', () => {
    const s = state([
      task('old', { doneOn: at('2026-01-01') }),
      task('new', { doneOn: at('2026-07-20') }),
      task('mid', { doneOn: at('2026-04-10') }),
    ]);
    expect(listArchiveTasks(s).map((t) => t.id)).toEqual(['new', 'mid', 'old']);
  });

  it('filters on the completion day, inclusive at both ends', () => {
    const s = state([
      task('before', { doneOn: at('2026-07-01') }),
      task('start', { doneOn: at('2026-07-06') }),
      task('inside', { doneOn: at('2026-07-08') }),
      task('end', { doneOn: at('2026-07-12') }),
      task('after', { doneOn: at('2026-07-20') }),
    ]);
    const got = listArchiveTasks(s, { from: '2026-07-06', to: '2026-07-12' });
    expect(got.map((t) => t.id).sort()).toEqual(['end', 'inside', 'start']);
  });

  it('drops undated tasks from a date window but keeps them otherwise, sorted last', () => {
    const s = state([task('dated', { doneOn: at('2026-07-08') }), task('undated')]);
    expect(listArchiveTasks(s, { from: '2026-07-01' }).map((t) => t.id)).toEqual([
      'dated',
    ]);
    expect(listArchiveTasks(s).map((t) => t.id)).toEqual(['dated', 'undated']);
  });

  it('filters by project, tag and search', () => {
    const s = state([
      task('a', { doneOn: at('2026-07-08'), projectId: 'p1', tagIds: ['t1'] }),
      task('b', { doneOn: at('2026-07-07'), projectId: 'p2', tagIds: ['t2'] }),
      task('c', { doneOn: at('2026-07-06'), projectId: 'p1', notes: 'find me' }),
    ]);
    expect(listArchiveTasks(s, { projectId: 'p2' }).map((t) => t.id)).toEqual(['b']);
    expect(listArchiveTasks(s, { tagId: 't1' }).map((t) => t.id)).toEqual(['a']);
    // Search covers notes as well as titles, matching /api/tasks.
    expect(listArchiveTasks(s, { search: 'FIND' }).map((t) => t.id)).toEqual(['c']);
  });

  it('caps results, because the archive grows without bound', () => {
    const many = Array.from({ length: DEFAULT_ARCHIVE_LIMIT + 25 }, (_, i) =>
      task(`t${i}`, { doneOn: at('2026-07-08') }),
    );
    expect(listArchiveTasks(state(many))).toHaveLength(DEFAULT_ARCHIVE_LIMIT);
    expect(listArchiveTasks(state(many), { limit: 3 })).toHaveLength(3);
  });

  it('projects fields and always keeps id', () => {
    const s = state([task('a', { doneOn: at('2026-07-08'), timeSpent: 42 })]);
    expect(listArchiveTasks(s, { fields: ['title'] })).toEqual([
      { id: 'a', title: 'task a' },
    ]);
  });

  it('is empty rather than throwing on a board that has never archived anything', () => {
    expect(listArchiveTasks({})).toEqual([]);
    expect(listArchiveTasks({ ARCHIVE_YOUNG: {} })).toEqual([]);
  });
});

describe('getArchiveTask', () => {
  it('finds a task in either bucket', () => {
    const s = state([task('y')], [task('o')]);
    expect(getArchiveTask(s, 'y')?.id).toBe('y');
    expect(getArchiveTask(s, 'o')?.id).toBe('o');
    expect(getArchiveTask(s, 'nope')).toBeUndefined();
  });
});

describe('dayOf', () => {
  it('reads a timestamp as its local calendar day', () => {
    expect(dayOf(at('2026-07-08'))).toBe('2026-07-08');
  });

  it('returns null for anything that is not a usable timestamp', () => {
    expect(dayOf(undefined)).toBeNull();
    expect(dayOf('2026-07-08')).toBeNull();
    expect(dayOf(NaN)).toBeNull();
  });
});

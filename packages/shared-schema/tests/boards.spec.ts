import { describe, expect, it } from 'vitest';
import {
  isAllProjects,
  reassignPanelProjectScopes,
  restrictPanelCardOrder,
  sanitizeBoardProjectIds,
} from '../src/boards';

describe('restrictPanelCardOrder', () => {
  const projectOf = (id: string): string | undefined =>
    ({ a: 'game-dev', b: 'pankha' })[id];
  const panels = [
    { id: 'p1', taskIds: ['a', 'b', 'gone'] },
    { id: 'p2', taskIds: ['a'] },
  ];

  it('keeps only tasks of the target project', () => {
    const out = restrictPanelCardOrder(panels, ['game-dev'], projectOf);
    expect(out[0].taskIds).toEqual(['a']);
  });

  it('returns an untouched panel as the same object', () => {
    const out = restrictPanelCardOrder(panels, ['game-dev'], projectOf);
    expect(out[1]).toBe(panels[1]);
  });

  it('keeps everything for an unassigned target', () => {
    expect(restrictPanelCardOrder(panels, [''], projectOf)).toBe(panels);
    expect(restrictPanelCardOrder(panels, undefined, projectOf)).toBe(panels);
  });

  it('does not mutate the input', () => {
    const before = JSON.stringify(panels);
    restrictPanelCardOrder(panels, ['pankha'], projectOf);
    expect(JSON.stringify(panels)).toBe(before);
  });
});

describe('isAllProjects', () => {
  it('treats every unassigned form as All Projects', () => {
    for (const v of [undefined, [], [''], ['', 'p1'], 'p1' as unknown as string[]]) {
      expect(isAllProjects(v)).toBe(true);
    }
  });

  it('treats real ids as a specific scope', () => {
    expect(isAllProjects(['p1'])).toBe(false);
    expect(isAllProjects(['p1', 'p2'])).toBe(false);
  });
});

describe('sanitizeBoardProjectIds', () => {
  it('collapses every All Projects form to the sentinel', () => {
    expect(sanitizeBoardProjectIds([])).toEqual(['']);
    expect(sanitizeBoardProjectIds(['', 'p1'])).toEqual(['']);
    expect(sanitizeBoardProjectIds(undefined)).toEqual(['']);
  });

  it('keeps specific ids as they are', () => {
    const ids = ['p1', 'p2'];
    expect(sanitizeBoardProjectIds(ids)).toBe(ids);
  });
});

// Guards the copied Pankha board whose columns stayed limited to Pankha inside game-dev and so never showed a task.
describe('reassignPanelProjectScopes', () => {
  const PANKHA = 'pankha';
  const GAME_DEV = 'game-dev';
  const panels = [
    { id: 'todo', projectIds: [PANKHA] },
    { id: 'multi', projectIds: [PANKHA, 'other'] },
    { id: 'bucket', projectIds: [''] },
  ];

  it('drops the source project from every column when moved to another project', () => {
    const out = reassignPanelProjectScopes(panels, [PANKHA], [GAME_DEV]);
    expect(out.map((p) => p.projectIds)).toEqual([[''], [''], ['']]);
  });

  it('repairs a board already assigned to the target', () => {
    const out = reassignPanelProjectScopes(panels, [GAME_DEV], [GAME_DEV]);
    expect(out.map((p) => p.projectIds)).toEqual([[''], [''], ['']]);
  });

  it('drops the old project when an assigned board is unassigned', () => {
    const out = reassignPanelProjectScopes(panels, [PANKHA], ['']);
    expect(out.map((p) => p.projectIds)).toEqual([[''], [''], ['']]);
  });

  it('keeps a deliberate per-column split on a board that stays unassigned', () => {
    expect(reassignPanelProjectScopes(panels, [''], [''])).toBe(panels);
    expect(reassignPanelProjectScopes(panels, undefined, [])).toBe(panels);
  });

  it('keeps every other column field and leaves the input untouched', () => {
    const src = [
      { id: 'a', title: 'To Do', includedTagIds: ['t'], projectIds: [PANKHA] },
    ];
    const before = JSON.stringify(src);
    const [out] = reassignPanelProjectScopes(src, [PANKHA], [GAME_DEV]);
    expect(out).toEqual({
      id: 'a',
      title: 'To Do',
      includedTagIds: ['t'],
      projectIds: [''],
    });
    expect(JSON.stringify(src)).toBe(before);
  });

  it('returns the same column object when it has nothing to drop', () => {
    const out = reassignPanelProjectScopes(panels, [PANKHA], [GAME_DEV]);
    expect(out[2]).toBe(panels[2]);
  });
});

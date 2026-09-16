import { describe, expect, it } from 'vitest';
import { reassignPanelProjectScopes } from '../src/boards';

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

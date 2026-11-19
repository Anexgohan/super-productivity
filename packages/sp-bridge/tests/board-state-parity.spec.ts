import { describe, expect, it } from 'vitest';
import { DEFAULT_PANEL_CFG } from '@sp/shared-schema';
import { buildBoardEntity, buildPanelEntity } from '../src/op-factory';

// The API builds new boards and columns the way the board editor does; these pin it to the shared defaults.
describe('buildPanelEntity defaults', () => {
  it('matches a column added in the board editor', () => {
    const p = buildPanelEntity({ title: 'New' });
    expect(p.taskDoneState).toBe(DEFAULT_PANEL_CFG.taskDoneState);
    expect(p.scheduledState).toBe(DEFAULT_PANEL_CFG.scheduledState);
    expect(p.backlogState).toBe(DEFAULT_PANEL_CFG.backlogState);
    expect(p.isParentTasksOnly).toBe(DEFAULT_PANEL_CFG.isParentTasksOnly);
    expect(p.projectIds).toEqual(['']);
  });

  it('keeps sort and tag match settings', () => {
    const p = buildPanelEntity({
      title: 'Done',
      sortBy: 'dueDate',
      sortDir: 'desc',
      includedTagsMatch: 'any',
      excludedTagsMatch: 'all',
    });
    expect([p.sortBy, p.sortDir, p.includedTagsMatch, p.excludedTagsMatch]).toEqual([
      'dueDate',
      'desc',
      'any',
      'all',
    ]);
  });

  it('keeps them on columns of a new board too', () => {
    const b = buildBoardEntity({
      title: 'B',
      panels: [{ title: 'A', sortBy: 'created', includedTagsMatch: 'any' }],
    });
    const [p] = b.panels as Record<string, unknown>[];
    expect([p.sortBy, p.includedTagsMatch]).toEqual(['created', 'any']);
  });

  it('drops an unknown sort field and absent optionals', () => {
    const p = buildPanelEntity({ title: 'X', sortBy: 'bogus' as never });
    expect('sortBy' in p).toBe(false);
    expect('sortDir' in p).toBe(false);
    expect('includedTagsMatch' in p).toBe(false);
  });

  it('keeps explicit values', () => {
    const p = buildPanelEntity({ title: 'Kanban', taskDoneState: 3, backlogState: 2 });
    expect(p.taskDoneState).toBe(3);
    expect(p.backlogState).toBe(2);
  });
});

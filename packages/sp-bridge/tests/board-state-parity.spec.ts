import { describe, expect, it } from 'vitest';
import { DEFAULT_PANEL_CFG } from '@sp/shared-schema';
import type { SuperSyncServerOperation } from '@sp/shared-schema';
import { Materializer } from '../src/materializer';
import { buildBoardEntity, buildPanelEntity } from '../src/op-factory';

// The bridge and the browser must store the same board for the same op; these pin the bridge to the shared rules.
let seq = 0;
const row = (
  actionType: string,
  opType: string,
  payload: unknown,
): SuperSyncServerOperation =>
  ({
    serverSeq: ++seq,
    op: {
      id: `op-${seq}`,
      clientId: 'test-client',
      actionType,
      opType,
      entityType: 'BOARD',
      entityId: 'b1',
      vectorClock: { 'test-client': seq },
      timestamp: Date.now(),
      schemaVersion: 4,
      isPayloadEncrypted: false,
      payload,
    },
  }) as unknown as SuperSyncServerOperation;

const boardsOf = (m: Materializer): Record<string, unknown>[] =>
  (m.state.BOARD as { boardCfgs: Record<string, unknown>[] }).boardCfgs;

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

describe('Materializer board ops', () => {
  const panel = {
    id: 'p1',
    title: 'A',
    taskIds: [],
    includedTagIds: [],
    excludedTagIds: [],
    taskDoneState: 1,
    scheduledState: 1,
    isParentTasksOnly: false,
  };

  it('sanitizes an added board as the browser reducer does', async () => {
    const m = new Materializer('unused');
    await m.applyOps([
      row('[Boards] Add Board', 'CRT', {
        actionPayload: {
          board: {
            id: 'b1',
            title: 'B',
            cols: 1,
            projectIds: ['', 'x'],
            panels: [{ ...panel, projectIds: [] }],
          },
        },
        entityChanges: [],
      }),
    ]);
    const [b] = boardsOf(m);
    expect(b.projectIds).toEqual(['']);
    expect((b.panels as Record<string, unknown>[])[0].projectIds).toEqual(['']);
  });

  it('sanitizes project ids on update', async () => {
    const m = new Materializer('unused');
    await m.applyOps([
      row('[Boards] Add Board', 'CRT', {
        actionPayload: { board: { id: 'b1', title: 'B', cols: 1, panels: [] } },
        entityChanges: [],
      }),
      row('[Boards] Update Board', 'UPD', {
        actionPayload: { id: 'b1', updates: { projectIds: [] } },
        entityChanges: [],
      }),
    ]);
    expect(boardsOf(m)[0].projectIds).toEqual(['']);
  });

  it('applies the load repairs to boards from a full-state import', async () => {
    const m = new Materializer('unused');
    await m.applyOps([
      row('[SP_ALL] Load(import) all data', 'SYNC_IMPORT', {
        appDataComplete: {
          boards: {
            boardCfgs: [
              {
                id: 'KANBAN_DEFAULT',
                title: 'K',
                cols: 1,
                panels: [
                  { ...panel, id: 'DONE', excludedTagIds: ['KANBAN_IN_PROGRESS'] },
                ],
              },
              { id: 'broken', title: 'X', cols: 1 },
            ],
          },
        },
      }),
    ]);
    const [kanban, broken] = boardsOf(m);
    expect((kanban.panels as Record<string, unknown>[])[0].excludedTagIds).toEqual([]);
    expect(broken.panels).toEqual([]);
    expect(broken.projectIds).toEqual(['']);
  });
});

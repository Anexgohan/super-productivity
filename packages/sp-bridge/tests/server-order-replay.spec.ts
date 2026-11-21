/**
 * Stage 9 (anex): a browser replays in the server's order and ends up where the bridge does. Runs the app's own reducers
 * from source (the root reducer the bridge assembles, with every meta-reducer), on synthetic data.
 */
import '@angular/compiler';
import '../app-rules/globals';
import { Injector, ɵINJECTOR_SCOPE as INJECTOR_SCOPE } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Action } from '@ngrx/store';
import {
  deleteTimesWithParents,
  findEditsThatBeatDeletes,
  findRecreationsBeatenByDeletes,
  planServerOrderApply,
} from '@sp/sync-core';
import { buildRootReducer } from '../app-rules/root-reducer';
import { buildTaskEntity } from '../src/op-factory';
import { bulkApplyOperations } from '../../../src/app/op-log/apply/bulk-hydration.action';
import {
  opsAppliedBy,
  reapplyEditsReplacedByCheckpoint,
  serverOrderRebuild,
  serverOrderReplay,
  setUnsavedLocalTimeSource,
  takeReplayedConfirmedState,
} from '../../../src/app/op-log/apply/server-order-replay.meta-reducer';
import {
  NO_UNSAVED_LOCAL_TIME,
  SYNCED_FEATURE_KEYS,
  withoutUnsavedTaskTime,
} from '../../../src/app/op-log/apply/server-order-local-state.util';
import {
  bufferDeferredAction,
  clearDeferredActions,
} from '../../../src/app/op-log/capture/operation-capture.meta-reducer';
import {
  reportBulkReplayReducerFailure,
  runWithBulkReplayFailureCollector,
  runWithBulkReplayFailureFilter,
  type BulkReplayReducerFailure,
} from '../../../src/app/op-log/apply/bulk-replay-failure-collector';
import { convertOpToAction } from '../../../src/app/op-log/apply/operation-converter.util';
import { bringBackTaskStates } from '../../../src/app/op-log/sync/server-order-bring-back.util';
import {
  bringBackNoteStates,
  editsShown,
  itemsMissingFromCheckpoint,
  itemsRemovedBy,
  recreatesItem,
} from '../../../src/app/op-log/sync/server-order-delete-rule.util';
import type { Note, NoteState } from '../../../src/app/features/note/note.model';
import {
  historyBeforeBatch,
  opsAsDownloadApplies,
} from '../../../src/app/op-log/sync/server-order-rebuild.util';
import { SchemaMigrationService } from '../../../src/app/op-log/persistence/schema-migration.service';
import { SyncImportFilterService } from '../../../src/app/op-log/sync/sync-import-filter.service';
import { OperationLogStoreService } from '../../../src/app/op-log/persistence/operation-log-store.service';
import { DEFAULT_PROJECT } from '../../../src/app/features/project/project.const';
import { PROJECT_DELETE_WINS_MARKER } from '../../../src/app/root-store/meta/task-shared.actions';
import type { Task, TaskState } from '../../../src/app/features/tasks/task.model';
import type { Operation } from '../../../src/app/op-log/core/operation.types';
import type { PersistentAction } from '../../../src/app/op-log/core/persistent-action.interface';

type State = Record<string, unknown>;
interface Tasks {
  ids: string[];
  entities: Record<string, { title: string; timeSpentOnDay: Record<string, number> }>;
  currentTaskId: string | null;
  selectedTaskId: string | null;
}

const A = 'B_browserA';
const B = 'B_browserB';
const DAY = '2026-11-20';
const root = buildRootReducer() as (state: State | undefined, action: Action) => State;

let opCount = 0;
const makeOp = (
  clientId: string,
  actionType: string,
  opType: string,
  entityId: string,
  actionPayload: Record<string, unknown>,
): Operation =>
  ({
    id: `op-${++opCount}`,
    clientId,
    actionType,
    opType,
    entityType: 'TASK',
    entityId,
    payload: { actionPayload, entityChanges: [] },
    vectorClock: { [clientId]: opCount },
    timestamp: 1_790_000_000_000 + opCount,
    schemaVersion: 4,
  }) as unknown as Operation;

const addTask = (clientId: string, id: string, title: string): Operation =>
  makeOp(clientId, '[Task Shared] addTask', 'CRT', id, {
    task: { ...buildTaskEntity({ title }), id },
    workContextId: 'INBOX_PROJECT',
    workContextType: 'PROJECT',
    isAddToBacklog: false,
    isAddToBottom: false,
  });

const rename = (clientId: string, id: string, title: string): Operation =>
  makeOp(clientId, '[Task Shared] updateTask', 'UPD', id, {
    task: { id, changes: { title } },
  });

const addSubTask = (
  clientId: string,
  id: string,
  title: string,
  parentId: string,
): Operation =>
  makeOp(clientId, '[Task] Add SubTask', 'CRT', id, {
    task: { ...buildTaskEntity({ title, parentId }), id },
    parentId,
  });

// As the app captures it: the op names only the top task, its subtasks are in the payload.
const deleteTask = (clientId: string, task: Task, subTasks: Task[] = []): Operation => ({
  ...makeOp(clientId, '[Task Shared] deleteTask', 'DEL', task.id, {
    task: { ...task, subTasks },
  }),
  entityIds: [task.id],
});

const noteOp = (
  clientId: string,
  actionType: string,
  opType: string,
  id: string,
  actionPayload: Record<string, unknown>,
): Operation =>
  ({
    ...makeOp(clientId, actionType, opType, id, actionPayload),
    entityType: 'NOTE',
  }) as unknown as Operation;

const pinnedNote = (projectId: string): Note => ({
  id: 'n1',
  projectId,
  isPinnedToToday: true,
  content: 'note',
  created: 1,
  modified: 1,
});

/** A whole-entity save as ConflictResolutionService.createLWWUpdateOp builds it, marked as bringing the entity back. */
const lwwSave = (
  clientId: string,
  entityType: 'TASK' | 'PROJECT' | 'NOTE',
  entity: { id: string },
  lwwUpdateMode: 'replace' | 'patch' = 'replace',
): Operation =>
  ({
    ...makeOp(clientId, `[${entityType}] LWW Update`, 'UPD', entity.id, {}),
    entityType,
    payload: {
      actionPayload: entity,
      entityChanges: [],
      lwwUpdateMode,
      recreatesEntityAfterDelete: true,
    },
  }) as unknown as Operation;

const apply = (state: State | undefined, ops: Operation[], localClientId = A): State =>
  root(state, bulkApplyOperations({ operations: ops, localClientId }));

const tasks = (state: State): Tasks => state.tasks as Tasks;
const taskState = (state: State): TaskState => state.tasks as TaskState;
const inboxOrder = (state: State): string[] =>
  (state.projects as { entities: Record<string, { taskIds: string[] }> }).entities
    .INBOX_PROJECT.taskIds;
const synced = (state: State): State =>
  Object.fromEntries(SYNCED_FEATURE_KEYS.map((key) => [key, state[key]]));
const notes = (state: State): NoteState => state.note as NoteState;
const projectNoteIds = (state: State, projectId: string): string[] | undefined =>
  (state.projects as { entities: Record<string, { noteIds: string[] }> }).entities[
    projectId
  ]?.noteIds;

/** The items a download deletes that this browser edited later, as the browser decides before the plan. */
const winnersOf = (deleteOps: Operation[], shown: State, own: Operation[]): string[] =>
  findEditsThatBeatDeletes({
    deletes: itemsRemovedBy(deleteOps, taskState(shown)),
    own,
  }).map(({ entityId }) => entityId);

const addProject = (id: string): Operation =>
  ({
    ...makeOp(B, '[Project] Add Project', 'CRT', id, {
      project: { ...DEFAULT_PROJECT, id, title: 'project' },
    }),
    entityType: 'PROJECT',
  }) as unknown as Operation;

const deleteProject = (
  id: string,
  contents: { noteIds?: string[]; allTaskIds?: string[] },
): Operation =>
  ({
    ...makeOp(B, '[Task Shared] deleteProject', 'DEL', id, {
      projectId: id,
      noteIds: contents.noteIds ?? [],
      allTaskIds: contents.allTaskIds ?? [],
      [PROJECT_DELETE_WINS_MARKER]: true,
    }),
    entityType: 'PROJECT',
  }) as unknown as Operation;

/** The state both browsers start from: the app's initial state with one task. */
const start = (): State =>
  apply(root(undefined, { type: '@@init' }), [addTask(B, 't1', 'one')], B);

// Reducers stamp `modified` with the clock; a frozen clock lets two runs of the same changes compare equal.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${DAY}T12:00:00Z`));
});

afterEach(() => {
  vi.useRealTimers();
  setUnsavedLocalTimeSource(() => NO_UNSAVED_LOCAL_TIME);
  clearDeferredActions();
  takeReplayedConfirmedState();
});

describe('server-order replay', () => {
  it('ends in the bridge order where applying the download on top would not', () => {
    const confirmed = start();
    const a1 = addTask(A, 'a1', 'from A');
    const b1 = addTask(B, 'b1', 'from B');
    const shown = apply(confirmed, [a1]);

    // B's task reached the server first (10), A's second (11).
    const plan = planServerOrderApply({
      downloaded: [{ op: b1, serverSeq: 10 }],
      accepted: [{ op: a1, serverSeq: 11 }],
      unsent: [],
      hasConfirmedState: true,
    });
    if (plan.kind !== 'replay') throw new Error(`expected a replay, got ${plan.kind}`);
    const after = root(
      shown,
      serverOrderReplay({
        confirmed,
        ordered: plan.ordered,
        onTop: plan.onTop,
        downloadedOpIds: [b1.id],
        localClientId: A,
      }),
    );
    const bridge = apply(confirmed, [b1, a1], 'sp-bridge');

    // New tasks go to the top: the one stored last comes first.
    expect(inboxOrder(bridge)).toEqual(['a1', 'b1', 't1']);
    expect(inboxOrder(apply(shown, [b1]))).toEqual(['b1', 'a1', 't1']);
    expect(inboxOrder(after)).toEqual(['a1', 'b1', 't1']);
    expect(synced(after)).toEqual(synced(bridge));
    // A's change is numbered after the last downloaded one, so the confirmed state holds B's alone; A's stays on top.
    expect(synced(takeReplayedConfirmedState() as State)).toEqual(
      synced(apply(confirmed, [b1], 'sp-bridge')),
    );
  });

  it("brings back a task deleted on another browser without dropping that browser's new task", () => {
    const confirmed = start();
    const t1 = taskState(confirmed).entities.t1 as Task;
    // B deleted t1 (10) and added b1 (11); A renamed t1 offline, so its edit lands after the delete.
    const deleted = deleteTask(B, t1);
    const b1 = addTask(B, 'b1', 'from B');
    const edit = rename(A, 't1', 'one, edited by A');
    const shown = apply(confirmed, [edit]);

    expect(winnersOf([deleted], shown, [edit])).toEqual(['t1']);
    const states = bringBackTaskStates(['t1'], new Set(['t1']), taskState(shown), []);
    const saves = states.map((task) => lwwSave(A, 'TASK', task));
    const after = root(
      shown,
      serverOrderReplay({
        confirmed,
        ordered: [deleted, b1],
        onTop: [edit, ...saves],
        downloadedOpIds: [deleted.id, b1.id],
        localClientId: A,
      }),
    );
    const bridge = apply(confirmed, [deleted, b1, edit, ...saves], 'sp-bridge');

    expect(inboxOrder(bridge)).toEqual(['b1', 't1']);
    expect(tasks(bridge).entities.t1.title).toBe('one, edited by A');
    expect(synced(after)).toEqual(synced(bridge));
    // Seen on dev 2026-11-20: a copy of the project's list taken before the download dropped b1 everywhere.
    const listCopy = lwwSave(
      A,
      'PROJECT',
      { id: 'INBOX_PROJECT', taskIds: inboxOrder(shown), backlogTaskIds: [] } as {
        id: string;
      },
      'patch',
    );
    expect(inboxOrder(apply(bridge, [listCopy], 'sp-bridge'))).toEqual(['t1']);
  });

  it('brings back an edited subtask with its deleted parent, and only that subtask', () => {
    const confirmed = apply(
      start(),
      [
        addTask(B, 'p', 'parent'),
        addSubTask(B, 's1', 'sub one', 'p'),
        addSubTask(B, 's2', 'sub two', 'p'),
      ],
      B,
    );
    const entities = taskState(confirmed).entities;
    const deleted = deleteTask(B, entities.p as Task, [
      entities.s1 as Task,
      entities.s2 as Task,
    ]);
    const edit = rename(A, 's1', 'sub one, edited by A');
    const shown = apply(confirmed, [edit]);

    // The delete names only the parent; its subtasks are found through it.
    const removed = itemsRemovedBy([deleted], taskState(shown));
    expect(removed.map(({ entityId }) => entityId).sort()).toEqual(['p', 's1', 's2']);
    // The delete's own payload names them too, for a subtask this browser no longer shows under the parent.
    expect(
      itemsRemovedBy([deleted], undefined)
        .map(({ entityId }) => entityId)
        .sort(),
    ).toEqual(['p', 's1', 's2']);
    expect(winnersOf([deleted], shown, [edit])).toEqual(['s1']);
    const states = bringBackTaskStates(
      ['s1'],
      new Set(removed.map(({ entityId }) => entityId)),
      taskState(shown),
      [],
    );
    expect(states.map((task) => [task.id, task.subTaskIds])).toEqual([
      ['p', []],
      ['s1', []],
    ]);
    const bridge = apply(
      confirmed,
      [deleted, edit, ...states.map((task) => lwwSave(A, 'TASK', task))],
      'sp-bridge',
    );

    const after = tasks(bridge).entities as unknown as Record<string, Task>;
    expect(after.p.subTaskIds).toEqual(['s1']);
    expect(after.s1.title).toBe('sub one, edited by A');
    expect(after.s2).toBeUndefined();
    expect(inboxOrder(bridge)).toEqual(['t1', 'p']);
  });

  it('brings back a task without the tracked time not saved as a change yet, so it is counted once', () => {
    const confirmed = start();
    const t1 = taskState(confirmed).entities.t1 as Task;
    const deleted = deleteTask(B, t1);
    const edit = rename(A, 't1', 'one, edited by A');
    const edited = apply(confirmed, [edit]);
    const shown: State = {
      ...edited,
      tasks: {
        ...tasks(edited),
        entities: {
          ...tasks(edited).entities,
          t1: { ...tasks(edited).entities.t1, timeSpentOnDay: { [DAY]: 60_000 } },
        },
      },
    };
    const unsaved = {
      taskTime: [{ id: 't1', date: DAY, duration: 60_000 }],
      stopwatch: [],
    };
    setUnsavedLocalTimeSource(() => unsaved);

    const saves = bringBackTaskStates(
      ['t1'],
      new Set(['t1']),
      taskState(shown),
      unsaved.taskTime,
    ).map((task) => lwwSave(A, 'TASK', task));
    const after = root(
      shown,
      serverOrderReplay({
        confirmed,
        ordered: [deleted],
        onTop: [edit, ...saves],
        downloadedOpIds: [deleted.id],
        localClientId: A,
      }),
    );
    const bridge = apply(confirmed, [deleted, edit, ...saves], 'sp-bridge');

    expect(tasks(after).entities.t1.timeSpentOnDay[DAY]).toBe(60_000);
    expect(tasks(after).entities.t1.title).toBe('one, edited by A');
    // The time reaches the bridge with the change that saves it, not with the bring-back save.
    expect(tasks(bridge).entities.t1.timeSpentOnDay[DAY]).toBeUndefined();
  });

  it('keeps a project deleted on another browser deleted, with its tasks, even after an unsent edit to one of them', () => {
    const withProject = apply(
      start(),
      [
        {
          ...makeOp(B, '[Project] Add Project', 'CRT', 'p1', {
            project: { ...DEFAULT_PROJECT, id: 'p1', title: 'project' },
          }),
          entityType: 'PROJECT',
        } as unknown as Operation,
        {
          ...addTask(B, 'pt1', 'in the project'),
          payload: {
            actionPayload: {
              task: {
                ...buildTaskEntity({ title: 'in the project' }),
                id: 'pt1',
                projectId: 'p1',
              },
              workContextId: 'p1',
              workContextType: 'PROJECT',
              isAddToBacklog: false,
              isAddToBottom: false,
            },
            entityChanges: [],
          },
        } as unknown as Operation,
      ],
      B,
    );
    const unsent = rename(A, 'pt1', 'edited on A');
    const shown = apply(withProject, [unsent]);
    expect(tasks(shown).entities.pt1.title).toBe('edited on A');
    expect((shown.projects as { ids: string[] }).ids).toContain('p1');
    const projectDelete = {
      ...makeOp(B, '[Task Shared] deleteProject', 'DEL', 'p1', {
        projectId: 'p1',
        noteIds: [],
        allTaskIds: ['pt1'],
        [PROJECT_DELETE_WINS_MARKER]: true,
      }),
      entityType: 'PROJECT',
    } as unknown as Operation;

    expect(winnersOf([projectDelete], shown, [unsent])).toEqual([]);

    const after = root(
      shown,
      serverOrderReplay({
        confirmed: withProject,
        ordered: [projectDelete],
        onTop: [unsent],
        downloadedOpIds: [projectDelete.id],
        localClientId: A,
      }),
    );

    expect(tasks(after).ids).not.toContain('pt1');
    expect((after.projects as { ids: string[] }).ids).not.toContain('p1');
  });

  it('keeps a task deleted when the edit that arrives after the delete was made before it', () => {
    const confirmed = start();
    const edit = rename(A, 't1', 'edited by A before the delete');
    const deleted = deleteTask(B, taskState(confirmed).entities.t1 as Task);
    const shown = apply(confirmed, [edit]);

    expect(winnersOf([deleted], shown, [edit])).toEqual([]);
    const after = root(
      shown,
      serverOrderReplay({
        confirmed,
        ordered: [deleted],
        onTop: [edit],
        downloadedOpIds: [deleted.id],
        localClientId: A,
      }),
    );
    const bridge = apply(confirmed, [deleted, edit], 'sp-bridge');

    expect(tasks(after).ids).not.toContain('t1');
    expect(tasks(bridge).ids).not.toContain('t1');
    expect(synced(after)).toEqual(synced(bridge));
  });

  it('brings back a task whose later edit reached the server before the delete', () => {
    const confirmed = start();
    const t1 = taskState(confirmed).entities.t1 as Task;
    // A renamed t1 online (stored at 10); B deleted it offline earlier and synced afterwards (11).
    const edit = rename(A, 't1', 'edited by A');
    const deleted = { ...deleteTask(B, t1), timestamp: edit.timestamp - 60_000 };
    const shown = apply(confirmed, [edit]);
    const download = {
      downloaded: [{ op: deleted, serverSeq: 11 }],
      accepted: [{ op: edit, serverSeq: 10 }],
      hasConfirmedState: true,
    };
    expect(planServerOrderApply({ ...download, unsent: [] }).kind).toBe('in-order');

    expect(winnersOf([deleted], shown, [edit])).toEqual(['t1']);
    const saves = bringBackTaskStates(['t1'], new Set(['t1']), taskState(shown), []).map(
      (task) => lwwSave(A, 'TASK', task),
    );
    // The save joins the unsent edits, so the batch replays instead of applying the delete on top.
    const plan = planServerOrderApply({ ...download, unsent: saves });
    if (plan.kind !== 'replay') throw new Error(`expected a replay, got ${plan.kind}`);
    const after = root(
      shown,
      serverOrderReplay({
        confirmed,
        ordered: plan.ordered,
        onTop: plan.onTop,
        downloadedOpIds: [deleted.id],
        localClientId: A,
      }),
    );
    const bridge = apply(confirmed, [edit, deleted, ...saves], 'sp-bridge');

    expect(tasks(bridge).entities.t1.title).toBe('edited by A');
    expect(inboxOrder(bridge)).toEqual(['t1']);
    expect(synced(after)).toEqual(synced(bridge));
  });

  it('withdraws an unsent bring-back that a later delete beats', () => {
    const confirmed = start();
    const t1 = taskState(confirmed).entities.t1 as Task;
    const save = lwwSave(A, 'TASK', t1);
    const deleted = deleteTask(B, t1);

    expect(
      findRecreationsBeatenByDeletes({
        deletes: itemsRemovedBy([deleted], taskState(confirmed)),
        unsent: [save, rename(A, 't1', 'plain edit')],
        recreatesItem,
      }),
    ).toEqual([save]);
    // Sent anyway, it would bring the task back on the bridge although the delete is later.
    expect(tasks(apply(confirmed, [deleted, save], 'sp-bridge')).ids).toContain('t1');
  });

  it("brings back a note edited after its delete into its project's notes and Today", () => {
    const confirmed = apply(
      start(),
      [noteOp(B, '[Note] Add Note', 'CRT', 'n1', { note: pinnedNote('INBOX_PROJECT') })],
      B,
    );
    expect(projectNoteIds(confirmed, 'INBOX_PROJECT')).toEqual(['n1']);
    const deleted = noteOp(B, '[Note] Delete Note', 'DEL', 'n1', {
      id: 'n1',
      projectId: 'INBOX_PROJECT',
      isPinnedToToday: true,
    });
    const edit = noteOp(A, '[Note] Update Note', 'UPD', 'n1', {
      note: { id: 'n1', changes: { content: 'edited by A' } },
    });
    const shown = apply(confirmed, [edit]);

    expect(winnersOf([deleted], shown, [edit])).toEqual(['n1']);
    const saves = bringBackNoteStates(['n1'], notes(shown)).map((note) =>
      lwwSave(A, 'NOTE', note),
    );
    const bridge = apply(confirmed, [deleted, edit, ...saves], 'sp-bridge');

    expect(notes(bridge).entities.n1?.content).toBe('edited by A');
    expect(projectNoteIds(bridge, 'INBOX_PROJECT')).toEqual(['n1']);
    expect(notes(bridge).todayOrder).toEqual(['n1']);
  });

  it('keeps a note deleted with its project, even with a bring-back save', () => {
    const confirmed = apply(
      start(),
      [
        addProject('p1'),
        noteOp(B, '[Note] Add Note', 'CRT', 'n1', { note: pinnedNote('p1') }),
      ],
      B,
    );
    const save = lwwSave(A, 'NOTE', notes(confirmed).entities.n1 as Note);

    const bridge = apply(
      confirmed,
      [deleteProject('p1', { noteIds: ['n1'] }), save],
      'sp-bridge',
    );

    expect(notes(bridge).entities.n1).toBeUndefined();
    expect(notes(bridge).todayOrder).not.toContain('n1');
  });

  it('puts an unsent edit on top of a downloaded edit to the same field', () => {
    const confirmed = start();
    const mine = rename(A, 't1', 'A offline');
    const theirs = rename(B, 't1', 'B online');
    const shown = apply(confirmed, [mine]);

    const after = root(
      shown,
      serverOrderReplay({
        confirmed,
        ordered: [theirs],
        onTop: [mine],
        downloadedOpIds: [theirs.id],
        localClientId: A,
      }),
    );

    expect(tasks(after).entities.t1.title).toBe('A offline');
    expect(tasks(takeReplayedConfirmedState() as State).entities.t1.title).toBe(
      'B online',
    );
    // The server stores A's edit after B's, so the bridge ends the same way.
    expect(synced(after)).toEqual(synced(apply(confirmed, [theirs, mine], 'sp-bridge')));
  });

  it('keeps the open task, the running timer and local-only features from the state shown', () => {
    const confirmed = start();
    const base = apply(confirmed, [addTask(A, 't2', 'two')]);
    const shown: State = {
      ...base,
      tasks: { ...tasks(base), currentTaskId: 't1', selectedTaskId: 't2' },
      layout: { ...(base.layout as State), isShowNotes: true },
    };
    const theirs = rename(B, 't1', 'renamed by B');

    const after = root(
      shown,
      serverOrderReplay({
        confirmed,
        ordered: [theirs],
        onTop: [],
        downloadedOpIds: [theirs.id],
        localClientId: A,
      }),
    );

    expect(tasks(after).currentTaskId).toBe('t1');
    // t2 was never sent, and the replay was told nothing of it: the panel closes rather than pointing at nothing.
    expect(tasks(after).selectedTaskId).toBeNull();
    expect((after.layout as State).isShowNotes).toBe(true);
    expect(tasks(after).entities.t1.title).toBe('renamed by B');
  });

  it('adds back tracked time not saved as a change yet', () => {
    const confirmed = start();
    const shown: State = {
      ...confirmed,
      tasks: {
        ...tasks(confirmed),
        entities: {
          ...tasks(confirmed).entities,
          t1: { ...tasks(confirmed).entities.t1, timeSpentOnDay: { [DAY]: 60_000 } },
        },
      },
    };
    setUnsavedLocalTimeSource(() => ({
      taskTime: [{ id: 't1', date: DAY, duration: 60_000 }],
      stopwatch: [],
    }));
    const theirs = rename(B, 't1', 'renamed by B');

    const after = root(
      shown,
      serverOrderReplay({
        confirmed,
        ordered: [theirs],
        onTop: [],
        downloadedOpIds: [theirs.id],
        localClientId: A,
      }),
    );

    expect(tasks(after).entities.t1.timeSpentOnDay[DAY]).toBe(60_000);
    expect(tasks(after).entities.t1.title).toBe('renamed by B');
  });

  it('applies edits made while the download was being applied on top', () => {
    const confirmed = start();
    const during = rename(A, 't1', 'typed during the download');
    const action = convertOpToAction(during) as PersistentAction;
    const localAction = { ...action, meta: { ...action.meta, isRemote: false } };
    const shown = root(confirmed, localAction);
    bufferDeferredAction(localAction as PersistentAction);
    const theirs = makeOp(B, '[Task Shared] updateTask', 'UPD', 't1', {
      task: { id: 't1', changes: { notes: 'note from B' } },
    });

    const after = root(
      shown,
      serverOrderReplay({
        confirmed,
        ordered: [theirs],
        onTop: [],
        downloadedOpIds: [theirs.id],
        localClientId: A,
      }),
    );

    expect(tasks(after).entities.t1.title).toBe('typed during the download');
    expect((tasks(after).entities.t1 as unknown as { notes: string }).notes).toBe(
      'note from B',
    );
  });

  it('rebuilds the confirmed state from the server history without changing the state shown', () => {
    const shown = apply(start(), [addTask(A, 'a1', 'unsent from A')]);
    const history = [addTask(B, 't1', 'one'), rename(B, 't1', 'renamed by B')];

    const after = root(shown, serverOrderRebuild({ ops: history, localClientId: A }));

    expect(after).toBe(shown);
    const rebuilt = takeReplayedConfirmedState() as State;
    expect(synced(rebuilt)).toEqual(
      synced(apply(root(undefined, { type: '@@init' }), history, 'sp-bridge')),
    );
    expect(tasks(rebuilt).entities.a1).toBeUndefined();
  });

  it('counts tracked time once when the state shown becomes the confirmed state and is replayed', () => {
    const base = start();
    const shown: State = {
      ...base,
      tasks: {
        ...tasks(base),
        entities: {
          ...tasks(base).entities,
          t1: { ...tasks(base).entities.t1, timeSpentOnDay: { [DAY]: 90_000 } },
        },
      },
    };
    // 30 s were saved as a change already, 60 s are still only counted in this browser.
    const unsaved = {
      taskTime: [{ id: 't1', date: DAY, duration: 60_000 }],
      stopwatch: [],
    };
    const confirmed = withoutUnsavedTaskTime(shown, unsaved);
    expect(tasks(confirmed).entities.t1.timeSpentOnDay[DAY]).toBe(30_000);

    setUnsavedLocalTimeSource(() => unsaved);
    const theirs = rename(B, 't1', 'renamed by B');
    const after = root(
      shown,
      serverOrderReplay({
        confirmed,
        ordered: [theirs],
        onTop: [],
        downloadedOpIds: [theirs.id],
        localClientId: A,
      }),
    );
    expect(tasks(after).entities.t1.timeSpentOnDay[DAY]).toBe(90_000);
  });

  it('names every store feature as synced or local-only', () => {
    const keys = Object.keys(start());
    const localOnly = keys.filter((key) => !SYNCED_FEATURE_KEYS.includes(key)).sort();
    expect(SYNCED_FEATURE_KEYS.every((key) => keys.includes(key))).toBe(true);
    expect(localOnly).toEqual(
      ['appState', 'focusMode', 'idle', 'layout', 'workContext'].sort(),
    );
  });
});

describe('applying a checkpoint', () => {
  const checkpointOf = (state: State): Operation =>
    ({
      ...makeOp(B, '[SP_ALL] Load(import) all data', 'REPAIR', 'ALL', {}),
      entityType: 'ALL',
      payload: { appDataComplete: { task: state.tasks, project: state.projects } },
      repairBaseServerSeq: 7,
    }) as unknown as Operation;

  it('keeps the open task, the running timer and the tracked time not saved yet', () => {
    const base = start();
    const shown: State = {
      ...base,
      tasks: {
        ...tasks(base),
        currentTaskId: 't1',
        selectedTaskId: 't1',
        entities: {
          ...tasks(base).entities,
          t1: { ...tasks(base).entities.t1, timeSpentOnDay: { [DAY]: 60_000 } },
        },
      },
    };
    setUnsavedLocalTimeSource(() => ({
      taskTime: [{ id: 't1', date: DAY, duration: 60_000 }],
      stopwatch: [],
    }));
    const checkpoint = checkpointOf(apply(base, [rename(B, 't1', 'renamed by B')], B));

    const after = root(
      shown,
      bulkApplyOperations({
        operations: [checkpoint],
        localClientId: A,
        keepsLocalOnlyState: true,
      }),
    );

    expect(tasks(after).currentTaskId).toBe('t1');
    expect(tasks(after).selectedTaskId).toBe('t1');
    expect(tasks(after).entities.t1.timeSpentOnDay[DAY]).toBe(60_000);
    expect(tasks(after).entities.t1.title).toBe('renamed by B');
  });

  it('names the shown tasks and notes a checkpoint holds nowhere, its archives included', () => {
    const base = apply(
      start(),
      [
        addTask(B, 't2', 'archived elsewhere'),
        noteOp(B, '[Note] Add Note', 'CRT', 'n1', { note: pinnedNote('INBOX_PROJECT') }),
      ],
      B,
    );
    const checkpoint = {
      task: { ids: [], entities: {} },
      note: { ids: [], entities: {} },
      archiveYoung: { task: { ids: ['t2'], entities: { t2: tasks(base).entities.t2 } } },
    };

    expect(
      itemsMissingFromCheckpoint(
        { tasks: taskState(base), notes: notes(base) },
        checkpoint,
      ),
    ).toEqual([
      { entityType: 'TASK', entityId: 't1' },
      { entityType: 'NOTE', entityId: 'n1' },
    ]);
  });

  it('brings back an item a checkpoint lacks only when the edit is later than its recorded delete', () => {
    const base = start();
    const edit = rename(A, 't1', 'edited by A');
    const shown = apply(base, [edit]);
    const candidates = itemsMissingFromCheckpoint(
      { tasks: taskState(shown), notes: undefined },
      { task: { ids: [], entities: {} } },
    );
    const decide = (deletedAt?: number): string[] =>
      findEditsThatBeatDeletes({
        deletes: deleteTimesWithParents(
          candidates,
          deletedAt === undefined
            ? []
            : [{ entityType: 'TASK', entityId: 't1', deletedAt }],
        ),
        own: [edit],
      }).map(({ entityId }) => entityId);

    expect(decide(edit.timestamp - 1)).toEqual(['t1']);
    expect(decide(edit.timestamp + 1)).toEqual([]);
    expect(decide()).toEqual([]);

    const emptied = apply(
      root(
        shown,
        bulkApplyOperations({
          operations: [
            checkpointOf(
              apply(base, [deleteTask(B, taskState(base).entities.t1 as Task)], B),
            ),
          ],
          localClientId: A,
          keepsLocalOnlyState: true,
        }),
      ),
      [edit],
    );
    const missingKeys = new Set(['TASK:t1']);
    // The unsent edit to the missing task changes nothing, so it is not counted as kept.
    expect(editsShown([edit], missingKeys, emptied)).toEqual([]);
    const save = lwwSave(A, 'TASK', taskState(shown).entities.t1 as Task);
    const broughtBack = apply(emptied, [save]);
    expect(tasks(broughtBack).entities.t1.title).toBe('edited by A');
    expect(editsShown([edit], missingKeys, broughtBack)).toEqual([edit]);
  });

  it('applies the edits made while it applied again, after the unsent edits put back on top of it', () => {
    const base = start();
    const unsent = rename(A, 't1', 'unsent before the checkpoint');
    const shownBefore = apply(base, [unsent]);
    const during = makeOp(A, '[Task Shared] updateTask', 'UPD', 't1', {
      task: { id: 't1', changes: { notes: 'typed during the checkpoint' } },
    });
    const action = convertOpToAction(during) as PersistentAction;
    const localAction = { ...action, meta: { ...action.meta, isRemote: false } };
    const shown = root(shownBefore, localAction);
    bufferDeferredAction(localAction as PersistentAction);
    const checkpoint = checkpointOf(apply(base, [rename(B, 't1', 'renamed by B')], B));

    const fromCheckpoint = root(
      shown,
      bulkApplyOperations({
        operations: [checkpoint],
        localClientId: A,
        keepsLocalOnlyState: true,
      }),
    );
    const withUnsent = apply(fromCheckpoint, [unsent]);
    const after = root(withUnsent, reapplyEditsReplacedByCheckpoint());

    expect(tasks(after).entities.t1.title).toBe('unsent before the checkpoint');
    expect((tasks(after).entities.t1 as unknown as { notes: string }).notes).toBe(
      'typed during the checkpoint',
    );
  });
});

describe('opsAppliedBy', () => {
  it('names the changes a replay applies, so the effects that react to downloaded changes see them', () => {
    const theirs = rename(B, 't1', 'renamed by B');
    const mine = rename(A, 't1', 'renamed by A');

    expect(
      opsAppliedBy(
        serverOrderReplay({
          confirmed: {},
          ordered: [theirs],
          onTop: [mine],
          downloadedOpIds: [theirs.id],
        }),
      ),
    ).toEqual([theirs, mine]);
    expect(opsAppliedBy(bulkApplyOperations({ operations: [theirs] }))).toEqual([theirs]);
    expect(opsAppliedBy({ type: 'other' })).toEqual([]);
  });
});

describe('runWithBulkReplayFailureFilter', () => {
  it('passes on only the failures the filter keeps', () => {
    const seen: BulkReplayReducerFailure[] = [];
    const op = (id: string): Operation => ({ id }) as Operation;
    runWithBulkReplayFailureCollector(
      (failure) => seen.push(failure),
      () =>
        runWithBulkReplayFailureFilter(
          (o) => o.id === 'downloaded',
          () => {
            reportBulkReplayReducerFailure(op('downloaded'), new Error('x'));
            reportBulkReplayReducerFailure(op('own'), new Error('y'));
          },
        ),
    );
    expect(seen.map((failure) => failure.op.id)).toEqual(['downloaded']);
  });
});

describe('rebuilding the confirmed state from the server history', () => {
  const seqd = (ops: Operation[], from: number): { op: Operation; serverSeq: number }[] =>
    ops.map((op, i) => ({ op, serverSeq: from + i }));

  it('starts from the initial state when the batch starts at the first change', () => {
    expect(historyBeforeBatch(seqd([addTask(B, 'b1', 'from B')], 1), 1)).toEqual([]);
  });

  it('needs a checkpoint or the first change, and every number up to the batch', () => {
    const ops = [
      addTask(B, 'b1', 'one'),
      rename(B, 'b1', 'two'),
      rename(B, 'b1', 'three'),
    ];
    expect(
      historyBeforeBatch(seqd(ops, 1), 3)?.map(({ serverSeq }) => serverSeq),
    ).toEqual([1, 2]);
    expect(historyBeforeBatch(seqd(ops, 5), 7)).toBeUndefined();
    expect(historyBeforeBatch(seqd(ops, 1), 5)).toBeUndefined();
  });

  it('drops what a download drops: changes made without knowing a full import, and changes this build cannot read', async () => {
    const injector = Injector.create({
      providers: [
        { provide: INJECTOR_SCOPE, useValue: 'root' },
        {
          provide: OperationLogStoreService,
          useValue: { getLatestFullStateOpEntry: async () => undefined },
        },
      ],
    });
    const migration = injector.get(SchemaMigrationService);
    const filter = injector.get(SyncImportFilterService);
    const fullImport = {
      ...makeOp(B, '[SP_ALL] Load(import) all data', 'SYNC_IMPORT', 'all', {}),
      entityType: 'ALL',
      vectorClock: { [B]: 50 },
    } as unknown as Operation;
    // C edited without having seen the import; B's later edit knows it.
    const C = 'B_browserC';
    const straggler = { ...rename(C, 't1', 'stale'), vectorClock: { [C]: 3 } };
    const after = { ...rename(B, 't1', 'after the import'), vectorClock: { [B]: 51 } };

    const ops = await opsAsDownloadApplies(
      [fullImport, straggler, after],
      migration,
      filter,
    );
    expect(ops?.map((op) => op.id)).toEqual([fullImport.id, after.id]);

    const tooNew = { ...after, schemaVersion: migration.getCurrentVersion() + 1 };
    expect(
      await opsAsDownloadApplies([fullImport, tooNew], migration, filter),
    ).toBeUndefined();
  });
});

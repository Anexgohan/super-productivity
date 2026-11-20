/**
 * Stage 9 (anex): a browser replays in the server's order and ends up where the bridge does. Runs the app's own reducers
 * from source (the root reducer the bridge assembles, with every meta-reducer), on synthetic data.
 */
import '@angular/compiler';
import '../app-rules/globals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Action } from '@ngrx/store';
import { planServerOrderApply } from '@sp/sync-core';
import { buildRootReducer } from '../app-rules/root-reducer';
import { buildTaskEntity } from '../src/op-factory';
import { bulkApplyOperations } from '../../../src/app/op-log/apply/bulk-hydration.action';
import {
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

const deleteTask = (clientId: string, task: Task, subTasks: Task[] = []): Operation => ({
  ...makeOp(clientId, '[Task Shared] deleteTask', 'DEL', task.id, {
    task: { ...task, subTasks },
  }),
  entityIds: [task.id, ...subTasks.map((sub) => sub.id)],
});

/** A whole-entity save as ConflictResolutionService.createLWWUpdateOp builds it, marked as bringing the entity back. */
const lwwSave = (
  clientId: string,
  entityType: 'TASK' | 'PROJECT',
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

    const states = bringBackTaskStates(['t1'], new Set(['t1']), taskState(shown));
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

    const states = bringBackTaskStates(
      ['s1'],
      new Set(['p', 's1', 's2']),
      taskState(shown),
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

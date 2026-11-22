/**
 * App actions (anex/app-actions) from source: the parts the built worker can't be made to show, a reducer that refuses, the caller's clock
 * coming off again, and the app's own op conversion giving the same op as an action build. Synthetic data only.
 */
import '@angular/compiler';
import '../app-rules/globals';
import { describe, expect, it, vi } from 'vitest';
import type { Action } from '@ngrx/store';
import { createEffect } from '@ngrx/effects';
import { of, throwError, type Observable } from 'rxjs';
import { TaskSharedActions } from '../../../src/app/root-store/meta/task-shared.actions';
import { addSubTask } from '../../../src/app/features/tasks/store/task.actions';
import { DEFAULT_TASK, type Task } from '../../../src/app/features/tasks/task.model';
import { WorkContextType } from '../../../src/app/features/work-context/work-context.model';
import { operationFromAction } from '../../../src/app/op-log/capture/action-to-operation.util';
import { syncOpFromOperation } from '../../../src/app/op-log/sync/upload-payload.util';
import type { PersistentAction } from '../../../src/app/op-log/core/persistent-action.interface';
import { buildRootReducer, type RootState } from '../app-rules/root-reducer';
import { act, ActError, subscribeEffects, type ActBoard } from '../app-rules/actions/act';
import { realNow, withCallerClock } from '../app-rules/actions/clock';

// The app's full validation is compiled by typia's transform, which the worker build runs and vitest doesn't; nothing here tests it.
vi.mock('../../../src/app/op-log/validation/validation-fn', () => ({
  validateFull: () => ({ isValid: true }),
}));

const RealDate = Date;

const task = (id: string, title: string, extra: Partial<Task> = {}): Task => ({
  ...DEFAULT_TASK,
  id,
  title,
  created: realNow(),
  projectId: 'INBOX_PROJECT',
  ...extra,
});

/** The app's initial state with parent P (subtask S) and task T, reduced by the app's own reducers. */
const seeded = (): { state: RootState; reducer: ActBoard['reducer'] } => {
  const reducer = buildRootReducer();
  let state = reducer(undefined, { type: '@ngrx/store/init' });
  const add = (t: Task): Action =>
    TaskSharedActions.addTask({
      task: t,
      workContextId: 'INBOX_PROJECT',
      workContextType: WorkContextType.PROJECT,
      isAddToBacklog: false,
      isAddToBottom: true,
    });
  state = reducer(state, add(task('P', 'parent')));
  state = reducer(
    state,
    addSubTask({ task: task('S', 'sub', { parentId: 'P' }), parentId: 'P' }),
  );
  state = reducer(state, add(task('T', 'other')));
  return { state, reducer };
};

const noArchive: ActBoard['archive'] = {
  loadArchiveYoung: async () => undefined,
  loadArchiveOld: async () => undefined,
  hasArchiveYoung: async () => false,
  hasArchiveOld: async () => false,
};

const boardOf = (overrides: Partial<ActBoard> = {}): ActBoard => ({
  clientId: 'B_bridge',
  ...seeded(),
  archive: noArchive,
  ...overrides,
});

describe('app actions from source', () => {
  it('answers 409 and builds nothing when a reducer refuses the change', async () => {
    const board = boardOf();
    const reducer = board.reducer;
    const before = board.state;
    const refusing: ActBoard['reducer'] = (state, action) => {
      if (action.type === TaskSharedActions.deleteTasks.type) throw new Error('refused');
      return reducer(state, action);
    };

    const err = await act(
      { ...board, reducer: refusing },
      'deleteTasks',
      { taskIds: ['T'] },
      {},
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ActError);
    expect(err).toMatchObject({ statusCode: 409 });
    expect((err as Error).message).toContain('[Task Shared] deleteTasks');
    expect(board.state).toBe(before);
  });

  it("builds the op the app's own capture and upload build for the same action", async () => {
    const board = boardOf();
    const { ops } = await act(board, 'deleteTasks', { taskIds: ['P', 'T'] }, {});
    expect(ops).toHaveLength(1);

    // What a browser uploads: TaskService.removeMultipleTasks' action, through the capture and upload conversions.
    const entities = (board.state.tasks as { entities: Record<string, Task> }).entities;
    const appAction = TaskSharedActions.deleteTasks({
      taskIds: ['P', 'T'],
      tasks: ['P', 'S', 'T'].map((id) => entities[id]),
    }) as unknown as PersistentAction;
    const { op } = operationFromAction(appAction, {
      id: 'op-id',
      clientId: 'browser',
      vectorClock: { browser: 1 },
      timestamp: ops[0].timestamp,
      entityChanges: [],
    });
    const wire = syncOpFromOperation(op);
    const { id, clientId, vectorClock, ...rest } = wire as unknown as Record<
      string,
      unknown
    >;
    void id;
    void clientId;
    void vectorClock;
    expect(ops[0]).toEqual(rest);
  });

  it("runs the build on the caller's clock and puts the real one back, after a throw too", async () => {
    const callerNow = RealDate.UTC(2031, 2, 3, 9, 30);
    const seen = await withCallerClock(callerNow, async () => ({
      now: Date.now(),
      newDate: new Date().getTime(),
      named: new Date(0).getTime(),
      parsed: Date.parse('2020-01-01T00:00:00Z'),
      isDate: new Date() instanceof RealDate,
      real: realNow(),
    }));
    expect(Math.abs(seen.now - callerNow)).toBeLessThan(5_000);
    expect(Math.abs(seen.newDate - callerNow)).toBeLessThan(5_000);
    expect(seen.named).toBe(0);
    expect(seen.parsed).toBe(RealDate.UTC(2020, 0, 1));
    expect(seen.isDate).toBe(true);
    expect(Math.abs(seen.real - RealDate.now())).toBeLessThan(5_000);
    expect(Date).toBe(RealDate);

    await expect(
      withCallerClock(callerNow, async () => {
        throw new Error('build failed');
      }),
    ).rejects.toThrow('build failed');
    expect(Date).toBe(RealDate);
  });

  it('dispatches what a dispatching effect emits and never what a `dispatch: false` one does', () => {
    class Effects {
      saves$ = createEffect(() => of({ type: 'saved' }));
      looksOnly$ = createEffect(() => of({ type: 'not dispatched' }), {
        dispatch: false,
      });
      fails$ = createEffect(
        (): Observable<Action> => throwError(() => new Error('broke')),
      );
    }
    const dispatched: string[] = [];
    const failed: string[] = [];

    const subs = subscribeEffects(
      new Effects(),
      (a) => dispatched.push(a.type),
      (name) => failed.push(name),
    );

    expect(subs).toHaveLength(3);
    expect(dispatched).toEqual(['saved']);
    expect(failed).toEqual(['fails$']);
  });
});

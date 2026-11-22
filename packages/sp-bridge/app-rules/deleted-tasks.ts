/**
 * The tasks deleted on any device in the last 7 days, kept as the app's undo would put them back (anex/app-actions).
 *
 * The app's undoTaskDeleteMetaReducer captures a restore payload for every task delete it reduces; a browser keeps only the last, for its snack.
 * While downloaded ops apply, the recorder takes each of those, so a delete from any device can be undone through the API.
 * The app rules keep them in their cache, keyed by task, with the delete op's time.
 */
import type { Action, ActionReducer } from '@ngrx/store';
import { TaskSharedActions } from '../../../src/app/root-store/meta/task-shared.actions';
import {
  getLastDeletePayload,
  type RestoreDeletedTaskPayload,
} from '../../../src/app/root-store/meta/undo-task-delete.meta-reducer';

/** The server's window for a delete, after which a deleted task can no longer be put back. */
export const DELETED_TASK_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

export interface DeletedTask {
  /** The delete op's time. */
  deletedAt: number;
  payload: RestoreDeletedTaskPayload;
}

let recorded: RestoreDeletedTaskPayload[] | null = null;

/** Sits just inside the app's undo capture, so it reads the payload that capture has just made for this delete. */
export const deletedTaskRecorder =
  <S>(reducer: ActionReducer<S>): ActionReducer<S> =>
  (state: S | undefined, action: Action): S => {
    if (recorded && action.type === TaskSharedActions.deleteTask.type) {
      const payload = getLastDeletePayload();
      if (payload) recorded.push(payload);
    }
    return reducer(state, action);
  };

/** Runs `apply` with the recorder on and returns the deletes it reduced; an action build's own deletes are never recorded. */
export const recordDeletedTasks = async (
  apply: () => Promise<void>,
): Promise<RestoreDeletedTaskPayload[]> => {
  recorded = [];
  const deleted = recorded;
  try {
    await apply();
    return deleted;
  } finally {
    recorded = null;
  }
};

/** The entries still inside the window at `now`. */
export const keptDeletedTasks = (
  entries: Record<string, DeletedTask>,
  now: number,
): Record<string, DeletedTask> =>
  Object.fromEntries(
    Object.entries(entries).filter(([, e]) => now - e.deletedAt < DELETED_TASK_KEEP_MS),
  );

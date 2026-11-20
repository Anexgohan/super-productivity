import { BatchedTimeSyncEntry } from '../../../core/util/batched-time-sync-accumulator';
import { TaskState } from '../task.model';
import { updateTimeSpentForTask } from '../store/task.reducer.util';

/**
 * Removes locally accumulated task-time deltas from an op-log snapshot.
 *
 * The live store is updated on every timer tick, while the corresponding persistent
 * operation is intentionally batched. Persisting the live total during that window
 * would make the later delta overlap the snapshot and double-count on replay.
 */
export const projectPendingTimeFromTaskState = (
  state: TaskState,
  pendingEntries: readonly BatchedTimeSyncEntry[],
): TaskState => {
  let projectedState = state;

  for (const { id, date, duration } of pendingEntries) {
    const task = projectedState.entities[id];
    if (!task || !Number.isFinite(duration) || duration <= 0) {
      continue;
    }

    const currentForDay = task.timeSpentOnDay?.[date] || 0;
    const projectedForDay = Math.max(0, currentForDay - duration);
    const timeSpentOnDay = { ...task.timeSpentOnDay };
    if (projectedForDay > 0) {
      timeSpentOnDay[date] = projectedForDay;
    } else {
      delete timeSpentOnDay[date];
    }

    projectedState = updateTimeSpentForTask(id, timeSpentOnDay, projectedState);
  }

  return projectedState;
};

/**
 * Adds locally accumulated task-time deltas back onto a task state (anex, Stage 9).
 *
 * The inverse of projectPendingTimeFromTaskState: when a browser replays its state in the server's order, the
 * replayed state holds only the time already saved as changes, so the time tracked since is added back.
 */
export const addPendingTimeToTaskState = (
  state: TaskState,
  pendingEntries: readonly BatchedTimeSyncEntry[],
): TaskState => {
  let nextState = state;

  for (const { id, date, duration } of pendingEntries) {
    const task = nextState.entities[id];
    if (!task || !Number.isFinite(duration) || duration <= 0) {
      continue;
    }

    const timeSpentOnDay = {
      ...task.timeSpentOnDay,
      [date]: (task.timeSpentOnDay?.[date] || 0) + duration,
    };
    nextState = updateTimeSpentForTask(id, timeSpentOnDay, nextState);
  }

  return nextState;
};

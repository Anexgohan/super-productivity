/**
 * Task states a browser sends as bring-back saves, for tasks another browser deleted before this browser's edits to them reached the server.
 * Only the tasks go: a saved task re-adds itself to its project, tags and parent, at the end of each list.
 */
import { BatchedTimeSyncEntry } from '../../core/util/batched-time-sync-accumulator';
import { Task, TaskState } from '../../features/tasks/task.model';
import { projectPendingTimeFromTaskState } from '../../features/tasks/util/project-pending-time-from-task-state';

/**
 * The tasks to bring back, parents first and without their subtask lists, plus the parent of an edited subtask when the same download deleted it.
 * Tracked time not saved as a change yet is left out: the change that saves it later adds it.
 */
export const bringBackTaskStates = (
  editedTaskIds: Iterable<string>,
  deletedTaskIds: ReadonlySet<string>,
  shownTasks: TaskState | undefined,
  unsavedTaskTime: readonly BatchedTimeSyncEntry[],
): Task[] => {
  const tasks =
    shownTasks && projectPendingTimeFromTaskState(shownTasks, unsavedTaskTime);
  const wanted = new Set<string>();
  for (const id of editedTaskIds) {
    const parentId = tasks?.entities[id]?.parentId;
    if (parentId && deletedTaskIds.has(parentId)) {
      wanted.add(parentId);
    }
    wanted.add(id);
  }
  const found = [...wanted]
    .map((id) => tasks?.entities[id])
    .filter((task): task is Task => task !== undefined);
  return [
    ...found
      .filter((task) => !task.parentId)
      .map((task) => ({ ...task, subTaskIds: [] })),
    ...found.filter((task) => !!task.parentId),
  ];
};

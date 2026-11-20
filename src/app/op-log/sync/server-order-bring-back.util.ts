/**
 * anex fork, Stage 9: which task states a browser sends as "bring it back" saves, for tasks another browser deleted
 * before this browser's edits to them reached the server.
 *
 * Only the tasks themselves go: a saved task adds itself back to its project, its tags and its parent
 * (lww-update.meta-reducer.ts). A copy of a project's or a parent's whole list would be taken before the download is
 * applied, and arriving last it would drop whatever other browsers added in the meantime (seen on dev 2026-11-20: a
 * task the other browser had just added fell out of every list). So a brought-back task returns at the end of its
 * lists rather than at its old place.
 */
import { Task, TaskState } from '../../features/tasks/task.model';

/**
 * The tasks to bring back, parents first: a subtask is only restored under a parent that exists. A parent goes without
 * its subtask list, since its brought-back subtasks add themselves to it and the others stay deleted. The parent of an
 * edited subtask is brought back too when the same download deleted it, so the edit is not lost with it.
 */
export const bringBackTaskStates = (
  editedTaskIds: Iterable<string>,
  deletedTaskIds: ReadonlySet<string>,
  tasks: TaskState | undefined,
): Task[] => {
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

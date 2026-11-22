/**
 * Moving a task within its lists (anex/app-actions), built as TaskService.move builds a drag and drop.
 *
 * One input names the list and the task to go after; the builder picks the app's action for the list the task is in and the one it goes to.
 * A move never changes a task's project, parent or done state: those are routes of their own.
 */
import { moveTaskInTodayList } from '../../../../src/app/features/work-context/store/work-context-meta.actions';
import {
  moveAllProjectBacklogTasksToRegularList,
  moveProjectTaskInBacklogList,
  moveProjectTaskToBacklogList,
  moveProjectTaskToRegularList,
} from '../../../../src/app/features/project/store/project.actions';
import { moveSubTask } from '../../../../src/app/features/tasks/store/task.actions';
import { selectProjectFeatureState } from '../../../../src/app/features/project/store/project.selectors';
import type {
  Project,
  ProjectState,
} from '../../../../src/app/features/project/project.model';
import { selectTagFeatureState } from '../../../../src/app/features/tag/store/tag.reducer';
import type { TagState } from '../../../../src/app/features/tag/tag.model';
import { TODAY_TAG } from '../../../../src/app/features/tag/tag.const';
import { selectTodayTaskIds } from '../../../../src/app/features/work-context/store/work-context.selectors';
import { WorkContextType } from '../../../../src/app/features/work-context/work-context.model';
import type { Action } from '@ngrx/store';
import {
  ActionInputError,
  built,
  existingTask,
  type BuildContext,
  type Builder,
} from './build-context';

type MoveAction = 'moveTask' | 'moveAllBacklogToRegular';

export const existingProject = (ctx: BuildContext, id: string): Project => {
  const projects = ctx.select(selectProjectFeatureState as never) as ProjectState;
  const project = projects.entities[id];
  if (!project) throw new ActionInputError(`Project not found: ${id}`, 404);
  return project;
};

/** The anchor, checked to be another task of the list the task lands in. */
const checkAnchor = (taskId: string, anchor: string | null, list: string[]): void => {
  if (anchor === null) return;
  if (anchor === taskId || !list.includes(anchor)) {
    throw new ActionInputError(`Task ${anchor} is not another task of that list.`, 409);
  }
};

const notInList = (taskId: string): ActionInputError =>
  new ActionInputError(
    `Task ${taskId} is not in that list: moving it to another project or parent has a route of its own.`,
    409,
  );

export const MOVE_BUILDERS: { [N in MoveAction]: Builder<N> } = {
  moveTask: (ctx, { taskId, list, afterTaskId }) => {
    const task = existingTask(ctx, taskId);
    // A drop keeps the task in the done or the undone part of the list it is in.
    const part = task.isDone ? 'DONE' : 'UNDONE';
    let action: Action;
    if ('parentId' in list) {
      const parent = existingTask(ctx, list.parentId);
      if (task.parentId !== parent.id) throw notInList(taskId);
      checkAnchor(taskId, afterTaskId, parent.subTaskIds);
      action = moveSubTask({
        taskId,
        srcTaskId: parent.id,
        targetTaskId: parent.id,
        afterTaskId,
      });
    } else if ('projectId' in list) {
      const project = existingProject(ctx, list.projectId);
      const fromBacklog = project.backlogTaskIds.includes(taskId);
      if (!fromBacklog && !project.taskIds.includes(taskId)) throw notInList(taskId);
      const workContextId = project.id;
      if (list.backlog) {
        if (!project.isEnableBacklog) {
          throw new ActionInputError('That project has no backlog.', 409);
        }
        checkAnchor(taskId, afterTaskId, project.backlogTaskIds);
        action = fromBacklog
          ? moveProjectTaskInBacklogList({ taskId, afterTaskId, workContextId })
          : moveProjectTaskToBacklogList({ taskId, afterTaskId, workContextId });
      } else {
        checkAnchor(taskId, afterTaskId, project.taskIds);
        action = fromBacklog
          ? moveProjectTaskToRegularList({
              taskId,
              afterTaskId,
              workContextId,
              src: 'BACKLOG',
              target: part,
            })
          : moveTaskInTodayList({
              taskId,
              afterTaskId,
              workContextId,
              workContextType: WorkContextType.PROJECT,
              src: part,
              target: part,
            });
      }
    } else {
      let workContextId: string;
      let taskIds: string[];
      if ('today' in list) {
        workContextId = TODAY_TAG.id;
        taskIds = ctx.select(selectTodayTaskIds as never) as string[];
      } else {
        const tags = ctx.select(selectTagFeatureState as never) as TagState;
        const tag = tags.entities[list.tagId];
        if (!tag) throw new ActionInputError(`Tag not found: ${list.tagId}`, 404);
        workContextId = tag.id;
        taskIds =
          tag.id === TODAY_TAG.id
            ? (ctx.select(selectTodayTaskIds as never) as string[])
            : tag.taskIds;
      }
      if (!taskIds.includes(taskId)) throw notInList(taskId);
      checkAnchor(taskId, afterTaskId, taskIds);
      action = moveTaskInTodayList({
        taskId,
        afterTaskId,
        workContextId,
        workContextType: WorkContextType.TAG,
        src: part,
        target: part,
      });
    }
    return built(action);
  },

  // As the project's settings do when its backlog is turned off.
  moveAllBacklogToRegular: (ctx, { projectId }) => {
    const project = existingProject(ctx, projectId);
    if (project.backlogTaskIds.length === 0) {
      throw new ActionInputError('That project’s backlog is empty.', 409);
    }
    return built(moveAllProjectBacklogTasksToRegularList({ projectId }));
  },
};

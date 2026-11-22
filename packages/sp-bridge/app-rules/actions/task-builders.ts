/**
 * Archiving, logged time and edits to many tasks (anex/app-actions), each built as the app's own service builds it.
 */
import { TaskSharedActions } from '../../../../src/app/root-store/meta/task-shared.actions';
import {
  selectTaskById,
  selectTaskByIdWithSubTaskData,
} from '../../../../src/app/features/tasks/store/task.selectors';
import type {
  Task,
  TaskWithSubTasks,
} from '../../../../src/app/features/tasks/task.model';
import { removeTimeSpent } from '../../../../src/app/features/tasks/store/task.actions';
import {
  syncTimeSpent,
  TimeTrackingActions,
} from '../../../../src/app/features/time-tracking/store/time-tracking.actions';
import { unique } from '../../../../src/app/util/unique';
import { selectProjectFeatureState } from '../../../../src/app/features/project/store/project.selectors';
import type { ProjectState } from '../../../../src/app/features/project/project.model';
import {
  ActionInputError,
  built,
  existingTask,
  type BuildContext,
  type Builder,
} from './build-context';

type TaskAction =
  | 'moveToArchive'
  | 'restoreTask'
  | 'logTime'
  | 'removeTimeSpent'
  | 'updateManyTasks'
  | 'restoreDeletedTask';

const withSubTasks = (ctx: BuildContext, id: string): TaskWithSubTasks =>
  ctx.select(selectTaskByIdWithSubTaskData as never, { id }) as TaskWithSubTasks;

export const TASK_BUILDERS: { [N in TaskAction]: Builder<N> } = {
  // As TaskService.moveToArchive, parents only; the board's archive changes when the op comes back, as for any other device's archive.
  moveToArchive: (ctx, { taskIds }) => {
    const tasks = unique(taskIds).map((id) => {
      if (existingTask(ctx, id).parentId) {
        throw new ActionInputError(`Task ${id} is a subtask: archive its parent.`, 400);
      }
      return withSubTasks(ctx, id);
    });
    return built(TaskSharedActions.moveToArchive({ tasks }));
  },

  // As the history page's restore: the archived task and the archived subtasks it lists.
  restoreTask: async (ctx, { taskId }) => {
    if (ctx.select(selectTaskById as never, { id: taskId })) {
      throw new ActionInputError(`Task ${taskId} is on the board, not archived.`, 409);
    }
    if (!(await ctx.archive.hasTask(taskId))) {
      throw new ActionInputError(`Archived task not found: ${taskId}`, 404);
    }
    const task = await ctx.archive.getById(taskId);
    if (task.parentId) {
      throw new ActionInputError(
        `Task ${taskId} is an archived subtask: restore its parent.`,
        400,
      );
    }
    const archived = await ctx.archive.load();
    const subTasks = (task.subTaskIds ?? [])
      .map((id) => archived.entities[id])
      .filter((t): t is Task => !!t);
    return built(TaskSharedActions.restoreTask({ task, subTasks }));
  },

  // As TaskService.addTimeSpentAndSync: the local add lets the build's board and validation see the time, the sync op carries it.
  logTime: (ctx, { taskId, date, duration }) => {
    const task = existingTask(ctx, taskId);
    const day = date ?? ctx.dateService.todayStr();
    return built(
      TimeTrackingActions.addTimeSpent({
        task,
        date: day,
        duration,
        isFromTrackingReminder: false,
      }),
      syncTimeSpent({ taskId, date: day, duration }),
    );
  },

  // As TaskService.removeTimeSpent; more than the day holds is refused, so the reducer's clamp at zero never decides the result.
  removeTimeSpent: (ctx, { taskId, date, duration }) => {
    const task = existingTask(ctx, taskId);
    const day = date ?? ctx.dateService.todayStr();
    const held = task.timeSpentOnDay?.[day] ?? 0;
    if (duration > held) {
      throw new ActionInputError(
        `The task holds ${held} ms on ${day}, less than the ${duration} ms to remove.`,
        409,
      );
    }
    return built(removeTimeSpent({ id: taskId, date: day, duration }));
  },

  // One TaskService.update per task, as a person editing several tasks makes: each keeps the single-task rules and follow-ups.
  updateManyTasks: (ctx, { updates }) => {
    updates.forEach(({ taskId }) => existingTask(ctx, taskId));
    return built(
      ...updates.map(({ taskId, changes }) =>
        TaskSharedActions.updateTask({ task: { id: taskId, changes } }),
      ),
    );
  },

  // As the delete snack's undo, from what the app captured when the delete was applied here.
  restoreDeletedTask: (ctx, { taskId }) => {
    const payload = ctx.deletedTask(taskId);
    if (!payload) {
      throw new ActionInputError(
        `No task ${taskId} was deleted in the last 7 days.`,
        404,
      );
    }
    if (ctx.select(selectTaskById as never, { id: taskId })) {
      throw new ActionInputError(`Task ${taskId} exists again.`, 409);
    }
    const parentId = payload.parentContext?.parentTaskId;
    if (parentId && !ctx.select(selectTaskById as never, { id: parentId })) {
      throw new ActionInputError(
        'The task’s parent is gone, so it would have none.',
        409,
      );
    }
    const projectId = payload.projectContext?.projectId;
    const projects = ctx.select(selectProjectFeatureState as never) as ProjectState;
    if (projectId && !projects.entities[projectId]) {
      throw new ActionInputError(
        'The task’s project is gone, so it would have none.',
        409,
      );
    }
    return built(TaskSharedActions.restoreDeletedTask(payload));
  },
};

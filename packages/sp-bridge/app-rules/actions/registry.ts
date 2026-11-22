/**
 * The app actions the API offers, each built the way the app's own service builds it (anex/app-actions).
 *
 * A builder reads the board through the app's selectors and returns the app's action creators' actions, nothing hand-made.
 * What follows from them (completing a parent, scheduling a recurring task) is the app's effects' work, not a builder's.
 */
import type { Action } from '@ngrx/store';
import { nanoid } from 'nanoid';
import { TaskSharedActions } from '../../../../src/app/root-store/meta/task-shared.actions';
import {
  selectTaskById,
  selectTaskByIdWithSubTaskData,
  selectTaskEntities,
} from '../../../../src/app/features/tasks/store/task.selectors';
import type {
  Task,
  TaskWithSubTasks,
} from '../../../../src/app/features/tasks/task.model';
import { addTaskRepeatCfgToTask } from '../../../../src/app/features/task-repeat-cfg/store/task-repeat-cfg.actions';
import {
  DEFAULT_TASK_REPEAT_CFG,
  type TaskRepeatCfgCopy,
} from '../../../../src/app/features/task-repeat-cfg/task-repeat-cfg.model';
import { getDefaultSkipOverdue } from '../../../../src/app/features/task-repeat-cfg/dialog-edit-task-repeat-cfg/get-default-skip-overdue';
import { selectReminderConfig } from '../../../../src/app/features/config/store/global-config.reducer';
import { DEFAULT_GLOBAL_CONFIG } from '../../../../src/app/features/config/default-global-config.const';
import { clockStringFromDate } from '../../../../src/app/ui/duration/clock-string-from-date';
import { getDbDateStr } from '../../../../src/app/util/get-db-date-str';
import { unique } from '../../../../src/app/util/unique';
import type { ActionInput, ActionName } from '../../src/action-inputs';
import type { RootState } from '../root-reducer';

export interface BuildContext {
  /** The board as the app's selectors read it, with props as the app's services pass them. */
  select<T, P = undefined>(selector: (state: never, props: P) => T, props?: P): T;
}

export interface BuiltActions {
  actions: Action[];
  /** Ids the reply names, such as a new entity's. */
  refs: Record<string, string>;
}

type Builder<N extends ActionName> = (
  ctx: BuildContext,
  input: ActionInput<N>,
) => BuiltActions;

export class ActionInputError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 404 | 409,
  ) {
    super(message);
  }
}

const existingTask = (ctx: BuildContext, id: string): Task => {
  const task = ctx.select(selectTaskById as never, { id }) as Task | undefined;
  if (!task) throw new ActionInputError(`Task not found: ${id}`, 404);
  return task;
};

const BUILDERS: { [N in ActionName]: Builder<N> } = {
  // As TaskService.removeMultipleTasks: the subtasks' bodies ride along for the reducers, the upload strips them.
  deleteTasks: (ctx, { taskIds }) => {
    taskIds.forEach((id) => existingTask(ctx, id));
    const entities = ctx.select(selectTaskEntities as never) as Record<string, Task>;
    const affected = unique(
      taskIds.flatMap((id) => [id, ...(entities[id]?.subTaskIds ?? [])]),
    );
    const tasks = affected.map((id) => entities[id]).filter((t): t is Task => !!t);
    return { actions: [TaskSharedActions.deleteTasks({ taskIds, tasks })], refs: {} };
  },

  // As TaskService.remove, which the task's delete button calls with its subtasks.
  deleteTask: (ctx, { taskId }) => {
    existingTask(ctx, taskId);
    const task = ctx.select(selectTaskByIdWithSubTaskData as never, {
      id: taskId,
    }) as TaskWithSubTasks;
    return { actions: [TaskSharedActions.deleteTask({ task })], refs: {} };
  },

  // As TaskService.update.
  updateTask: (ctx, { taskId, changes }) => {
    existingTask(ctx, taskId);
    return {
      actions: [TaskSharedActions.updateTask({ task: { id: taskId, changes } })],
      refs: {},
    };
  },

  // As the repeat dialog opened on a task: its defaults for a new config, then TaskRepeatCfgService.addTaskRepeatCfgToTask.
  addTaskRepeatCfgToTask: (ctx, { taskId, ...fields }) => {
    const task = existingTask(ctx, taskId);
    if (task.repeatCfgId) {
      throw new ActionInputError(
        'That task already repeats. Update its config instead.',
        409,
      );
    }
    const startTime =
      fields.startTime ??
      (task.dueWithTime ? clockStringFromDate(task.dueWithTime) : undefined);
    const reminder = ctx.select(selectReminderConfig as never) as
      | { defaultTaskRemindOption?: TaskRepeatCfgCopy['remindAt'] }
      | undefined;
    const seeded: Omit<TaskRepeatCfgCopy, 'id'> = {
      ...DEFAULT_TASK_REPEAT_CFG,
      // The API sets the schedule field by field, as the dialog's custom setting does.
      quickSetting: 'CUSTOM',
      startDate: task.dueDay ?? getDbDateStr(task.dueWithTime || undefined),
      remindAt: startTime
        ? (reminder?.defaultTaskRemindOption ??
          DEFAULT_GLOBAL_CONFIG.reminder.defaultTaskRemindOption)
        : undefined,
      shouldInheritSubtasks: task.subTaskIds.length > 0,
      title: task.title,
      notes: task.notes || undefined,
      tagIds: unique(task.tagIds),
      defaultEstimate: task.timeEstimate,
      ...fields,
      startTime,
    };
    const cfg = { ...seeded, skipOverdue: getDefaultSkipOverdue(seeded) };
    const id = nanoid();
    return {
      actions: [
        addTaskRepeatCfgToTask({
          taskRepeatCfg: { ...cfg, projectId: task.projectId || null, id },
          taskId,
          startTime: cfg.startTime,
          remindAt: cfg.remindAt,
        }),
      ],
      refs: { taskRepeatCfgId: id },
    };
  },
};

export const buildAction = <N extends ActionName>(
  name: N,
  state: RootState,
  input: ActionInput<N>,
): BuiltActions =>
  (BUILDERS[name] as Builder<N>)(
    {
      select: (selector, props) =>
        (selector as (s: RootState, p: unknown) => never)(state, props),
    },
    input,
  );

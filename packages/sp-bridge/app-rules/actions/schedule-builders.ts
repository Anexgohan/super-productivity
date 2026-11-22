/**
 * Scheduling, deadlines and planning (anex/app-actions), each built as the app's schedule and deadline dialogs build it.
 */
import { TaskSharedActions } from '../../../../src/app/root-store/meta/task-shared.actions';
import { PlannerActions } from '../../../../src/app/features/planner/store/planner.actions';
import {
  TaskReminderOptionId,
  type Task,
} from '../../../../src/app/features/tasks/task.model';
import {
  millisecondsDiffToRemindOption,
  remindOptionToMilliseconds,
} from '../../../../src/app/features/tasks/util/remind-option-to-milliseconds';
import { getDeadlineAutoPlanFields } from '../../../../src/app/features/tasks/util/get-deadline-auto-plan-fields';
import { selectReminderConfig } from '../../../../src/app/features/config/store/global-config.reducer';
import { DEFAULT_GLOBAL_CONFIG } from '../../../../src/app/features/config/default-global-config.const';
import { built, existingTask, type BuildContext, type Builder } from './build-context';

type ScheduleAction =
  | 'scheduleTaskWithTime'
  | 'unscheduleTask'
  | 'setDeadline'
  | 'removeDeadline'
  | 'planTaskForDay'
  | 'planTasksForToday'
  | 'removeTasksFromTodayTag';

const defaultRemind = (ctx: BuildContext): TaskReminderOptionId =>
  ((
    ctx.select(selectReminderConfig as never) as
      | { defaultTaskRemindOption?: TaskReminderOptionId }
      | undefined
  )?.defaultTaskRemindOption ??
    DEFAULT_GLOBAL_CONFIG.reminder.defaultTaskRemindOption) as TaskReminderOptionId;

/** The dialogs' reminder when the caller names none: a timed task keeps its reminder's offset, anything else takes the board's default. */
const remindFor = (
  ctx: BuildContext,
  time: number | null | undefined,
  remindAt: number | null | undefined,
): TaskReminderOptionId =>
  time ? millisecondsDiffToRemindOption(time, remindAt ?? undefined) : defaultRemind(ctx);

export const SCHEDULE_BUILDERS: { [N in ScheduleAction]: Builder<N> } = {
  // As the schedule dialog with a time, through TaskService.scheduleTask; a reschedule is the same action.
  scheduleTaskWithTime: (ctx, { taskId, at, remind, isMoveToBacklog }) => {
    const task: Task = existingTask(ctx, taskId);
    const dueWithTime = Date.parse(at);
    const option =
      (remind as TaskReminderOptionId | undefined) ??
      remindFor(ctx, task.dueWithTime, task.remindAt);
    return built(
      TaskSharedActions.scheduleTaskWithTime({
        task,
        dueWithTime,
        remindAt: remindOptionToMilliseconds(dueWithTime, option),
        isMoveToBacklog: isMoveToBacklog ?? false,
      }),
    );
  },

  // As the schedule dialog's remove.
  unscheduleTask: (ctx, { taskId }) => {
    existingTask(ctx, taskId);
    return built(TaskSharedActions.unscheduleTask({ id: taskId }));
  },

  // As the deadline dialog's submit: a deadline due today carries the day it plans the task for, so every device plans it the same.
  setDeadline: (ctx, input) => {
    const task = existingTask(ctx, input.taskId);
    if ('day' in input) {
      return built(
        TaskSharedActions.setDeadline({
          taskId: task.id,
          deadlineDay: input.day,
          ...getDeadlineAutoPlanFields(ctx.dateService, input.day),
        }),
      );
    }
    const deadlineWithTime = Date.parse(input.at);
    const option =
      (input.remind as TaskReminderOptionId | undefined) ??
      remindFor(
        ctx,
        task.deadlineRemindAt ? task.deadlineWithTime : null,
        task.deadlineRemindAt,
      );
    return built(
      TaskSharedActions.setDeadline({
        taskId: task.id,
        deadlineWithTime,
        deadlineRemindAt:
          option !== TaskReminderOptionId.DoNotRemind
            ? remindOptionToMilliseconds(deadlineWithTime, option)
            : undefined,
        ...getDeadlineAutoPlanFields(ctx.dateService, undefined, deadlineWithTime),
      }),
    );
  },

  // As the deadline dialog's remove.
  removeDeadline: (ctx, { taskId }) => {
    existingTask(ctx, taskId);
    return built(TaskSharedActions.removeDeadline({ taskId }));
  },

  // As the schedule dialog with a day and no time, which changes nothing for a task already planned for that day.
  planTaskForDay: (ctx, { taskId, day }) => {
    const task = existingTask(ctx, taskId);
    if (task.dueDay === day && !task.dueWithTime) return built();
    return built(PlannerActions.planTaskForDay({ task, day }));
  },

  // As TaskService's add to today, for each task given.
  planTasksForToday: (ctx, { taskIds }) => {
    const tasks = taskIds.map((id) => existingTask(ctx, id));
    return built(
      TaskSharedActions.planTasksForToday({
        taskIds,
        today: ctx.dateService.todayStr(),
        startOfNextDayDiffMs: ctx.dateService.getStartOfNextDayDiffMs(),
        parentTaskMap: Object.fromEntries(tasks.map((t) => [t.id, t.parentId])),
      }),
    );
  },

  // As the work context menu's remove from today.
  removeTasksFromTodayTag: (ctx, { taskIds }) => {
    taskIds.forEach((id) => existingTask(ctx, id));
    return built(TaskSharedActions.removeTasksFromTodayTag({ taskIds }));
  },
};

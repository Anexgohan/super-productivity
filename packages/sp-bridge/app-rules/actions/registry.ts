/**
 * The app actions the API offers, each built the way the app's own service builds it (anex/app-actions).
 *
 * A builder reads the board through the app's selectors and returns the app's action creators' actions, nothing hand-made.
 * What follows from them (completing a parent, scheduling a recurring task) is the app's effects' work, not a builder's.
 */
import { nanoid } from 'nanoid';
import { TaskSharedActions } from '../../../../src/app/root-store/meta/task-shared.actions';
import {
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
import { updateGlobalConfigSection } from '../../../../src/app/features/config/store/global-config.actions';
import type {
  GlobalConfigSectionKey,
  GlobalSectionConfig,
} from '../../../../src/app/features/config/global-config.model';
import {
  archiveProject,
  unarchiveProject,
} from '../../../../src/app/features/project/store/project.actions';
import { selectProjectFeatureState } from '../../../../src/app/features/project/store/project.selectors';
import { INBOX_PROJECT } from '../../../../src/app/features/project/project.const';
import type { ProjectState } from '../../../../src/app/features/project/project.model';
import { clockStringFromDate } from '../../../../src/app/ui/duration/clock-string-from-date';
import { getDbDateStr } from '../../../../src/app/util/get-db-date-str';
import { unique } from '../../../../src/app/util/unique';
import type { ActionInput, ActionName } from '../../src/action-inputs';
import {
  ActionInputError,
  built,
  existingTask,
  type BuildContext,
  type BuiltActions,
  type Builder,
} from './build-context';
import { SCHEDULE_BUILDERS } from './schedule-builders';
import { TASK_BUILDERS } from './task-builders';
import { SECTION_BUILDERS } from './section-builders';

const hasOwn = (o: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(o, key);

const existingProjectId = (ctx: BuildContext, id: string): string => {
  if (id === INBOX_PROJECT.id) {
    throw new ActionInputError('The Inbox project is never archived.', 400);
  }
  const projects = ctx.select(selectProjectFeatureState as never) as ProjectState;
  if (!projects.entities[id]) throw new ActionInputError(`Project not found: ${id}`, 404);
  return id;
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

  // As GlobalConfigService.updateSection from the settings page: only the fields given, which the reducer merges into the section.
  updateGlobalConfigSection: (_ctx, { sectionKey, changes }) => {
    if (sectionKey === 'sync') {
      throw new ActionInputError(
        'The sync settings are set in a browser, never through the API.',
        400,
      );
    }
    const defaults = hasOwn(DEFAULT_GLOBAL_CONFIG, sectionKey)
      ? (DEFAULT_GLOBAL_CONFIG as Record<string, unknown>)[sectionKey]
      : undefined;
    if (typeof defaults !== 'object' || defaults === null) {
      throw new ActionInputError(`No such settings section: ${sectionKey}`, 400);
    }
    // Only keys with a default are settings, which leaves out a browser's own screen preferences in misc.uiPrefs.
    const unknownKeys = Object.keys(changes).filter((key) => !hasOwn(defaults, key));
    if (unknownKeys.length > 0) {
      throw new ActionInputError(
        `Not a setting of ${sectionKey}: ${unknownKeys.join(', ')}`,
        400,
      );
    }
    return built(
      updateGlobalConfigSection({
        sectionKey: sectionKey as GlobalConfigSectionKey,
        sectionCfg: changes as Partial<GlobalSectionConfig>,
      }),
    );
  },

  // The bare action: no browser dispatches it, since the UI's way to shelve a project is to complete it.
  archiveProject: (ctx, { projectId }) =>
    built(archiveProject({ id: existingProjectId(ctx, projectId) })),

  // As ProjectService.unarchive, which also reopens a completed project.
  unarchiveProject: (ctx, { projectId }) =>
    built(unarchiveProject({ id: existingProjectId(ctx, projectId) })),

  ...SCHEDULE_BUILDERS,
  ...TASK_BUILDERS,
  ...SECTION_BUILDERS,
};

export const buildAction = <N extends ActionName>(
  name: N,
  ctx: BuildContext,
  input: ActionInput<N>,
): Promise<BuiltActions> => Promise.resolve((BUILDERS[name] as Builder<N>)(ctx, input));

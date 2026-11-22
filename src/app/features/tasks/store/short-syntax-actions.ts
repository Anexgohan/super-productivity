import { Action } from '@ngrx/store';
import { TaskSharedActions } from '../../../root-store/meta/task-shared.actions';
import type { DateService } from '../../../core/date/date.service';
import { unique } from '../../../util/unique';
import { getDbDateStr } from '../../../util/get-db-date-str';
import type { Tag } from '../../tag/tag.model';
import type { shortSyntax } from '../short-syntax';
import { Task, TaskReminderOptionId } from '../task.model';
import { remindOptionToMilliseconds } from '../util/remind-option-to-milliseconds';
import { getDeadlineAutoPlanFields } from '../util/get-deadline-auto-plan-fields';
import { addNewTagsFromShortSyntax } from './task.actions';

/** What the parser found in a task's title. */
export type ShortSyntaxParse = NonNullable<Awaited<ReturnType<typeof shortSyntax>>>;

export interface ShortSyntaxActionsInput {
  task: Task;
  parse: ShortSyntaxParse | undefined;
  /** The parse follows the task's add, not a title edit. */
  isAddTask: boolean;
  /** The configured default project, or null when there is none to use. */
  defaultProjectId: string | null;
  defaultTaskRemindOption: TaskReminderOptionId;
  dateService: Pick<DateService, 'todayStr' | 'getStartOfNextDayDiffMs'>;
}

export interface ShortSyntaxActions {
  actions: Action[];
  /** A parsed project was not applied because the task repeats. */
  isProjectRefusedForRepeat: boolean;
  /** The changes replace a day's time spent, so a pending timer batch must be saved before they apply. */
  isTimeSpentReplaced: boolean;
}

/** The actions a parsed title turns into, shared by ShortSyntaxEffects and the API's action builder. */
export const shortSyntaxActions = ({
  task,
  parse: r,
  isAddTask,
  defaultProjectId,
  defaultTaskRemindOption,
  dateService,
}: ShortSyntaxActionsInput): ShortSyntaxActions => {
  const isAddDefaultProjectIfNecessary: boolean =
    !!defaultProjectId &&
    !task.projectId &&
    !task.parentId &&
    task.projectId !== defaultProjectId &&
    isAddTask;

  if (!r) {
    return {
      actions: isAddDefaultProjectIfNecessary
        ? [
            TaskSharedActions.moveToOtherProject({
              task: { ...task, subTasks: [] },
              targetProjectId: defaultProjectId as string,
            }),
          ]
        : [],
      isProjectRefusedForRepeat: false,
      isTimeSpentReplaced: false,
    };
  }

  const actions: Action[] = [];
  const { taskChanges, attachments } = r;

  // Build scheduling info from parsed short syntax
  let schedulingInfo:
    | {
        day?: string;
        isAddToTop?: boolean;
        dueWithTime?: number;
        remindAt?: number | null;
        isMoveToBacklog?: boolean;
      }
    | undefined;

  if (taskChanges.dueWithTime && !taskChanges.remindAt) {
    const { dueWithTime } = taskChanges;
    if (taskChanges.hasPlannedTime === false) {
      // Plan for day only (no specific time)
      const plannedDay = new Date(dueWithTime);
      schedulingInfo = {
        day: getDbDateStr(plannedDay),
        isAddToTop: false,
      };
    } else {
      // Schedule with specific time
      schedulingInfo = {
        dueWithTime,
        remindAt: remindOptionToMilliseconds(dueWithTime, defaultTaskRemindOption),
        isMoveToBacklog: false,
      };
    }
  }

  // Determine target project
  let targetProjectId: string | undefined;
  let isProjectRefusedForRepeat = false;
  if (r.projectId && r.projectId !== task.projectId && !task.parentId) {
    if (task.repeatCfgId) {
      isProjectRefusedForRepeat = true;
    } else {
      targetProjectId = r.projectId;
    }
  } else if (isAddDefaultProjectIfNecessary) {
    targetProjectId = defaultProjectId as string;
  }

  // Build task changes including tagIds update
  const tagIds: string[] = [...(r.taskChanges.tagIds || task.tagIds)];
  const isEqualTags =
    tagIds.length === task.tagIds.length &&
    tagIds.every((id, i) => id === task.tagIds[i]);
  const finalTaskChanges = { ...taskChanges };
  if (tagIds && tagIds.length && !isEqualTags) {
    finalTaskChanges.tagIds = unique(tagIds);
  }

  // Add parsed URL attachments to task (merge with existing)
  if (attachments.length > 0) {
    finalTaskChanges.attachments = [...(task.attachments || []), ...attachments];
  }

  // Use compound action for atomic state update
  const autoPlanFields = getDeadlineAutoPlanFields(
    dateService,
    finalTaskChanges.deadlineDay,
    finalTaskChanges.deadlineWithTime,
  );

  delete finalTaskChanges.hasDeadlineTime;

  actions.push(
    TaskSharedActions.applyShortSyntax({
      task,
      taskChanges: finalTaskChanges,
      targetProjectId,
      schedulingInfo,
      ...autoPlanFields,
    }),
  );

  // New tag creation requires user confirmation, so remains separate
  if (r.newTagTitles.length) {
    actions.push(
      addNewTagsFromShortSyntax({ taskId: task.id, newTitles: r.newTagTitles }),
    );
  }

  return {
    actions,
    isProjectRefusedForRepeat,
    isTimeSpentReplaced: !!finalTaskChanges.timeSpentOnDay,
  };
};

/** The actions that create the confirmed new tags and add them to the task. */
export const newTagsActions = (
  task: Pick<Task, 'id' | 'tagIds'>,
  uniqueNewTitles: string[],
  getAddTagActionAndId: (tag: Partial<Tag>) => { action: Action; id: string },
): Action[] => {
  const actions: Action[] = [];
  const newTagIds = [...task.tagIds];
  uniqueNewTitles.forEach((newTagTitle) => {
    const { action, id } = getAddTagActionAndId({
      title: newTagTitle,
    });
    actions.push(action);
    newTagIds.push(id);
  });
  actions.push(
    TaskSharedActions.updateTask({
      task: {
        id: task.id,
        changes: {
          tagIds: unique(newTagIds),
        },
      },
    }),
  );
  return actions;
};

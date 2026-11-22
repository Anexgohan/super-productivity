/**
 * A new task from one line of short syntax (anex/app-actions), through the app's own parser and its own mapping to actions.
 *
 * In a browser, TaskService.add adds the task with its raw title and ShortSyntaxEffects then parses it into applyShortSyntax.
 * The builder runs the same parser and the same shared mapping, so it builds the same actions in the same order.
 * The new-tag step is the effect's confirm dialog answered yes.
 */
import { nanoid } from 'nanoid';
import type { Action } from '@ngrx/store';
import { createTagObject } from '@sp/shared-schema';
import { TaskSharedActions } from '../../../../src/app/root-store/meta/task-shared.actions';
import { shortSyntax } from '../../../../src/app/features/tasks/short-syntax';
import {
  newTagsActions,
  shortSyntaxActions,
} from '../../../../src/app/features/tasks/store/short-syntax-actions';
import { addNewTagsFromShortSyntax } from '../../../../src/app/features/tasks/store/task.actions';
import { DEFAULT_TASK, type Task } from '../../../../src/app/features/tasks/task.model';
import { getDeadlineAutoPlanFields } from '../../../../src/app/features/tasks/util/get-deadline-auto-plan-fields';
import {
  selectReminderConfig,
  selectShortSyntaxConfig,
  selectTasksConfig,
} from '../../../../src/app/features/config/store/global-config.reducer';
import { DEFAULT_GLOBAL_CONFIG } from '../../../../src/app/features/config/default-global-config.const';
import type {
  ReminderConfig,
  ShortSyntaxConfig,
  TasksConfig,
} from '../../../../src/app/features/config/global-config.model';
import { selectAllTagsWithoutMyDay } from '../../../../src/app/features/tag/store/tag.reducer';
import { addTag } from '../../../../src/app/features/tag/store/tag.actions';
import { DEFAULT_TAG } from '../../../../src/app/features/tag/tag.const';
import type { Tag } from '../../../../src/app/features/tag/tag.model';
import {
  selectProjectFeatureState,
  selectUnarchivedProjects,
} from '../../../../src/app/features/project/store/project.selectors';
import type {
  Project,
  ProjectState,
} from '../../../../src/app/features/project/project.model';
import { INBOX_PROJECT } from '../../../../src/app/features/project/project.const';
import { WorkContextType } from '../../../../src/app/features/work-context/work-context.model';
import { ActionInputError, type BuildContext, type Builder } from './build-context';

/** The project given, else the one a browser's add bar gives outside a project: the default project when it exists, else the Inbox. */
const projectFor = (ctx: BuildContext, projectId: string | undefined): string => {
  const projects = ctx.select(selectProjectFeatureState as never) as ProjectState;
  if (projectId) {
    if (!projects.entities[projectId]) {
      throw new ActionInputError(`Project not found: ${projectId}`, 404);
    }
    return projectId;
  }
  const tasksCfg = ctx.select(selectTasksConfig as never) as TasksConfig | undefined;
  const fallback = tasksCfg?.defaultProjectId;
  return fallback && projects.entities[fallback] ? fallback : INBOX_PROJECT.id;
};

/** As TagService.getAddTagActionAndId. */
const addTagActionAndId = (tag: Partial<Tag>): { action: Action; id: string } => {
  const newTag = {
    ...createTagObject(tag, nanoid),
    advancedCfg: tag.advancedCfg ?? DEFAULT_TAG.advancedCfg,
  } as Tag;
  return { id: newTag.id, action: addTag({ tag: newTag }) };
};

export const SHORT_SYNTAX_BUILDERS: { addTaskFromText: Builder<'addTaskFromText'> } = {
  addTaskFromText: async (ctx, { text, projectId }) => {
    // As TaskService.add in a project's context.
    const workContextId = projectFor(ctx, projectId);
    const task: Task = {
      ...DEFAULT_TASK,
      created: Date.now(),
      title: text,
      id: nanoid(),
      projectId: workContextId,
      tagIds: [],
    };
    const actions: Action[] = [
      TaskSharedActions.addTask({
        task,
        workContextId,
        workContextType: WorkContextType.PROJECT,
        isAddToBacklog: false,
        isAddToBottom: false,
        ...getDeadlineAutoPlanFields(
          ctx.dateService,
          task.deadlineDay,
          task.deadlineWithTime,
        ),
      }),
    ];

    // As ShortSyntaxEffects.shortSyntax$ for an added task.
    const parse = await shortSyntax(
      task,
      (ctx.select(selectShortSyntaxConfig as never) as ShortSyntaxConfig | undefined) ??
        DEFAULT_GLOBAL_CONFIG.shortSyntax,
      ctx.select(selectAllTagsWithoutMyDay as never) as Tag[],
      ctx.select(selectUnarchivedProjects as never) as Project[],
      undefined,
      'combine',
    );
    const reminder = ctx.select(selectReminderConfig as never) as
      | ReminderConfig
      | undefined;
    const mapped = shortSyntaxActions({
      task,
      parse,
      isAddTask: true,
      // The task has its project already, so the effect's default-project move never applies.
      defaultProjectId: null,
      defaultTaskRemindOption:
        reminder?.defaultTaskRemindOption ??
        DEFAULT_GLOBAL_CONFIG.reminder.defaultTaskRemindOption!,
      dateService: ctx.dateService,
    });

    // As ShortSyntaxEffects.shortSyntaxAddNewTags$ once its dialog is confirmed, on the tags applyShortSyntax leaves.
    let tagIds = task.tagIds;
    for (const action of mapped.actions) {
      if (action.type === TaskSharedActions.applyShortSyntax.type) {
        const applied = action as ReturnType<typeof TaskSharedActions.applyShortSyntax>;
        tagIds = applied.taskChanges.tagIds ?? tagIds;
        actions.push(action);
      } else if (action.type === addNewTagsFromShortSyntax.type) {
        const { newTitles } = action as ReturnType<typeof addNewTagsFromShortSyntax>;
        actions.push(
          ...newTagsActions(
            { id: task.id, tagIds },
            [...new Set(newTitles)],
            addTagActionAndId,
          ),
        );
      } else {
        actions.push(action);
      }
    }
    return { actions, refs: { taskId: task.id } };
  },
};

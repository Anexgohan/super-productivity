/**
 * A project's state (anex/app-actions), built as the project's menu and ProjectService build it.
 */
import { TaskSharedActions } from '../../../../src/app/root-store/meta/task-shared.actions';
import {
  completeProject,
  reopenProject,
  toggleHideFromMenu,
  updateProject,
} from '../../../../src/app/features/project/store/project.actions';
import {
  selectTaskByIdWithSubTaskData,
  selectTaskEntities,
} from '../../../../src/app/features/tasks/store/task.selectors';
import type {
  Task,
  TaskWithSubTasks,
} from '../../../../src/app/features/tasks/task.model';
import { INBOX_PROJECT } from '../../../../src/app/features/project/project.const';
import type { Action } from '@ngrx/store';
import {
  ActionInputError,
  built,
  type BuildContext,
  type Builder,
} from './build-context';
import { existingProject } from './move-builders';

type ProjectAction =
  | 'completeProject'
  | 'reopenProject'
  | 'setProjectHidden'
  | 'setProjectBacklog';

const setDone = (taskId: string, isDone: boolean): Action =>
  TaskSharedActions.updateTask({ task: { id: taskId, changes: { isDone } } });

/** As ProjectService.getCompletionInfo: the project's live top-level tasks, and those of them and their subtasks still undone. */
const unfinishedOf = (
  ctx: BuildContext,
  topLevelIds: string[],
): { unfinished: Task[]; topLevelWithUnfinished: Task[] } => {
  const entities = ctx.select(selectTaskEntities as never) as Record<
    string,
    Task | undefined
  >;
  const topLevel = topLevelIds.map((id) => entities[id]).filter((t): t is Task => !!t);
  const withSubTasks = (task: Task): Task[] => [
    task,
    ...task.subTaskIds.map((id) => entities[id]).filter((t): t is Task => !!t),
  ];
  return {
    unfinished: topLevel.flatMap(withSubTasks).filter((t) => !t.isDone),
    topLevelWithUnfinished: topLevel.filter((t) =>
      withSubTasks(t).some((s) => !s.isDone),
    ),
  };
};

export const PROJECT_BUILDERS: { [N in ProjectAction]: Builder<N> } = {
  // As the project menu's complete: unfinished tasks are settled first, then the project is done as of the logical today.
  completeProject: (ctx, { projectId, unfinished }) => {
    if (projectId === INBOX_PROJECT.id) {
      throw new ActionInputError('The Inbox project is never completed.', 400);
    }
    const project = existingProject(ctx, projectId);
    if (project.isDone) throw new ActionInputError('That project is done already.', 409);
    const open = unfinishedOf(ctx, [...project.taskIds, ...project.backlogTaskIds]);
    const actions: Action[] = [];
    if (open.unfinished.length > 0) {
      if (!unfinished) {
        throw new ActionInputError(
          `The project has ${open.unfinished.length} unfinished tasks: give unfinished as moveToInbox or markDone.`,
          409,
        );
      }
      if (unfinished === 'moveToInbox') {
        // As ProjectService.moveTasksToInbox: each task with unfinished work moves, and a done one is reopened there.
        for (const task of open.topLevelWithUnfinished) {
          const withSubTasks = ctx.select(selectTaskByIdWithSubTaskData as never, {
            id: task.id,
          }) as TaskWithSubTasks;
          actions.push(
            TaskSharedActions.moveToOtherProject({
              task: withSubTasks,
              targetProjectId: INBOX_PROJECT.id,
            }),
          );
          if (task.isDone) actions.push(setDone(task.id, false));
        }
      } else {
        actions.push(...open.unfinished.map((task) => setDone(task.id, true)));
      }
    }
    actions.push(
      completeProject({
        id: projectId,
        doneOn: ctx.dateService.getLogicalTodayDate().getTime(),
      }),
    );
    return { actions, refs: {} };
  },

  // As ProjectService.reopen: the tasks settled at completion stay as they are.
  reopenProject: (ctx, { projectId }) => {
    if (!existingProject(ctx, projectId).isDone) {
      throw new ActionInputError('That project is not done.', 409);
    }
    return built(reopenProject({ id: projectId }));
  },

  // The app only toggles, so the toggle goes out only when it changes the project.
  setProjectHidden: (ctx, { projectId, hidden }) =>
    !!existingProject(ctx, projectId).isHiddenFromMenu === hidden
      ? built()
      : built(toggleHideFromMenu({ id: projectId })),

  // As the project settings' backlog switch; turning it off moves the backlog into the regular list through the app's ProjectEffects.
  setProjectBacklog: (ctx, { projectId, enabled }) =>
    !!existingProject(ctx, projectId).isEnableBacklog === enabled
      ? built()
      : built(
          updateProject({
            project: { id: projectId, changes: { isEnableBacklog: enabled } },
          }),
        ),
};

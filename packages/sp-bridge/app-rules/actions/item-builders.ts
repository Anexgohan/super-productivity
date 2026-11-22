/**
 * Attachments, repeat days and notes (anex/app-actions), built as the attachment dialog, the repeat dialog and the notes panel build them.
 */
import {
  deleteTaskAttachment,
  updateTaskAttachment,
} from '../../../../src/app/features/tasks/task-attachment/task-attachment.actions';
import { deleteTaskRepeatCfgInstance } from '../../../../src/app/features/task-repeat-cfg/store/task-repeat-cfg.actions';
import { selectTaskRepeatCfgFeatureState } from '../../../../src/app/features/task-repeat-cfg/store/task-repeat-cfg.selectors';
import type { TaskRepeatCfgState } from '../../../../src/app/features/task-repeat-cfg/task-repeat-cfg.model';
import {
  moveNoteToOtherProject,
  updateNoteOrder,
} from '../../../../src/app/features/note/store/note.actions';
import { selectNoteFeatureState } from '../../../../src/app/features/note/store/note.reducer';
import type { NoteState } from '../../../../src/app/features/note/note.model';
import { WorkContextType } from '../../../../src/app/features/work-context/work-context.model';
import { TODAY_TAG } from '../../../../src/app/features/tag/tag.const';
import {
  ActionInputError,
  built,
  existingTask,
  isPermutation,
  type BuildContext,
  type Builder,
} from './build-context';
import { existingProject } from './move-builders';

type ItemAction =
  | 'updateAttachment'
  | 'deleteAttachment'
  | 'skipRepeatInstance'
  | 'updateNoteOrder'
  | 'moveNote';

const checkAttachment = (
  ctx: BuildContext,
  taskId: string,
  attachmentId: string,
): void => {
  if (!existingTask(ctx, taskId).attachments.some((a) => a.id === attachmentId)) {
    throw new ActionInputError(`Attachment not found: ${attachmentId}`, 404);
  }
};

const notesOf = (ctx: BuildContext): NoteState =>
  ctx.select(selectNoteFeatureState as never) as NoteState;

export const ITEM_BUILDERS: { [N in ItemAction]: Builder<N> } = {
  // As the attachment's edit dialog; its type and icon stay as they are.
  updateAttachment: (ctx, { taskId, attachmentId, changes }) => {
    checkAttachment(ctx, taskId, attachmentId);
    return built(
      updateTaskAttachment({ taskId, taskAttachment: { id: attachmentId, changes } }),
    );
  },

  deleteAttachment: (ctx, { taskId, attachmentId }) => {
    checkAttachment(ctx, taskId, attachmentId);
    return built(deleteTaskAttachment({ taskId, id: attachmentId }));
  },

  // As the repeat dialog's skip, which it offers only for a day after today.
  skipRepeatInstance: (ctx, { repeatCfgId, day }) => {
    const cfgs = ctx.select(
      selectTaskRepeatCfgFeatureState as never,
    ) as TaskRepeatCfgState;
    const cfg = cfgs.entities[repeatCfgId];
    if (!cfg) throw new ActionInputError(`Repeat config not found: ${repeatCfgId}`, 404);
    if (day <= ctx.dateService.todayStr()) {
      throw new ActionInputError('Only a day after today can be skipped.', 409);
    }
    if (cfg.deletedInstanceDates?.includes(day)) {
      throw new ActionInputError('That day is skipped already.', 409);
    }
    return built(deleteTaskRepeatCfgInstance({ repeatCfgId, dateStr: day }));
  },

  // As the notes panel's drag: every note of the project or of Today, so a stale caller can't drop one.
  updateNoteOrder: (ctx, input) => {
    const isProject = 'projectId' in input;
    const current = isProject
      ? existingProject(ctx, input.projectId).noteIds
      : notesOf(ctx).todayOrder;
    if (!isPermutation(current, input.noteIds)) {
      throw new ActionInputError(
        'noteIds must list every note of that project or of Today once.',
        409,
      );
    }
    return built(
      updateNoteOrder({
        ids: input.noteIds,
        activeContextType: isProject ? WorkContextType.PROJECT : WorkContextType.TAG,
        activeContextId: isProject ? input.projectId : TODAY_TAG.id,
      }),
    );
  },

  // As the note's move to another project, which takes it out of the old project's notes too.
  moveNote: (ctx, { noteId, projectId }) => {
    const note = notesOf(ctx).entities[noteId];
    if (!note) throw new ActionInputError(`Note not found: ${noteId}`, 404);
    existingProject(ctx, projectId);
    if (note.projectId === projectId) {
      throw new ActionInputError('The note is in that project already.', 409);
    }
    return built(moveNoteToOtherProject({ note, targetProjectId: projectId }));
  },
};

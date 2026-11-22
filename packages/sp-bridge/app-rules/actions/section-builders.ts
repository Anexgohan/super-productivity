/**
 * Sections (anex/app-actions), each built as SectionService and the task list's drag and drop build it.
 *
 * Sections have no step in the app's validation, so a builder checks what a drop in the work view guarantees: the section and task
 * exist, the task is a top-level task of the section's project or of Today, and the anchor is in the list the task lands in.
 */
import { nanoid } from 'nanoid';
import {
  addSection,
  addTaskToSection,
  deleteSection,
  removeTaskFromSection,
  updateSection,
} from '../../../../src/app/features/section/store/section.actions';
import {
  selectAllSections,
  selectSectionFeatureState,
} from '../../../../src/app/features/section/store/section.selectors';
import type {
  Section,
  SectionState,
} from '../../../../src/app/features/section/section.model';
import { sanitizeSectionTitle } from '../../../../src/app/features/section/section.util';
import { WorkContextType } from '../../../../src/app/features/work-context/work-context.model';
import { selectTodayTaskIds } from '../../../../src/app/features/work-context/store/work-context.selectors';
import { selectProjectFeatureState } from '../../../../src/app/features/project/store/project.selectors';
import type { ProjectState } from '../../../../src/app/features/project/project.model';
import { TODAY_TAG } from '../../../../src/app/features/tag/tag.const';
import {
  ActionInputError,
  built,
  existingTask,
  type BuildContext,
  type Builder,
} from './build-context';

type SectionAction =
  | 'addSection'
  | 'updateSection'
  | 'deleteSection'
  | 'addTaskToSection'
  | 'removeTaskFromSection';

const projectsOf = (ctx: BuildContext): ProjectState =>
  ctx.select(selectProjectFeatureState as never) as ProjectState;

const existingSection = (ctx: BuildContext, id: string): Section => {
  const sections = ctx.select(selectSectionFeatureState as never) as SectionState;
  const section = sections.entities[id];
  if (!section) throw new ActionInputError(`Section not found: ${id}`, 404);
  return section;
};

/** The top-level tasks of a section's context, in order: the project's list without its backlog, or Today's. */
const contextTaskIds = (ctx: BuildContext, section: Section): string[] =>
  section.contextType === WorkContextType.PROJECT
    ? (projectsOf(ctx).entities[section.contextId]?.taskIds ?? [])
    : (ctx.select(selectTodayTaskIds as never) as string[]);

const sectionsOfContext = (ctx: BuildContext, section: Section): Section[] =>
  (ctx.select(selectAllSections as never) as Section[]).filter(
    (s) => s.contextId === section.contextId,
  );

/** The task, checked to be a top-level task listed in the section's context. */
const taskOfContext = (ctx: BuildContext, section: Section, taskId: string): void => {
  if (existingTask(ctx, taskId).parentId) {
    throw new ActionInputError(
      `Task ${taskId} is a subtask: it stays with its parent.`,
      409,
    );
  }
  if (!contextTaskIds(ctx, section).includes(taskId)) {
    throw new ActionInputError(
      `Task ${taskId} is not in the list of the section's project or of Today.`,
      409,
    );
  }
};

export const SECTION_BUILDERS: { [N in SectionAction]: Builder<N> } = {
  // As SectionService.addSection.
  addSection: (ctx, input) => {
    const isProject = 'projectId' in input;
    if (isProject && !projectsOf(ctx).entities[input.projectId]) {
      throw new ActionInputError(`Project not found: ${input.projectId}`, 404);
    }
    const id = nanoid();
    return {
      actions: [
        addSection({
          section: {
            id,
            contextId: isProject ? input.projectId : TODAY_TAG.id,
            contextType: isProject ? WorkContextType.PROJECT : WorkContextType.TAG,
            title: sanitizeSectionTitle(input.title),
            isExpanded: true,
            taskIds: [],
          },
        }),
      ],
      refs: { sectionId: id },
    };
  },

  // As SectionService.updateSection from the section's rename.
  updateSection: (ctx, { sectionId, title }) => {
    existingSection(ctx, sectionId);
    return built(updateSection({ section: { id: sectionId, changes: { title } } }));
  },

  // As SectionService.deleteSection: its tasks stay in their context, outside any section.
  deleteSection: (ctx, { sectionId }) => {
    existingSection(ctx, sectionId);
    return built(deleteSection({ id: sectionId }));
  },

  // As a drop into a section: the section the task leaves rides along, so every device takes it out of that one.
  addTaskToSection: (ctx, { sectionId, taskId, afterTaskId }) => {
    const section = existingSection(ctx, sectionId);
    taskOfContext(ctx, section, taskId);
    const others = section.taskIds.filter((id) => id !== taskId);
    const anchor = afterTaskId === undefined ? (others.at(-1) ?? null) : afterTaskId;
    if (anchor !== null && !others.includes(anchor)) {
      throw new ActionInputError(`Task ${anchor} is not in that section.`, 409);
    }
    const source =
      sectionsOfContext(ctx, section).find((s) => s.taskIds.includes(taskId))?.id ?? null;
    return built(
      addTaskToSection({
        sectionId,
        taskId,
        afterTaskId: anchor,
        sourceSectionId: source,
      }),
    );
  },

  // As a drop out of a section into the context's tasks outside sections.
  removeTaskFromSection: (ctx, { sectionId, taskId, afterTaskId }) => {
    const section = existingSection(ctx, sectionId);
    existingTask(ctx, taskId);
    if (!section.taskIds.includes(taskId)) {
      throw new ActionInputError(`Task ${taskId} is not in that section.`, 409);
    }
    const anchor = afterTaskId ?? null;
    if (anchor !== null) {
      const inSections = new Set(
        sectionsOfContext(ctx, section).flatMap((s) => s.taskIds),
      );
      if (!contextTaskIds(ctx, section).includes(anchor) || inSections.has(anchor)) {
        throw new ActionInputError(
          `Task ${anchor} is not among the tasks outside sections.`,
          409,
        );
      }
    }
    return built(
      removeTaskFromSection({
        sectionId,
        taskId,
        workContextId: section.contextId,
        workContextType: section.contextType,
        workContextAfterTaskId: anchor,
      }),
    );
  },
};

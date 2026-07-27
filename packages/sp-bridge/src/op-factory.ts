/**
 * Builds sync operations shaped EXACTLY like the ones a real v18.15.1 client
 * captures (verified field-for-field against live ops in the op-log - see the
 * addTask template at serverSeq 15 of the dev dataset):
 *
 *   envelope: uuidv7 op id, clientId, actionType, opType, entityType/Id,
 *             vectorClock, timestamp, schemaVersion, isPayloadEncrypted
 *   payload:  encrypt({ actionPayload: <exact NgRx action props>,
 *              entityChanges: [] })
 *
 * Write surface is intentionally narrow (mirrors the desktop REST API's
 * ALLOWED_TASK_FIELDS) - receiving clients replay these through their own
 * reducers, so unknown/malformed shapes are a data-corruption risk.
 */
import { randomBytes } from 'node:crypto';
import { encrypt } from '@sp/sync-core';
import type { SuperSyncOperation } from '@sp/shared-schema';
import {
  BoardPanelCfgScheduledState,
  BoardPanelCfgTaskDoneState,
  BoardPanelCfgTaskTypeFilter,
} from '@sp/shared-schema';

export const CURRENT_SCHEMA_VERSION = 4;

/** Same alphabet as nanoid (client task ids are 21-char nanoids). */
const NANOID_ALPHABET =
  'useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict';
export const nanoid = (size = 21): string => {
  const bytes = randomBytes(size);
  let id = '';
  for (let i = 0; i < size; i++) {
    id += NANOID_ALPHABET[bytes[i] & 63];
  }
  return id;
};

/** RFC 9562 UUIDv7 (time-ordered) - same format clients use for op ids. */
export const uuidv7 = (): string => {
  const now = Date.now();
  const bytes = randomBytes(16);
  bytes[0] = (now / 2 ** 40) & 0xff;
  bytes[1] = (now / 2 ** 32) & 0xff;
  bytes[2] = (now / 2 ** 24) & 0xff;
  bytes[3] = (now / 2 ** 16) & 0xff;
  bytes[4] = (now / 2 ** 8) & 0xff;
  bytes[5] = now & 0xff;
  bytes[6] = (bytes[6] & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** Fields writable via the API - mirror of desktop's ALLOWED_TASK_FIELDS. */
export const ALLOWED_TASK_FIELDS = new Set([
  'title',
  'notes',
  'isDone',
  'doneOn',
  'timeEstimate',
  'timeSpent',
  'projectId',
  'tagIds',
  'dueDay',
  'dueWithTime',
]);

export interface NewTaskInput {
  title: string;
  projectId?: string;
  notes?: string;
  timeEstimate?: number;
  tagIds?: string[];
  dueDay?: string;
  dueWithTime?: number;
  /** When set, the entity is built as a subtask (no own tags/subtasks). */
  parentId?: string;
}

/** Full task entity with the same default set a real client writes. */
export const buildTaskEntity = (input: NewTaskInput): Record<string, unknown> => ({
  id: nanoid(),
  subTaskIds: [],
  timeSpentOnDay: {},
  timeSpent: 0,
  timeEstimate: input.timeEstimate ?? 0,
  isDone: false,
  title: input.title,
  // Subtasks carry neither their own tags nor project membership (they inherit
  // the parent's), matching how the client builds a sub-task entity.
  tagIds: input.parentId ? [] : (input.tagIds ?? []),
  created: Date.now(),
  attachments: [],
  projectId: input.projectId ?? 'INBOX_PROJECT',
  notes: input.notes ?? '',
  ...(input.parentId ? { parentId: input.parentId } : {}),
  ...(input.dueDay ? { dueDay: input.dueDay } : {}),
  ...(input.dueWithTime ? { dueWithTime: input.dueWithTime } : {}),
});

// ── Tag / Project entity factories ───────────────────────────────────────────
// Templated field-for-field from real entities in the live dataset so every
// field and type validates under typia on receiving clients (a missing/wrong
// field would trip typia-as-corrupt and break sync).

const DEFAULT_ADVANCED_CFG = {
  worklogExportSettings: {
    cols: ['DATE', 'START', 'END', 'TIME_CLOCK', 'TITLES_INCLUDING_SUB'],
    roundWorkTimeTo: null,
    roundStartTimeTo: null,
    roundEndTimeTo: null,
    separateTasksBy: ' | ',
    groupBy: 'DATE',
  },
};

const buildTheme = (primary: string): Record<string, unknown> => ({
  isAutoContrast: true,
  isDisableBackgroundTint: false,
  primary,
  huePrimary: '500',
  accent: '#ff4081',
  hueAccent: '500',
  warn: '#e11826',
  hueWarn: '500',
  backgroundImageDark: null,
  backgroundImageLight: null,
  backgroundOverlayOpacity: 20,
  backgroundImageBlur: 0,
});

const DEFAULT_TAG_COLOR = '#7b1fa2';
const DEFAULT_PROJECT_COLOR = '#29b6f6';

export interface NewTagInput {
  title: string;
  icon?: string;
  color?: string;
}

export const buildTagEntity = (input: NewTagInput): Record<string, unknown> => ({
  id: nanoid(),
  title: input.title,
  created: Date.now(),
  color: input.color ?? null,
  icon: input.icon ?? null,
  taskIds: [],
  advancedCfg: DEFAULT_ADVANCED_CFG,
  theme: buildTheme(input.color ?? DEFAULT_TAG_COLOR),
});

export interface NewProjectInput {
  title: string;
  color?: string;
  isEnableBacklog?: boolean;
}

export const buildProjectEntity = (input: NewProjectInput): Record<string, unknown> => ({
  id: nanoid(),
  title: input.title,
  isHiddenFromMenu: false,
  isArchived: false,
  isDone: false,
  doneOn: null,
  isEnableBacklog: input.isEnableBacklog ?? false,
  taskIds: [],
  backlogTaskIds: [],
  noteIds: [],
  advancedCfg: DEFAULT_ADVANCED_CFG,
  theme: buildTheme(input.color ?? DEFAULT_PROJECT_COLOR),
});

export interface NewNoteInput {
  content: string;
  projectId?: string | null;
  isPinnedToToday?: boolean;
  backgroundColor?: string;
  imgUrl?: string;
}

/** Templated from Note in src/app/features/note/note.model.ts. `projectId: null` is a global note, which is what the UI's notes panel creates. */
export const buildNoteEntity = (input: NewNoteInput): Record<string, unknown> => {
  const now = Date.now();
  return {
    id: nanoid(),
    projectId: input.projectId ?? null,
    isPinnedToToday: input.isPinnedToToday ?? false,
    content: input.content,
    created: now,
    modified: now,
    ...(input.backgroundColor ? { backgroundColor: input.backgroundColor } : {}),
    ...(input.imgUrl ? { imgUrl: input.imgUrl } : {}),
  };
};

export interface NewTaskRepeatCfgInput {
  repeatCycle?: string;
  repeatEvery?: number;
  startDate?: string;
  startTime?: string;
  isPaused?: boolean;
  monday?: boolean;
  tuesday?: boolean;
  wednesday?: boolean;
  thursday?: boolean;
  friday?: boolean;
  saturday?: boolean;
  sunday?: boolean;
  defaultEstimate?: number;
  notes?: string;
  tagIds?: string[];
  order?: number;
  repeatFromCompletionDate?: boolean;
  waitForCompletion?: boolean;
}

/**
 * Templated from DEFAULT_TASK_REPEAT_CFG in the client, field for field.
 *
 * Title and projectId come from the task being made recurring rather than from input, because that is what the UI does: the config describes
 * how a task repeats, not a second place to name it.
 *
 * Deliberately narrow. The monthly Nth-weekday and last-day anchors, sub-task templates and reminders are omitted: they carry interdependent rules
 * (the anchors are mutually exclusive, and a malformed pair silently changes the recurrence) that are better set in the UI than guessed at over HTTP.
 */
export const buildTaskRepeatCfgEntity = (
  input: NewTaskRepeatCfgInput,
  from: { title: unknown; projectId: unknown; tagIds?: unknown },
): Record<string, unknown> => ({
  id: nanoid(),
  projectId: (from.projectId as string | null) ?? null,
  title: (from.title as string | null) ?? null,
  lastTaskCreation: Date.now(),
  lastTaskCreationDay: new Date().toLocaleDateString('en-CA'),
  tagIds: input.tagIds ?? (Array.isArray(from.tagIds) ? (from.tagIds as string[]) : []),
  order: input.order ?? 0,
  isPaused: input.isPaused ?? false,
  quickSetting: 'CUSTOM',
  repeatCycle: input.repeatCycle ?? 'WEEKLY',
  repeatEvery: input.repeatEvery ?? 1,
  monday: input.monday ?? true,
  tuesday: input.tuesday ?? true,
  wednesday: input.wednesday ?? true,
  thursday: input.thursday ?? true,
  friday: input.friday ?? true,
  saturday: input.saturday ?? false,
  sunday: input.sunday ?? false,
  repeatFromCompletionDate: input.repeatFromCompletionDate ?? false,
  waitForCompletion: input.waitForCompletion ?? false,
  shouldInheritSubtasks: false,
  disableAutoUpdateSubtasks: false,
  notes: input.notes,
  defaultEstimate: input.defaultEstimate,
  startDate: input.startDate,
  startTime: input.startTime,
});

/** Panel filter fields, defaulted to match a stock Kanban column. Enums come from `@sp/shared-schema`, so these are the app's values, not a copy. */
export interface NewPanelInput {
  title: string;
  id?: string;
  includedTagIds?: string[];
  excludedTagIds?: string[];
  /** 1=All, 2=Done, 3=UnDone. */
  taskDoneState?: number;
  /** 1=All, 2=Scheduled, 3=NotScheduled. */
  scheduledState?: number;
  /** 1=All, 2=NoBacklog, 3=OnlyBacklog. */
  backlogState?: number;
  isParentTasksOnly?: boolean;
  /** [''] means "All Projects" - the app's own convention, not a typo. */
  projectIds?: string[];
}

export const buildPanelEntity = (input: NewPanelInput): Record<string, unknown> => ({
  id: input.id ?? nanoid(),
  title: input.title,
  includedTagIds: input.includedTagIds ?? [],
  excludedTagIds: input.excludedTagIds ?? [],
  taskIds: [],
  taskDoneState: input.taskDoneState ?? BoardPanelCfgTaskDoneState.UnDone,
  scheduledState: input.scheduledState ?? BoardPanelCfgScheduledState.All,
  backlogState: input.backlogState ?? BoardPanelCfgTaskTypeFilter.NoBacklog,
  isParentTasksOnly: input.isParentTasksOnly ?? false,
  projectIds: input.projectIds ?? [''],
});

export interface NewBoardInput {
  title: string;
  id?: string;
  cols?: number;
  panels?: NewPanelInput[];
}

export const buildBoardEntity = (input: NewBoardInput): Record<string, unknown> => {
  const panels = (input.panels ?? []).map(buildPanelEntity);
  return {
    id: input.id ?? nanoid(),
    title: input.title,
    // Columns default to the panel count so a new board is not born with empty
    // gaps or a squeezed grid; explicit `cols` still wins.
    cols: input.cols ?? Math.max(panels.length, 1),
    panels,
  };
};

export class OpFactory {
  constructor(
    private readonly clientId: string,
    private readonly encryptionPassword: string,
  ) {}

  private async _makeOp(params: {
    actionType: string;
    opType: string;
    entityType: string;
    entityId: string;
    entityIds?: string[];
    actionPayload: Record<string, unknown>;
    vectorClock: Record<string, number>;
  }): Promise<SuperSyncOperation> {
    const payloadPlain = JSON.stringify({
      actionPayload: params.actionPayload,
      entityChanges: [],
    });
    const payload = await encrypt(payloadPlain, this.encryptionPassword);
    return {
      id: uuidv7(),
      clientId: this.clientId,
      actionType: params.actionType,
      opType: params.opType,
      entityType: params.entityType,
      entityId: params.entityId,
      ...(params.entityIds ? { entityIds: params.entityIds } : {}),
      payload,
      vectorClock: params.vectorClock,
      timestamp: Date.now(),
      schemaVersion: CURRENT_SCHEMA_VERSION,
      isPayloadEncrypted: true,
    } as SuperSyncOperation;
  }

  /**
   * [Task Shared] addTask - clone of the live client template. The task is added
   * to its own PROJECT context (not forced into the Today view); planning to
   * Today is an explicit, separate action.
   */
  addTask(
    task: Record<string, unknown>,
    vectorClock: Record<string, number>,
  ): Promise<SuperSyncOperation> {
    const projectId = (task.projectId as string) || 'INBOX_PROJECT';
    return this._makeOp({
      actionType: '[Task Shared] addTask',
      opType: 'CRT',
      entityType: 'TASK',
      entityId: task.id as string,
      actionPayload: {
        task,
        workContextId: projectId,
        workContextType: 'PROJECT',
        isAddToBacklog: false,
        isAddToBottom: false,
      },
      vectorClock,
    });
  }

  /** [Task Shared] updateTask - NgRx Update<Task> shape { task: { id, changes } }. */
  updateTask(
    id: string,
    changes: Record<string, unknown>,
    vectorClock: Record<string, number>,
  ): Promise<SuperSyncOperation> {
    return this._makeOp({
      actionType: '[Task Shared] updateTask',
      opType: 'UPD',
      entityType: 'TASK',
      entityId: id,
      actionPayload: { task: { id, changes } },
      vectorClock,
    });
  }

  /** [Task Shared] deleteTask - expects the full task (with subTasks array). */
  deleteTask(
    task: Record<string, unknown>,
    vectorClock: Record<string, number>,
  ): Promise<SuperSyncOperation> {
    const subTaskIds = Array.isArray(task.subTaskIds)
      ? (task.subTaskIds as string[])
      : [];
    return this._makeOp({
      actionType: '[Task Shared] deleteTask',
      opType: 'DEL',
      entityType: 'TASK',
      entityId: task.id as string,
      entityIds: [task.id as string, ...subTaskIds],
      actionPayload: { task: { ...task, subTasks: [] } },
      vectorClock,
    });
  }

  /** [Task Shared] moveToOtherProject - expects the full task (with subTasks). */
  moveTaskToProject(
    task: Record<string, unknown>,
    targetProjectId: string,
    vectorClock: Record<string, number>,
  ): Promise<SuperSyncOperation> {
    return this._makeOp({
      actionType: '[Task Shared] moveToOtherProject',
      opType: 'UPD',
      entityType: 'TASK',
      entityId: task.id as string,
      actionPayload: { task: { ...task, subTasks: [] }, targetProjectId },
      vectorClock,
    });
  }

  /**
   * [Task] Add SubTask - creates a task nested under parentId. The full subtask
   * entity travels in { task }; receiving clients append it to the parent's
   * subTaskIds via their reducer.
   */
  addSubTask(
    task: Record<string, unknown>,
    parentId: string,
    vectorClock: Record<string, number>,
  ): Promise<SuperSyncOperation> {
    return this._makeOp({
      actionType: '[Task] Add SubTask',
      opType: 'CRT',
      entityType: 'TASK',
      entityId: task.id as string,
      actionPayload: { task, parentId, isIgnoreShortSyntax: false },
      vectorClock,
    });
  }

  /** [Task Shared] convertToSubTask - reparent a main task under targetParentId. */
  convertToSubTask(
    taskId: string,
    targetParentId: string,
    vectorClock: Record<string, number>,
  ): Promise<SuperSyncOperation> {
    return this._makeOp({
      actionType: '[Task Shared] convertToSubTask',
      opType: 'UPD',
      entityType: 'TASK',
      entityId: taskId,
      actionPayload: { taskId, targetParentId, afterTaskId: null },
      vectorClock,
    });
  }

  /** [Task Shared] convertToMainTask - promote a subtask to top-level (full task). */
  convertToMainTask(
    task: Record<string, unknown>,
    vectorClock: Record<string, number>,
  ): Promise<SuperSyncOperation> {
    return this._makeOp({
      actionType: '[Task Shared] convertToMainTask',
      opType: 'UPD',
      entityType: 'TASK',
      entityId: task.id as string,
      actionPayload: { task, isPlanForToday: false, afterTaskId: null },
      vectorClock,
    });
  }

  /** [Task Shared] planTasksForToday - add tasks to the TODAY list (bulk). */
  planTasksForToday(
    taskIds: string[],
    today: string,
    vectorClock: Record<string, number>,
  ): Promise<SuperSyncOperation> {
    return this._makeOp({
      actionType: '[Task Shared] planTasksForToday',
      opType: 'UPD',
      entityType: 'TASK',
      entityId: taskIds[0],
      entityIds: taskIds,
      actionPayload: { taskIds, today, isShowSnack: false },
      vectorClock,
    });
  }

  /** [Task Shared] removeTasksFromTodayTag - remove tasks from the TODAY list (bulk). */
  removeTasksFromTodayTag(
    taskIds: string[],
    vectorClock: Record<string, number>,
  ): Promise<SuperSyncOperation> {
    return this._makeOp({
      actionType: '[Task Shared] removeTasksFromTodayTag',
      opType: 'UPD',
      entityType: 'TASK',
      entityId: taskIds[0],
      entityIds: taskIds,
      actionPayload: { taskIds },
      vectorClock,
    });
  }

  // ── Tags ────────────────────────────────────────────────────────────────────

  /** [Tag] Add Tag - full Tag entity in { tag }. */
  addTag(
    tag: Record<string, unknown>,
    vectorClock: Record<string, number>,
  ): Promise<SuperSyncOperation> {
    return this._makeOp({
      actionType: '[Tag] Add Tag',
      opType: 'CRT',
      entityType: 'TAG',
      entityId: tag.id as string,
      actionPayload: { tag },
      vectorClock,
    });
  }

  /** [Tag] Update Tag - NgRx Update<Tag> shape { tag: { id, changes } }. */
  updateTag(
    id: string,
    changes: Record<string, unknown>,
    vectorClock: Record<string, number>,
  ): Promise<SuperSyncOperation> {
    return this._makeOp({
      actionType: '[Tag] Update Tag',
      opType: 'UPD',
      entityType: 'TAG',
      entityId: id,
      actionPayload: { tag: { id, changes } },
      vectorClock,
    });
  }

  /**
   * [Tag] Delete Tag - payload is just { id }. Receiving clients re-dispatch
   * the action, whose meta-reducer atomically cascades the cleanup (strips the
   * tag from every task's tagIds, board panels, etc.). One op = full cascade.
   */
  deleteTag(
    id: string,
    vectorClock: Record<string, number>,
  ): Promise<SuperSyncOperation> {
    return this._makeOp({
      actionType: '[Tag] Delete Tag',
      opType: 'DEL',
      entityType: 'TAG',
      entityId: id,
      actionPayload: { id },
      vectorClock,
    });
  }

  /**
   * [TaskAttachment] Add TaskAttachment - appends a link/file attachment to a
   * task. Persisted as a TASK update; the client reducer pushes it onto
   * task.attachments.
   */
  addTaskAttachment(
    taskId: string,
    taskAttachment: Record<string, unknown>,
    vectorClock: Record<string, number>,
  ): Promise<SuperSyncOperation> {
    return this._makeOp({
      actionType: '[TaskAttachment] Add TaskAttachment',
      opType: 'UPD',
      entityType: 'TASK',
      entityId: taskId,
      actionPayload: { taskId, taskAttachment },
      vectorClock,
    });
  }

  // ── Projects ────────────────────────────────────────────────────────────────

  /**
   * [Task Shared] deleteProject - deletes a project and (via the client
   * meta-reducer) all its tasks/notes. Carries the delete-wins marker so the LWW
   * conflict planner does not resurrect an emptied project.
   */
  deleteProject(
    projectId: string,
    noteIds: string[],
    allTaskIds: string[],
    vectorClock: Record<string, number>,
  ): Promise<SuperSyncOperation> {
    return this._makeOp({
      actionType: '[Task Shared] deleteProject',
      opType: 'DEL',
      entityType: 'PROJECT',
      entityId: projectId,
      actionPayload: { projectId, noteIds, allTaskIds, projectDeleteWins: true },
      vectorClock,
    });
  }

  /** [Project] Add Project - full Project entity in { project }. */
  addProject(
    project: Record<string, unknown>,
    vectorClock: Record<string, number>,
  ): Promise<SuperSyncOperation> {
    return this._makeOp({
      actionType: '[Project] Add Project',
      opType: 'CRT',
      entityType: 'PROJECT',
      entityId: project.id as string,
      actionPayload: { project },
      vectorClock,
    });
  }

  /** [Project] Update Project - NgRx Update<Project> shape { project: { id, changes } }. */
  updateProject(
    id: string,
    changes: Record<string, unknown>,
    vectorClock: Record<string, number>,
  ): Promise<SuperSyncOperation> {
    return this._makeOp({
      actionType: '[Project] Update Project',
      opType: 'UPD',
      entityType: 'PROJECT',
      entityId: id,
      actionPayload: { project: { id, changes } },
      vectorClock,
    });
  }

  // ── Boards ────────────────────────────────────────────────────────────────
  // Payload shapes are the action creators' own props, verbatim from
  // src/app/features/boards/store/boards.actions.ts - receiving clients
  // re-dispatch the action, so anything else would be ignored by the reducer.

  /** [Boards] Add Board - payload { board }. */
  addBoard(
    board: Record<string, unknown>,
    vectorClock: Record<string, number>,
  ): Promise<SuperSyncOperation> {
    return this._makeOp({
      actionType: '[Boards] Add Board',
      opType: 'CRT',
      entityType: 'BOARD',
      entityId: board.id as string,
      actionPayload: { board },
      vectorClock,
    });
  }

  /**
   * [Boards] Update Board - payload { id, updates }, NOT the NgRx Update shape
   * the other entities use. Panels are replaced wholesale when `updates.panels`
   * is present, which is also how the app edits a single panel.
   */
  updateBoard(
    id: string,
    updates: Record<string, unknown>,
    vectorClock: Record<string, number>,
  ): Promise<SuperSyncOperation> {
    return this._makeOp({
      actionType: '[Boards] Update Board',
      opType: 'UPD',
      entityType: 'BOARD',
      entityId: id,
      actionPayload: { id, updates },
      vectorClock,
    });
  }

  /** [Boards] Remove Board - payload { id }. */
  removeBoard(
    id: string,
    vectorClock: Record<string, number>,
  ): Promise<SuperSyncOperation> {
    return this._makeOp({
      actionType: '[Boards] Remove Board',
      opType: 'DEL',
      entityType: 'BOARD',
      entityId: id,
      actionPayload: { id },
      vectorClock,
    });
  }

  /** [Boards] Sort Boards - bulk MOV over every board id, in display order. */
  sortBoards(
    ids: string[],
    vectorClock: Record<string, number>,
  ): Promise<SuperSyncOperation> {
    return this._makeOp({
      actionType: '[Boards] Sort Boards',
      opType: 'MOV',
      entityType: 'BOARD',
      entityId: ids[0] ?? '',
      entityIds: ids,
      actionPayload: { ids },
      vectorClock,
    });
  }

  /** [Boards] Update Panel Cfg TaskIds - manual card order within one panel. */
  updatePanelTaskIds(
    panelId: string,
    taskIds: string[],
    vectorClock: Record<string, number>,
  ): Promise<SuperSyncOperation> {
    return this._makeOp({
      actionType: '[Boards] Update Panel Cfg TaskIds',
      opType: 'UPD',
      entityType: 'BOARD',
      entityId: panelId,
      actionPayload: { panelId, taskIds },
      vectorClock,
    });
  }

  // ── Notes ───────────────────────────────────────────────────────────────────

  /** [Note] Add Note - full Note entity in { note }. */
  addNote(
    note: Record<string, unknown>,
    vectorClock: Record<string, number>,
  ): Promise<SuperSyncOperation> {
    return this._makeOp({
      actionType: '[Note] Add Note',
      opType: 'CRT',
      entityType: 'NOTE',
      entityId: note.id as string,
      actionPayload: { note },
      vectorClock,
    });
  }

  /** [Note] Update Note - NgRx Update<Note> shape { note: { id, changes } }. */
  updateNote(
    id: string,
    changes: Record<string, unknown>,
    vectorClock: Record<string, number>,
  ): Promise<SuperSyncOperation> {
    return this._makeOp({
      actionType: '[Note] Update Note',
      opType: 'UPD',
      entityType: 'NOTE',
      entityId: id,
      actionPayload: { note: { id, changes } },
      vectorClock,
    });
  }

  /**
   * [Note] Delete Note - the client's reducer needs projectId and isPinnedToToday
   * as well as the id, because it removes the note from the owning project's
   * noteIds and from the today ordering. Sending id alone would orphan both.
   */
  deleteNote(
    id: string,
    projectId: string | null,
    isPinnedToToday: boolean,
    vectorClock: Record<string, number>,
  ): Promise<SuperSyncOperation> {
    return this._makeOp({
      actionType: '[Note] Delete Note',
      opType: 'DEL',
      entityType: 'NOTE',
      entityId: id,
      actionPayload: { id, projectId, isPinnedToToday },
      vectorClock,
    });
  }

  // ── Recurring tasks ─────────────────────────────────────────────────────────

  /**
   * [TaskRepeatCfg][Task] Add TaskRepeatCfg to Task - the client's ONLY
   * persistent create for a repeat config: you make an existing task recurring
   * rather than conjuring a config from nothing. `Upsert TaskRepeatCfg` carries
   * no op metadata at all, so it never reaches the log and is not an
   * alternative. Mirrored exactly, taskId included.
   */
  addTaskRepeatCfgToTask(
    taskId: string,
    taskRepeatCfg: Record<string, unknown>,
    vectorClock: Record<string, number>,
  ): Promise<SuperSyncOperation> {
    return this._makeOp({
      actionType: '[TaskRepeatCfg][Task] Add TaskRepeatCfg to Task',
      opType: 'CRT',
      entityType: 'TASK_REPEAT_CFG',
      entityId: taskRepeatCfg.id as string,
      actionPayload: { taskId, taskRepeatCfg },
      vectorClock,
    });
  }

  /** [TaskRepeatCfg] Update TaskRepeatCfg - NgRx Update shape { taskRepeatCfg: { id, changes } }. */
  updateTaskRepeatCfg(
    id: string,
    changes: Record<string, unknown>,
    vectorClock: Record<string, number>,
  ): Promise<SuperSyncOperation> {
    return this._makeOp({
      actionType: '[TaskRepeatCfg] Update TaskRepeatCfg',
      opType: 'UPD',
      entityType: 'TASK_REPEAT_CFG',
      entityId: id,
      actionPayload: { taskRepeatCfg: { id, changes } },
      vectorClock,
    });
  }

  /** [TaskRepeatCfg] Delete TaskRepeatCfg - payload is just { id }; already-created task instances are left alone, as in the UI. */
  deleteTaskRepeatCfg(
    id: string,
    vectorClock: Record<string, number>,
  ): Promise<SuperSyncOperation> {
    return this._makeOp({
      actionType: '[TaskRepeatCfg] Delete TaskRepeatCfg',
      opType: 'DEL',
      entityType: 'TASK_REPEAT_CFG',
      entityId: id,
      actionPayload: { id },
      vectorClock,
    });
  }
}

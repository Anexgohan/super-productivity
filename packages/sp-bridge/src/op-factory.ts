/**
 * Builds sync operations shaped EXACTLY like the ones a real v18.15.1 client
 * captures (verified field-for-field against live ops in the op-log — see the
 * addTask template at serverSeq 15 of the dev dataset):
 *
 *   envelope: uuidv7 op id, clientId, actionType, opType, entityType/Id,
 *             vectorClock, timestamp, schemaVersion, isPayloadEncrypted
 *   payload:  encrypt({ actionPayload: <exact NgRx action props>,
 *              entityChanges: [] })
 *
 * Write surface is intentionally narrow (mirrors the desktop REST API's
 * ALLOWED_TASK_FIELDS) — receiving clients replay these through their own
 * reducers, so unknown/malformed shapes are a data-corruption risk.
 */
import { randomBytes } from 'node:crypto';
import { encrypt } from '@sp/sync-core';
import type { SuperSyncOperation } from '@sp/shared-schema';

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

/** RFC 9562 UUIDv7 (time-ordered) — same format clients use for op ids. */
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

/** Fields writable via the API — mirror of desktop's ALLOWED_TASK_FIELDS. */
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

export const buildProjectEntity = (
  input: NewProjectInput,
): Record<string, unknown> => ({
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
   * [Task Shared] addTask — clone of the live client template. The task is added
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

  /** [Task Shared] updateTask — NgRx Update<Task> shape { task: { id, changes } }. */
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

  /** [Task Shared] deleteTask — expects the full task (with subTasks array). */
  deleteTask(
    task: Record<string, unknown>,
    vectorClock: Record<string, number>,
  ): Promise<SuperSyncOperation> {
    const subTaskIds = Array.isArray(task.subTaskIds) ? (task.subTaskIds as string[]) : [];
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

  /** [Task Shared] moveToOtherProject — expects the full task (with subTasks). */
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
   * [Task] Add SubTask — creates a task nested under parentId. The full subtask
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

  /** [Task Shared] convertToSubTask — reparent a main task under targetParentId. */
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

  /** [Task Shared] convertToMainTask — promote a subtask to top-level (full task). */
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

  /** [Task Shared] planTasksForToday — add tasks to the TODAY list (bulk). */
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

  /** [Task Shared] removeTasksFromTodayTag — remove tasks from the TODAY list (bulk). */
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

  /** [Tag] Add Tag — full Tag entity in { tag }. */
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

  /** [Tag] Update Tag — NgRx Update<Tag> shape { tag: { id, changes } }. */
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
   * [Tag] Delete Tag — payload is just { id }. Receiving clients re-dispatch
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
   * [TaskAttachment] Add TaskAttachment — appends a link/file attachment to a
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
   * [Task Shared] deleteProject — deletes a project and (via the client
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

  /** [Project] Add Project — full Project entity in { project }. */
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

  /** [Project] Update Project — NgRx Update<Project> shape { project: { id, changes } }. */
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
}

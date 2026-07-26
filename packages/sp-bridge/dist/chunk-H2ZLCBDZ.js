// src/op-factory.ts
import { randomBytes } from 'crypto';
import { encrypt } from '@sp/sync-core';
import {
  BoardPanelCfgScheduledState,
  BoardPanelCfgTaskDoneState,
  BoardPanelCfgTaskTypeFilter,
} from '@sp/shared-schema';
var CURRENT_SCHEMA_VERSION = 4;
var NANOID_ALPHABET = 'useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict';
var nanoid = (size = 21) => {
  const bytes = randomBytes(size);
  let id = '';
  for (let i = 0; i < size; i++) {
    id += NANOID_ALPHABET[bytes[i] & 63];
  }
  return id;
};
var uuidv7 = () => {
  const now = Date.now();
  const bytes = randomBytes(16);
  bytes[0] = (now / 2 ** 40) & 255;
  bytes[1] = (now / 2 ** 32) & 255;
  bytes[2] = (now / 2 ** 24) & 255;
  bytes[3] = (now / 2 ** 16) & 255;
  bytes[4] = (now / 2 ** 8) & 255;
  bytes[5] = now & 255;
  bytes[6] = (bytes[6] & 15) | 112;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
var ALLOWED_TASK_FIELDS = /* @__PURE__ */ new Set([
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
var buildTaskEntity = (input) => ({
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
var DEFAULT_ADVANCED_CFG = {
  worklogExportSettings: {
    cols: ['DATE', 'START', 'END', 'TIME_CLOCK', 'TITLES_INCLUDING_SUB'],
    roundWorkTimeTo: null,
    roundStartTimeTo: null,
    roundEndTimeTo: null,
    separateTasksBy: ' | ',
    groupBy: 'DATE',
  },
};
var buildTheme = (primary) => ({
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
var DEFAULT_TAG_COLOR = '#7b1fa2';
var DEFAULT_PROJECT_COLOR = '#29b6f6';
var buildTagEntity = (input) => ({
  id: nanoid(),
  title: input.title,
  created: Date.now(),
  color: input.color ?? null,
  icon: input.icon ?? null,
  taskIds: [],
  advancedCfg: DEFAULT_ADVANCED_CFG,
  theme: buildTheme(input.color ?? DEFAULT_TAG_COLOR),
});
var buildProjectEntity = (input) => ({
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
var buildPanelEntity = (input) => ({
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
var buildBoardEntity = (input) => {
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
var OpFactory = class {
  constructor(clientId, encryptionPassword) {
    this.clientId = clientId;
    this.encryptionPassword = encryptionPassword;
  }
  async _makeOp(params) {
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
    };
  }
  /**
   * [Task Shared] addTask - clone of the live client template. The task is added
   * to its own PROJECT context (not forced into the Today view); planning to
   * Today is an explicit, separate action.
   */
  addTask(task, vectorClock) {
    const projectId = task.projectId || 'INBOX_PROJECT';
    return this._makeOp({
      actionType: '[Task Shared] addTask',
      opType: 'CRT',
      entityType: 'TASK',
      entityId: task.id,
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
  updateTask(id, changes, vectorClock) {
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
  deleteTask(task, vectorClock) {
    const subTaskIds = Array.isArray(task.subTaskIds) ? task.subTaskIds : [];
    return this._makeOp({
      actionType: '[Task Shared] deleteTask',
      opType: 'DEL',
      entityType: 'TASK',
      entityId: task.id,
      entityIds: [task.id, ...subTaskIds],
      actionPayload: { task: { ...task, subTasks: [] } },
      vectorClock,
    });
  }
  /** [Task Shared] moveToOtherProject - expects the full task (with subTasks). */
  moveTaskToProject(task, targetProjectId, vectorClock) {
    return this._makeOp({
      actionType: '[Task Shared] moveToOtherProject',
      opType: 'UPD',
      entityType: 'TASK',
      entityId: task.id,
      actionPayload: { task: { ...task, subTasks: [] }, targetProjectId },
      vectorClock,
    });
  }
  /**
   * [Task] Add SubTask - creates a task nested under parentId. The full subtask
   * entity travels in { task }; receiving clients append it to the parent's
   * subTaskIds via their reducer.
   */
  addSubTask(task, parentId, vectorClock) {
    return this._makeOp({
      actionType: '[Task] Add SubTask',
      opType: 'CRT',
      entityType: 'TASK',
      entityId: task.id,
      actionPayload: { task, parentId, isIgnoreShortSyntax: false },
      vectorClock,
    });
  }
  /** [Task Shared] convertToSubTask - reparent a main task under targetParentId. */
  convertToSubTask(taskId, targetParentId, vectorClock) {
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
  convertToMainTask(task, vectorClock) {
    return this._makeOp({
      actionType: '[Task Shared] convertToMainTask',
      opType: 'UPD',
      entityType: 'TASK',
      entityId: task.id,
      actionPayload: { task, isPlanForToday: false, afterTaskId: null },
      vectorClock,
    });
  }
  /** [Task Shared] planTasksForToday - add tasks to the TODAY list (bulk). */
  planTasksForToday(taskIds, today, vectorClock) {
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
  removeTasksFromTodayTag(taskIds, vectorClock) {
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
  addTag(tag, vectorClock) {
    return this._makeOp({
      actionType: '[Tag] Add Tag',
      opType: 'CRT',
      entityType: 'TAG',
      entityId: tag.id,
      actionPayload: { tag },
      vectorClock,
    });
  }
  /** [Tag] Update Tag - NgRx Update<Tag> shape { tag: { id, changes } }. */
  updateTag(id, changes, vectorClock) {
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
  deleteTag(id, vectorClock) {
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
  addTaskAttachment(taskId, taskAttachment, vectorClock) {
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
  deleteProject(projectId, noteIds, allTaskIds, vectorClock) {
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
  addProject(project, vectorClock) {
    return this._makeOp({
      actionType: '[Project] Add Project',
      opType: 'CRT',
      entityType: 'PROJECT',
      entityId: project.id,
      actionPayload: { project },
      vectorClock,
    });
  }
  /** [Project] Update Project - NgRx Update<Project> shape { project: { id, changes } }. */
  updateProject(id, changes, vectorClock) {
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
  addBoard(board, vectorClock) {
    return this._makeOp({
      actionType: '[Boards] Add Board',
      opType: 'CRT',
      entityType: 'BOARD',
      entityId: board.id,
      actionPayload: { board },
      vectorClock,
    });
  }
  /**
   * [Boards] Update Board - payload { id, updates }, NOT the NgRx Update shape
   * the other entities use. Panels are replaced wholesale when `updates.panels`
   * is present, which is also how the app edits a single panel.
   */
  updateBoard(id, updates, vectorClock) {
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
  removeBoard(id, vectorClock) {
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
  sortBoards(ids, vectorClock) {
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
  updatePanelTaskIds(panelId, taskIds, vectorClock) {
    return this._makeOp({
      actionType: '[Boards] Update Panel Cfg TaskIds',
      opType: 'UPD',
      entityType: 'BOARD',
      entityId: panelId,
      actionPayload: { panelId, taskIds },
      vectorClock,
    });
  }
};

export {
  CURRENT_SCHEMA_VERSION,
  nanoid,
  uuidv7,
  ALLOWED_TASK_FIELDS,
  buildTaskEntity,
  buildTagEntity,
  buildProjectEntity,
  buildPanelEntity,
  buildBoardEntity,
  OpFactory,
};

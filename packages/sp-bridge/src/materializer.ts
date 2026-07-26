/**
 * Materializes app state from a stream of SuperSync operations.
 *
 * Mirrors the semantics of two reference implementations in this repo:
 *  - server-side: packages/super-sync-server/src/sync/op-replay.ts
 *    (full-state replacement, per-op entity spread, batch DEL via entityIds,
 *    prototype-pollution guards)
 *  - client-side: modern ops wrap payloads in a MultiEntityPayload envelope
 *    ({ actionPayload, entityChanges }) - entityChanges are the authoritative
 *    state diff and MUST be applied instead of spreading the envelope itself
 *    (which would corrupt entities with actionPayload/entityChanges keys).
 *
 * Unlike the server (which cannot decrypt), the bridge holds the E2E
 * passphrase and decrypts payloads before applying - same crypto path as any
 * client (@sp/sync-core decrypt: Argon2id + AES-256-GCM incl. @noble fallback).
 */
import {
  decrypt,
  extractActionPayload,
  extractEntityFromPayload,
  extractUpdateChanges,
  isMultiEntityPayload,
} from '@sp/sync-core';
import type { SuperSyncOperation, SuperSyncServerOperation } from '@sp/shared-schema';

export type EntityMap = Record<string, Record<string, unknown>>;

const FULL_STATE_OP_TYPES = new Set(['SYNC_IMPORT', 'BACKUP_IMPORT', 'REPAIR']);

/**
 * Maps AppDataComplete section keys (lowercase, as they appear inside a
 * full-state SYNC_IMPORT/BACKUP_IMPORT payload) to the canonical UPPER_SNAKE
 * entityType that incremental ops use. Almost all are camelCase→UPPER_SNAKE;
 * the two irregulars are `boards`→BOARD and `reminders`→REMINDER (the section
 * key is pluralized). Derived from src/app/op-log/core/entity-registry.ts.
 */
const SECTION_TO_ENTITY_TYPE: Record<string, string> = {
  task: 'TASK',
  project: 'PROJECT',
  tag: 'TAG',
  note: 'NOTE',
  simpleCounter: 'SIMPLE_COUNTER',
  taskRepeatCfg: 'TASK_REPEAT_CFG',
  metric: 'METRIC',
  issueProvider: 'ISSUE_PROVIDER',
  section: 'SECTION',
  globalConfig: 'GLOBAL_CONFIG',
  timeTracking: 'TIME_TRACKING',
  menuTree: 'MENU_TREE',
  planner: 'PLANNER',
  boards: 'BOARD',
  reminders: 'REMINDER',
  pluginUserData: 'PLUGIN_USER_DATA',
  pluginMetadata: 'PLUGIN_METADATA',
  archiveYoung: 'ARCHIVE_YOUNG',
  archiveOld: 'ARCHIVE_OLD',
};

const isUnsafeKey = (key: string): boolean =>
  key === '__proto__' || key === 'constructor' || key === 'prototype';

/**
 * Normalizes a full-state AppDataComplete object into the flat, UPPER_SNAKE
 * representation the rest of the bridge uses. NgRx entity-collection sections
 * ({ ids, entities }) collapse to their `entities` map (so reads are
 * `state.TASK[id]`, identical to how incremental ops build state); singleton
 * sections (globalConfig, boards, planner, menuTree, …) are stored whole.
 */
const normalizeFullState = (fullState: Record<string, unknown>): EntityMap => {
  const out: EntityMap = {};
  for (const [sectionKey, value] of Object.entries(fullState)) {
    if (isUnsafeKey(sectionKey)) continue;
    const canonical = SECTION_TO_ENTITY_TYPE[sectionKey] ?? sectionKey.toUpperCase();
    if (
      value &&
      typeof value === 'object' &&
      'entities' in (value as Record<string, unknown>) &&
      'ids' in (value as Record<string, unknown>)
    ) {
      out[canonical] = {
        ...(value as { entities: Record<string, unknown> }).entities,
      };
    } else if (value && typeof value === 'object') {
      out[canonical] = value as Record<string, unknown>;
    }
  }
  return out;
};

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};

export class Materializer {
  private _state: EntityMap = {};
  private _lastServerSeq = 0;
  /** Component-wise max of every vector clock seen - basis for write clocks. */
  private _mergedClock: Record<string, number> = {};

  constructor(private readonly encryptionPassword: string) {}

  get lastServerSeq(): number {
    return this._lastServerSeq;
  }

  get state(): EntityMap {
    return this._state;
  }

  get mergedClock(): Record<string, number> {
    return { ...this._mergedClock };
  }

  /** Restores from a persisted cache written by toCache(). */
  restoreFromCache(cache: {
    state: EntityMap;
    lastServerSeq: number;
    mergedClock?: Record<string, number>;
  }): void {
    this._state = cache.state;
    this._lastServerSeq = cache.lastServerSeq;
    this._mergedClock = cache.mergedClock ?? {};
  }

  toCache(): {
    state: EntityMap;
    lastServerSeq: number;
    mergedClock: Record<string, number>;
  } {
    return {
      state: this._state,
      lastServerSeq: this._lastServerSeq,
      mergedClock: this._mergedClock,
    };
  }

  /**
   * Applies server rows in order. Each row is { serverSeq, op, receivedAt } -
   * the operation itself nests under `.op` (SuperSyncServerOperationSchema).
   */
  async applyOps(rows: SuperSyncServerOperation[]): Promise<void> {
    for (const row of rows) {
      await this._applyOp(row.op as SuperSyncOperation);
      if (row.serverSeq > this._lastServerSeq) {
        this._lastServerSeq = row.serverSeq;
      }
      const clock = (row.op as SuperSyncOperation).vectorClock;
      if (clock && typeof clock === 'object') {
        for (const [component, value] of Object.entries(clock)) {
          if (typeof value !== 'number' || isUnsafeKey(component)) continue;
          if ((this._mergedClock[component] ?? 0) < value) {
            this._mergedClock[component] = value;
          }
        }
      }
    }
  }

  private async _decryptPayload(op: SuperSyncOperation): Promise<unknown> {
    if (!op.isPayloadEncrypted) {
      return op.payload;
    }
    if (typeof op.payload !== 'string') {
      throw new Error(`sp-bridge: encrypted op ${op.id} has non-string payload`);
    }
    const plaintext = await decrypt(op.payload, this.encryptionPassword);
    return JSON.parse(plaintext);
  }

  private async _applyOp(op: SuperSyncOperation): Promise<void> {
    const payload = await this._decryptPayload(op);

    // 1) Full-state ops replace everything (see op-replay.ts for rationale).
    //    Payload is either { appDataComplete: {...} } or the AppDataComplete
    //    directly; normalizeFullState collapses NgRx sections to flat maps so
    //    reads match the incremental-op representation.
    if (FULL_STATE_OP_TYPES.has(op.opType)) {
      const fullState =
        payload && typeof payload === 'object' && 'appDataComplete' in payload
          ? (payload as { appDataComplete: unknown }).appDataComplete
          : payload;
      if (!fullState || typeof fullState !== 'object') {
        throw new Error(`sp-bridge: ${op.opType} op ${op.id} has non-object payload`);
      }
      this._state = normalizeFullState(fullState as Record<string, unknown>);
      return;
    }

    // 2) Envelope with populated entityChanges: authoritative diff.
    //    NOTE: real client ops routinely ship entityChanges as an EMPTY array
    //    (verified against live v18.15.1 data) - the action payload is then
    //    the source of truth and must be interpreted per action family.
    if (isMultiEntityPayload(payload) && payload.entityChanges.length > 0) {
      for (const change of payload.entityChanges) {
        this._applyEntityChange(
          change.entityType,
          change.entityId,
          change.opType,
          change.changes,
        );
      }
      return;
    }

    // 3) Action-applier: interpret the action payload (reducer-lite)
    this._applyFromActionPayload(op, payload);
  }

  /**
   * Payload key an entity is nested under in action payloads, per entityType
   * (e.g. addTask → { task: {...} }). Used by the sync-core extract helpers,
   * which also handle {id, changes} updates and array-payload fallbacks.
   */
  private _payloadKeyFor(entityType: string): string {
    const map: Record<string, string> = {
      TASK: 'task',
      PROJECT: 'project',
      TAG: 'tag',
      NOTE: 'note',
      BOARD: 'board',
      SIMPLE_COUNTER: 'simpleCounter',
      TASK_REPEAT_CFG: 'taskRepeatCfg',
      IMPROVEMENT: 'improvement',
      OBSTRUCTION: 'obstruction',
      METRIC: 'metric',
    };
    return map[entityType] ?? entityType.toLowerCase();
  }

  /**
   * Boards are not an entity map. The whole feature is a single
   * `{ boardCfgs: BoardCfg[] }` record, so the generic id-keyed path below
   * would write a sibling key *beside* the array rather than touch a board -
   * which is why board ops were silently dropped and the bridge only ever saw
   * boards via a full-state SYNC_IMPORT.
   *
   * Mirrors src/app/features/boards/store/boards.reducer.ts so a board edited
   * in a browser and one edited through the REST API converge on the same
   * result.
   *
   * `[Boards] Update Panel Cfg` is deliberately unhandled: its reducer case is
   * commented out upstream, so acting on it here would move the bridge to a
   * state no browser would ever reach. Panel edits arrive as an
   * `[Boards] Update Board` carrying a replacement `panels` array.
   */
  private _applyBoardOp(op: SuperSyncOperation, payload: unknown): void {
    const action = asRecord(extractActionPayload(payload));
    const state = (this._state.BOARD ??= {});
    const boards: Record<string, unknown>[] = Array.isArray(state.boardCfgs)
      ? (state.boardCfgs as Record<string, unknown>[])
      : [];

    switch (op.actionType) {
      case '[Boards] Add Board': {
        const board = asRecord(action.board);
        if (typeof board.id === 'string' && board.id) {
          state.boardCfgs = [...boards, board];
        }
        break;
      }
      case '[Boards] Update Board': {
        const id = (action.id as string) || op.entityId;
        const updates = asRecord(action.updates);
        if (!id || Object.keys(updates).length === 0) break;
        state.boardCfgs = boards.map((b) => (b.id === id ? { ...b, ...updates } : b));
        break;
      }
      case '[Boards] Remove Board': {
        const id = (action.id as string) || op.entityId;
        if (!id) break;
        state.boardCfgs = boards.filter((b) => b.id !== id);
        break;
      }
      case '[Boards] Sort Boards': {
        const ids = Array.isArray(action.ids) ? (action.ids as string[]) : [];
        if (!ids.length) break;
        const byId = new Map(boards.map((b) => [b.id as string, b]));
        const ordered = ids
          .map((id) => byId.get(id))
          .filter((b): b is Record<string, unknown> => !!b);
        // Boards missing from `ids` survive at the tail, matching the reducer:
        // a stale sort from another client must not delete a new board.
        const seen = new Set(ids);
        state.boardCfgs = [
          ...ordered,
          ...boards.filter((b) => !seen.has(b.id as string)),
        ];
        break;
      }
      case '[Boards] Update Panel Cfg TaskIds': {
        const panelId = (action.panelId as string) || op.entityId;
        const taskIds = Array.isArray(action.taskIds) ? action.taskIds : [];
        if (!panelId) break;
        state.boardCfgs = boards.map((b) => {
          const panels = Array.isArray(b.panels)
            ? (b.panels as Record<string, unknown>[])
            : [];
          if (!panels.some((p) => p.id === panelId)) return b;
          return {
            ...b,
            panels: panels.map((p) => (p.id === panelId ? { ...p, taskIds } : p)),
          };
        });
        break;
      }
    }
  }

  private _applyFromActionPayload(op: SuperSyncOperation, payload: unknown): void {
    const entityType = op.entityType;
    if (isUnsafeKey(entityType)) return;

    // moveToOtherProject is multi-entity (task.projectId + both projects'
    // taskIds). A generic UPD extract misses it, so mirror the client
    // meta-reducer here for read accuracy. The wire op itself is unchanged.
    if (op.actionType === '[Task Shared] moveToOtherProject') {
      const action = asRecord(extractActionPayload(payload));
      const taskId = op.entityId;
      const targetProjectId = action.targetProjectId as string | undefined;
      if (taskId && targetProjectId && !isUnsafeKey(taskId)) {
        const task = asRecord((this._state.TASK ??= {})[taskId]);
        const oldProjectId = task.projectId as string | undefined;
        task.projectId = targetProjectId;
        this._state.TASK[taskId] = task;
        const projects = (this._state.PROJECT ??= {});
        if (oldProjectId && projects[oldProjectId]) {
          const p = asRecord(projects[oldProjectId]);
          if (Array.isArray(p.taskIds)) {
            p.taskIds = (p.taskIds as string[]).filter((i) => i !== taskId);
          }
        }
        if (projects[targetProjectId]) {
          const p = asRecord(projects[targetProjectId]);
          if (Array.isArray(p.taskIds) && !(p.taskIds as string[]).includes(taskId)) {
            p.taskIds = [...(p.taskIds as string[]), taskId];
          }
        }
      }
      return;
    }

    // Task hierarchy + TODAY-list actions: the wire ops carry action props, not
    // an entity diff, so mirror the relevant client meta-reducer effects here
    // for read accuracy (the wire op itself is unchanged and other clients apply
    // the authoritative cascade themselves).
    if (op.actionType === '[Task Shared] addTask') {
      const action = asRecord(extractActionPayload(payload));
      const task = asRecord(action.task);
      const id = (task.id as string) ?? op.entityId;
      if (id && !isUnsafeKey(id)) {
        (this._state.TASK ??= {})[id] = task;
        const isBottom = action.isAddToBottom === true;
        // Membership cascades only ever UPDATE entities that already exist.
        // On a virgin deployment (API used before any client has initialized
        // the default data) the referenced project/tag may not exist yet -
        // inventing a stub here would serve a malformed entity with no id/title
        // from the read surface. The uploaded op is unaffected either way, and
        // the real entity arrives once a client initializes it.
        const projectId = task.projectId as string | undefined;
        const existingProject =
          projectId && !isUnsafeKey(projectId)
            ? this._state.PROJECT?.[projectId]
            : undefined;
        if (projectId && existingProject) {
          const project = asRecord(existingProject);
          const key = action.isAddToBacklog === true ? 'backlogTaskIds' : 'taskIds';
          const list = Array.isArray(project[key]) ? (project[key] as string[]) : [];
          if (!list.includes(id)) project[key] = isBottom ? [...list, id] : [id, ...list];
          this._state.PROJECT[projectId] = project;
        }
        // Keep each referenced tag's ordering list in sync for created tasks.
        const tagIds = Array.isArray(task.tagIds) ? (task.tagIds as string[]) : [];
        for (const tagId of tagIds) {
          if (isUnsafeKey(tagId)) continue;
          const existingTag = this._state.TAG?.[tagId];
          if (!existingTag) continue;
          const tag = asRecord(existingTag);
          const list = Array.isArray(tag.taskIds) ? (tag.taskIds as string[]) : [];
          if (!list.includes(id)) {
            tag.taskIds = isBottom ? [...list, id] : [id, ...list];
            this._state.TAG[tagId] = tag;
          }
        }
      }
      return;
    }
    if (op.actionType === '[Task] Add SubTask') {
      const action = asRecord(extractActionPayload(payload));
      const task = asRecord(action.task);
      const parentId = action.parentId as string | undefined;
      const id = (task.id as string) ?? op.entityId;
      if (id && !isUnsafeKey(id)) {
        (this._state.TASK ??= {})[id] = task;
        // Only attach to a parent that exists (never invent one - see addTask).
        if (parentId && !isUnsafeKey(parentId) && this._state.TASK[parentId]) {
          const parent = asRecord(this._state.TASK[parentId]);
          const sub = Array.isArray(parent.subTaskIds)
            ? (parent.subTaskIds as string[])
            : [];
          if (!sub.includes(id)) parent.subTaskIds = [...sub, id];
          // A subtask inherits the parent's project membership.
          if (parent.projectId)
            (this._state.TASK[id] as Record<string, unknown>).projectId =
              parent.projectId;
          this._state.TASK[parentId] = parent;
        }
      }
      return;
    }
    if (op.actionType === '[Task Shared] convertToSubTask') {
      const action = asRecord(extractActionPayload(payload));
      const taskId = (action.taskId as string) ?? op.entityId;
      const targetParentId = action.targetParentId as string | undefined;
      const tasks = (this._state.TASK ??= {});
      if (
        taskId &&
        targetParentId &&
        !isUnsafeKey(taskId) &&
        !isUnsafeKey(targetParentId)
      ) {
        const task = asRecord(tasks[taskId]);
        const oldProjectId = task.projectId as string | undefined;
        const parent = asRecord(tasks[targetParentId]);
        task.parentId = targetParentId;
        if (parent.projectId) task.projectId = parent.projectId;
        tasks[taskId] = task;
        const sub = Array.isArray(parent.subTaskIds)
          ? (parent.subTaskIds as string[])
          : [];
        if (!sub.includes(taskId)) parent.subTaskIds = [...sub, taskId];
        tasks[targetParentId] = parent;
        // Drop it from its former project's regular + backlog lists.
        this._removeTaskFromProjectLists(oldProjectId, taskId);
      }
      return;
    }
    if (op.actionType === '[Task Shared] convertToMainTask') {
      const action = asRecord(extractActionPayload(payload));
      const task = asRecord(action.task);
      const taskId = (task.id as string) ?? op.entityId;
      const tasks = (this._state.TASK ??= {});
      if (taskId && !isUnsafeKey(taskId)) {
        const existing = asRecord(tasks[taskId]);
        const oldParentId = existing.parentId as string | undefined;
        delete existing.parentId;
        tasks[taskId] = existing;
        // Detach from the former parent's subtask list.
        if (oldParentId && tasks[oldParentId]) {
          const parent = asRecord(tasks[oldParentId]);
          if (Array.isArray(parent.subTaskIds)) {
            parent.subTaskIds = (parent.subTaskIds as string[]).filter(
              (i) => i !== taskId,
            );
          }
        }
        // Re-attach to its project's regular list (only if that project exists).
        const projectId = existing.projectId as string | undefined;
        const proj =
          projectId && !isUnsafeKey(projectId)
            ? this._state.PROJECT?.[projectId]
            : undefined;
        if (projectId && proj) {
          const project = asRecord(proj);
          const list = Array.isArray(project.taskIds)
            ? (project.taskIds as string[])
            : [];
          if (!list.includes(taskId)) project.taskIds = [...list, taskId];
          this._state.PROJECT[projectId] = project;
        }
      }
      return;
    }
    if (
      op.actionType === '[Task Shared] planTasksForToday' ||
      op.actionType === '[Task Shared] removeTasksFromTodayTag'
    ) {
      const action = asRecord(extractActionPayload(payload));
      const taskIds = Array.isArray(action.taskIds) ? (action.taskIds as string[]) : [];
      // Only update an existing TODAY tag - never invent one (see addTask).
      const existingToday = this._state.TAG?.TODAY;
      if (!existingToday) return;
      const today = asRecord(existingToday);
      const current = Array.isArray(today.taskIds) ? (today.taskIds as string[]) : [];
      if (op.actionType === '[Task Shared] planTasksForToday') {
        const add = taskIds.filter((id) => !current.includes(id));
        today.taskIds = [...current, ...add];
      } else {
        const remove = new Set(taskIds);
        today.taskIds = current.filter((id) => !remove.has(id));
      }
      this._state.TAG.TODAY = today;
      return;
    }

    if (op.actionType === '[TaskAttachment] Add TaskAttachment') {
      const action = asRecord(extractActionPayload(payload));
      const taskId = (action.taskId as string) ?? op.entityId;
      const attachment = asRecord(action.taskAttachment);
      if (taskId && !isUnsafeKey(taskId)) {
        const task = asRecord((this._state.TASK ??= {})[taskId]);
        const list = Array.isArray(task.attachments)
          ? (task.attachments as unknown[])
          : [];
        task.attachments = [...list, attachment];
        this._state.TASK[taskId] = task;
      }
      return;
    }
    if (op.actionType === '[Task Shared] deleteProject') {
      const action = asRecord(extractActionPayload(payload));
      const projectId = (action.projectId as string) ?? op.entityId;
      const allTaskIds = Array.isArray(action.allTaskIds)
        ? (action.allTaskIds as string[])
        : [];
      if (projectId && !isUnsafeKey(projectId)) {
        delete this._state.PROJECT?.[projectId];
        const tasks = this._state.TASK ?? {};
        for (const id of allTaskIds) {
          if (!isUnsafeKey(id)) delete tasks[id];
        }
        // Scrub the deleted tasks from tag/today/planner lists (project is gone).
        this._cascadeTaskDeletion(allTaskIds, {});
      }
      return;
    }

    // Singletons that aren't entity maps: store as one keyed record so REST/
    // MCP consumers can read them; merged shallowly per update.
    if (entityType === 'GLOBAL_CONFIG') {
      const action = asRecord(extractActionPayload(payload));
      const sectionKey = action.sectionKey;
      const bucket = (this._state.GLOBAL_CONFIG ??= {});
      if (typeof sectionKey === 'string' && !isUnsafeKey(sectionKey)) {
        bucket[sectionKey] = {
          ...asRecord(bucket[sectionKey]),
          ...asRecord(action.sectionCfg),
        };
      }
      return;
    }
    if (entityType === 'MENU_TREE') {
      const action = asRecord(extractActionPayload(payload));
      (this._state.MENU_TREE ??= {}).tree = action as Record<string, unknown>;
      return;
    }
    if (entityType === 'BOARD') {
      this._applyBoardOp(op, payload);
      return;
    }

    const bucket = (this._state[entityType] ??= {});
    const payloadKey = this._payloadKeyFor(entityType);

    switch (op.opType) {
      case 'CRT': {
        const entity = extractEntityFromPayload(payload, payloadKey, op.entityId);
        const id = (entity?.id as string | undefined) ?? (op.entityId || undefined);
        if (entity && id && !isUnsafeKey(id)) {
          bucket[id] = entity;
        }
        break;
      }
      case 'UPD':
      case 'MOV': {
        const id = op.entityId;
        if (!id || isUnsafeKey(id)) break;
        const changes = extractUpdateChanges(payload, payloadKey, id);
        if (Object.keys(changes).length > 0) {
          bucket[id] = { ...asRecord(bucket[id]), ...changes };
        }
        break;
      }
      case 'DEL': {
        const ids = op.entityIds?.length
          ? op.entityIds
          : op.entityId
            ? [op.entityId]
            : [];
        // Capture parent links before deletion so we can detach subtasks.
        const parentOf: Record<string, string | undefined> =
          entityType === 'TASK'
            ? Object.fromEntries(
                ids.map((id) => [
                  id,
                  asRecord(bucket[id]).parentId as string | undefined,
                ]),
              )
            : {};
        for (const id of ids) {
          if (isUnsafeKey(id)) continue;
          delete bucket[id];
        }
        // Mirror the client meta-reducer cascade: a deleted tag is stripped
        // from every task's tagIds, so bridge reads don't show dangling refs.
        if (entityType === 'TAG') {
          this._cascadeTagRemoval(ids);
        }
        if (entityType === 'TASK') {
          this._cascadeTaskDeletion(ids, parentOf);
        }
        break;
      }
      default:
        this._applyLegacy(op, payload);
        break;
    }
  }

  /** Removes a task id from a project's regular + backlog ordering lists. */
  private _removeTaskFromProjectLists(
    projectId: string | undefined,
    taskId: string,
  ): void {
    if (!projectId || isUnsafeKey(projectId)) return;
    const project = this._state.PROJECT?.[projectId];
    if (!project) return;
    const rec = asRecord(project);
    for (const key of ['taskIds', 'backlogTaskIds']) {
      if (Array.isArray(rec[key])) {
        rec[key] = (rec[key] as string[]).filter((i) => i !== taskId);
      }
    }
  }

  /**
   * Strips deleted task ids from every list that can reference them (parent
   * subTaskIds, project regular/backlog lists, tag task lists incl. TODAY, and
   * planner days), so bridge reads never show dangling task references.
   */
  private _cascadeTaskDeletion(
    taskIds: string[],
    parentOf: Record<string, string | undefined>,
  ): void {
    const removed = new Set(taskIds);
    // 1) Detach from parents' subtask lists.
    const tasks = this._state.TASK ?? {};
    for (const id of taskIds) {
      const parentId = parentOf[id];
      if (parentId && tasks[parentId]) {
        const parent = asRecord(tasks[parentId]);
        if (Array.isArray(parent.subTaskIds)) {
          parent.subTaskIds = (parent.subTaskIds as string[]).filter(
            (i) => !removed.has(i),
          );
        }
      }
    }
    // 2) Strip from project lists.
    for (const project of Object.values(this._state.PROJECT ?? {})) {
      const rec = asRecord(project);
      for (const key of ['taskIds', 'backlogTaskIds']) {
        if (
          Array.isArray(rec[key]) &&
          (rec[key] as string[]).some((i) => removed.has(i))
        ) {
          rec[key] = (rec[key] as string[]).filter((i) => !removed.has(i));
        }
      }
    }
    // 3) Strip from tag lists (includes TODAY).
    for (const tag of Object.values(this._state.TAG ?? {})) {
      const rec = asRecord(tag);
      if (
        Array.isArray(rec.taskIds) &&
        (rec.taskIds as string[]).some((i) => removed.has(i))
      ) {
        rec.taskIds = (rec.taskIds as string[]).filter((i) => !removed.has(i));
      }
    }
    // 4) Strip from planner days.
    const planner = this._state.PLANNER ? asRecord(this._state.PLANNER.days) : null;
    if (planner) {
      for (const [day, list] of Object.entries(planner)) {
        if (Array.isArray(list) && list.some((i) => removed.has(i as string))) {
          planner[day] = (list as string[]).filter((i) => !removed.has(i));
        }
      }
    }
  }

  /** Strips deleted tag ids from every task's tagIds (read-accuracy cascade). */
  private _cascadeTagRemoval(tagIds: string[]): void {
    const tasks = this._state.TASK;
    if (!tasks) return;
    const removed = new Set(tagIds);
    for (const task of Object.values(tasks)) {
      const rec = asRecord(task);
      if (Array.isArray(rec.tagIds) && rec.tagIds.some((t) => removed.has(t as string))) {
        rec.tagIds = (rec.tagIds as string[]).filter((t) => !removed.has(t));
      }
    }
  }

  private _applyEntityChange(
    entityType: string,
    entityId: string,
    opType: string,
    changes: unknown,
  ): void {
    if (isUnsafeKey(entityType) || isUnsafeKey(entityId)) return;
    const bucket = (this._state[entityType] ??= {});

    switch (opType) {
      case 'CRT':
        bucket[entityId] = asRecord(changes);
        break;
      case 'UPD':
      case 'MOV':
        bucket[entityId] = { ...asRecord(bucket[entityId]), ...asRecord(changes) };
        break;
      case 'DEL':
        delete bucket[entityId];
        break;
      default:
        // Unknown change type: merge conservatively (matches server UPD path)
        bucket[entityId] = { ...asRecord(bucket[entityId]), ...asRecord(changes) };
        break;
    }
  }

  private _applyLegacy(op: SuperSyncOperation, payload: unknown): void {
    const entityType = op.entityType;
    const entityId = op.entityId ?? null;
    if (isUnsafeKey(entityType)) return;
    const bucket = (this._state[entityType] ??= {});

    switch (op.opType) {
      case 'CRT':
      case 'UPD':
      case 'MOV':
        if (entityId && !isUnsafeKey(entityId)) {
          bucket[entityId] = { ...asRecord(bucket[entityId]), ...asRecord(payload) };
        }
        break;
      case 'DEL': {
        const ids = op.entityIds?.length ? op.entityIds : entityId ? [entityId] : [];
        for (const id of ids) {
          if (isUnsafeKey(id)) continue;
          delete bucket[id];
        }
        break;
      }
      case 'BATCH': {
        const batch = asRecord(payload);
        const entities = asRecord(batch.entities);
        if (Object.keys(entities).length > 0) {
          for (const [id, entity] of Object.entries(entities)) {
            if (isUnsafeKey(id)) continue;
            bucket[id] = { ...asRecord(bucket[id]), ...asRecord(entity) };
          }
        } else if (entityId && !isUnsafeKey(entityId)) {
          bucket[entityId] = { ...asRecord(bucket[entityId]), ...batch };
        }
        break;
      }
      default:
        break;
    }
  }
}

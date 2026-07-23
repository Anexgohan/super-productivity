// src/sync-client.ts
import {
  SuperSyncDownloadOpsResponseSchema,
  SuperSyncUploadOpsResponseSchema,
} from '@sp/shared-schema';
var SyncClient = class {
  constructor(cfg) {
    this.cfg = cfg;
  }
  _token = null;
  /**
   * Access token via the auto-provision internal endpoint (same mechanism the
   * web container's entrypoint uses). Requires SP_SYNC_AUTO_PROVISION=true on
   * the server.
   */
  async authenticate() {
    const res = await fetch(`${this.cfg.syncServerUrl}/api/internal/token`, {
      method: 'POST',
      headers: { 'X-Internal-Secret': this.cfg.jwtSecret },
    });
    if (!res.ok) {
      throw new Error(
        `sp-bridge: token fetch failed (${res.status}) \u2014 is SP_SYNC_AUTO_PROVISION=true on the sync server?`,
      );
    }
    const body = await res.json();
    if (!body.token) {
      throw new Error('sp-bridge: token endpoint returned no token');
    }
    this._token = body.token;
  }
  /** Current access token, or null before authenticate(). Used by the WS client. */
  get token() {
    return this._token;
  }
  _authHeaders() {
    if (!this._token) {
      throw new Error('sp-bridge: not authenticated');
    }
    return { Authorization: `Bearer ${this._token}` };
  }
  /**
   * Downloads all ops after sinceSeq, following hasMore pagination.
   * Returns ops in server_seq order plus the latest seq seen.
   */
  async downloadOpsSince(sinceSeq) {
    const all = [];
    let cursor = sinceSeq;
    let latestSeq = sinceSeq;
    for (;;) {
      const url = `${this.cfg.syncServerUrl}/api/sync/ops?sinceSeq=${cursor}&limit=1000`;
      const res = await fetch(url, { headers: this._authHeaders() });
      if (!res.ok) {
        throw new Error(`sp-bridge: ops download failed (${res.status})`);
      }
      const parsed = SuperSyncDownloadOpsResponseSchema.parse(await res.json());
      all.push(...parsed.ops);
      latestSeq = parsed.latestSeq;
      if (!parsed.hasMore || parsed.ops.length === 0) {
        break;
      }
      const last = parsed.ops[parsed.ops.length - 1];
      if (typeof last.serverSeq !== 'number') {
        throw new Error('sp-bridge: op without serverSeq in paginated download');
      }
      cursor = last.serverSeq;
    }
    return { ops: all, latestSeq };
  }
  /**
   * Uploads ops. The server validates each op independently and reports
   * per-op results; any rejection here is surfaced as an error (the bridge
   * never silently drops a write).
   */
  async uploadOps(ops, lastKnownServerSeq) {
    const res = await fetch(`${this.cfg.syncServerUrl}/api/sync/ops`, {
      method: 'POST',
      headers: { ...this._authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ ops, clientId: this.cfg.clientId, lastKnownServerSeq }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `sp-bridge: op upload failed (${res.status}) ${body.slice(0, 300)}`,
      );
    }
    const parsed = SuperSyncUploadOpsResponseSchema.parse(await res.json());
    const results = parsed.results;
    const rejected = (results ?? []).filter((r) => r.accepted === false);
    if (rejected.length > 0) {
      throw new Error(
        `sp-bridge: ${rejected.length} op(s) rejected: ${JSON.stringify(rejected).slice(0, 300)}`,
      );
    }
    return { latestSeq: parsed.latestSeq ?? 0 };
  }
};

// src/materializer.ts
import {
  decrypt,
  extractActionPayload,
  extractEntityFromPayload,
  extractUpdateChanges,
  isMultiEntityPayload,
} from '@sp/sync-core';
var FULL_STATE_OP_TYPES = /* @__PURE__ */ new Set([
  'SYNC_IMPORT',
  'BACKUP_IMPORT',
  'REPAIR',
]);
var SECTION_TO_ENTITY_TYPE = {
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
var isUnsafeKey = (key) =>
  key === '__proto__' || key === 'constructor' || key === 'prototype';
var normalizeFullState = (fullState) => {
  const out = {};
  for (const [sectionKey, value] of Object.entries(fullState)) {
    if (isUnsafeKey(sectionKey)) continue;
    const canonical = SECTION_TO_ENTITY_TYPE[sectionKey] ?? sectionKey.toUpperCase();
    if (value && typeof value === 'object' && 'entities' in value && 'ids' in value) {
      out[canonical] = {
        ...value.entities,
      };
    } else if (value && typeof value === 'object') {
      out[canonical] = value;
    }
  }
  return out;
};
var asRecord = (v) => (typeof v === 'object' && v !== null ? v : {});
var Materializer = class {
  constructor(encryptionPassword) {
    this.encryptionPassword = encryptionPassword;
  }
  _state = {};
  _lastServerSeq = 0;
  /** Component-wise max of every vector clock seen — basis for write clocks. */
  _mergedClock = {};
  get lastServerSeq() {
    return this._lastServerSeq;
  }
  get state() {
    return this._state;
  }
  get mergedClock() {
    return { ...this._mergedClock };
  }
  /** Restores from a persisted cache written by toCache(). */
  restoreFromCache(cache) {
    this._state = cache.state;
    this._lastServerSeq = cache.lastServerSeq;
    this._mergedClock = cache.mergedClock ?? {};
  }
  toCache() {
    return {
      state: this._state,
      lastServerSeq: this._lastServerSeq,
      mergedClock: this._mergedClock,
    };
  }
  /**
   * Applies server rows in order. Each row is { serverSeq, op, receivedAt } —
   * the operation itself nests under `.op` (SuperSyncServerOperationSchema).
   */
  async applyOps(rows) {
    for (const row of rows) {
      await this._applyOp(row.op);
      if (row.serverSeq > this._lastServerSeq) {
        this._lastServerSeq = row.serverSeq;
      }
      const clock = row.op.vectorClock;
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
  async _decryptPayload(op) {
    if (!op.isPayloadEncrypted) {
      return op.payload;
    }
    if (typeof op.payload !== 'string') {
      throw new Error(`sp-bridge: encrypted op ${op.id} has non-string payload`);
    }
    const plaintext = await decrypt(op.payload, this.encryptionPassword);
    return JSON.parse(plaintext);
  }
  async _applyOp(op) {
    const payload = await this._decryptPayload(op);
    if (FULL_STATE_OP_TYPES.has(op.opType)) {
      const fullState =
        payload && typeof payload === 'object' && 'appDataComplete' in payload
          ? payload.appDataComplete
          : payload;
      if (!fullState || typeof fullState !== 'object') {
        throw new Error(`sp-bridge: ${op.opType} op ${op.id} has non-object payload`);
      }
      this._state = normalizeFullState(fullState);
      return;
    }
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
    this._applyFromActionPayload(op, payload);
  }
  /**
   * Payload key an entity is nested under in action payloads, per entityType
   * (e.g. addTask → { task: {...} }). Used by the sync-core extract helpers,
   * which also handle {id, changes} updates and array-payload fallbacks.
   */
  _payloadKeyFor(entityType) {
    const map = {
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
  _applyFromActionPayload(op, payload) {
    const entityType = op.entityType;
    if (isUnsafeKey(entityType)) return;
    if (op.actionType === '[Task Shared] moveToOtherProject') {
      const action = asRecord(extractActionPayload(payload));
      const taskId = op.entityId;
      const targetProjectId = action.targetProjectId;
      if (taskId && targetProjectId && !isUnsafeKey(taskId)) {
        const task = asRecord((this._state.TASK ??= {})[taskId]);
        const oldProjectId = task.projectId;
        task.projectId = targetProjectId;
        this._state.TASK[taskId] = task;
        const projects = (this._state.PROJECT ??= {});
        if (oldProjectId && projects[oldProjectId]) {
          const p = asRecord(projects[oldProjectId]);
          if (Array.isArray(p.taskIds)) {
            p.taskIds = p.taskIds.filter((i) => i !== taskId);
          }
        }
        if (projects[targetProjectId]) {
          const p = asRecord(projects[targetProjectId]);
          if (Array.isArray(p.taskIds) && !p.taskIds.includes(taskId)) {
            p.taskIds = [...p.taskIds, taskId];
          }
        }
      }
      return;
    }
    if (op.actionType === '[Task Shared] addTask') {
      const action = asRecord(extractActionPayload(payload));
      const task = asRecord(action.task);
      const id = task.id ?? op.entityId;
      if (id && !isUnsafeKey(id)) {
        (this._state.TASK ??= {})[id] = task;
        const isBottom = action.isAddToBottom === true;
        const projectId = task.projectId;
        const existingProject =
          projectId && !isUnsafeKey(projectId)
            ? this._state.PROJECT?.[projectId]
            : void 0;
        if (projectId && existingProject) {
          const project = asRecord(existingProject);
          const key = action.isAddToBacklog === true ? 'backlogTaskIds' : 'taskIds';
          const list = Array.isArray(project[key]) ? project[key] : [];
          if (!list.includes(id)) project[key] = isBottom ? [...list, id] : [id, ...list];
          this._state.PROJECT[projectId] = project;
        }
        const tagIds = Array.isArray(task.tagIds) ? task.tagIds : [];
        for (const tagId of tagIds) {
          if (isUnsafeKey(tagId)) continue;
          const existingTag = this._state.TAG?.[tagId];
          if (!existingTag) continue;
          const tag = asRecord(existingTag);
          const list = Array.isArray(tag.taskIds) ? tag.taskIds : [];
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
      const parentId = action.parentId;
      const id = task.id ?? op.entityId;
      if (id && !isUnsafeKey(id)) {
        (this._state.TASK ??= {})[id] = task;
        if (parentId && !isUnsafeKey(parentId) && this._state.TASK[parentId]) {
          const parent = asRecord(this._state.TASK[parentId]);
          const sub = Array.isArray(parent.subTaskIds) ? parent.subTaskIds : [];
          if (!sub.includes(id)) parent.subTaskIds = [...sub, id];
          if (parent.projectId) this._state.TASK[id].projectId = parent.projectId;
          this._state.TASK[parentId] = parent;
        }
      }
      return;
    }
    if (op.actionType === '[Task Shared] convertToSubTask') {
      const action = asRecord(extractActionPayload(payload));
      const taskId = action.taskId ?? op.entityId;
      const targetParentId = action.targetParentId;
      const tasks = (this._state.TASK ??= {});
      if (
        taskId &&
        targetParentId &&
        !isUnsafeKey(taskId) &&
        !isUnsafeKey(targetParentId)
      ) {
        const task = asRecord(tasks[taskId]);
        const oldProjectId = task.projectId;
        const parent = asRecord(tasks[targetParentId]);
        task.parentId = targetParentId;
        if (parent.projectId) task.projectId = parent.projectId;
        tasks[taskId] = task;
        const sub = Array.isArray(parent.subTaskIds) ? parent.subTaskIds : [];
        if (!sub.includes(taskId)) parent.subTaskIds = [...sub, taskId];
        tasks[targetParentId] = parent;
        this._removeTaskFromProjectLists(oldProjectId, taskId);
      }
      return;
    }
    if (op.actionType === '[Task Shared] convertToMainTask') {
      const action = asRecord(extractActionPayload(payload));
      const task = asRecord(action.task);
      const taskId = task.id ?? op.entityId;
      const tasks = (this._state.TASK ??= {});
      if (taskId && !isUnsafeKey(taskId)) {
        const existing = asRecord(tasks[taskId]);
        const oldParentId = existing.parentId;
        delete existing.parentId;
        tasks[taskId] = existing;
        if (oldParentId && tasks[oldParentId]) {
          const parent = asRecord(tasks[oldParentId]);
          if (Array.isArray(parent.subTaskIds)) {
            parent.subTaskIds = parent.subTaskIds.filter((i) => i !== taskId);
          }
        }
        const projectId = existing.projectId;
        const proj =
          projectId && !isUnsafeKey(projectId)
            ? this._state.PROJECT?.[projectId]
            : void 0;
        if (projectId && proj) {
          const project = asRecord(proj);
          const list = Array.isArray(project.taskIds) ? project.taskIds : [];
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
      const taskIds = Array.isArray(action.taskIds) ? action.taskIds : [];
      const existingToday = this._state.TAG?.TODAY;
      if (!existingToday) return;
      const today = asRecord(existingToday);
      const current = Array.isArray(today.taskIds) ? today.taskIds : [];
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
      const taskId = action.taskId ?? op.entityId;
      const attachment = asRecord(action.taskAttachment);
      if (taskId && !isUnsafeKey(taskId)) {
        const task = asRecord((this._state.TASK ??= {})[taskId]);
        const list = Array.isArray(task.attachments) ? task.attachments : [];
        task.attachments = [...list, attachment];
        this._state.TASK[taskId] = task;
      }
      return;
    }
    if (op.actionType === '[Task Shared] deleteProject') {
      const action = asRecord(extractActionPayload(payload));
      const projectId = action.projectId ?? op.entityId;
      const allTaskIds = Array.isArray(action.allTaskIds) ? action.allTaskIds : [];
      if (projectId && !isUnsafeKey(projectId)) {
        delete this._state.PROJECT?.[projectId];
        const tasks = this._state.TASK ?? {};
        for (const id of allTaskIds) {
          if (!isUnsafeKey(id)) delete tasks[id];
        }
        this._cascadeTaskDeletion(allTaskIds, {});
      }
      return;
    }
    if (entityType === 'GLOBAL_CONFIG') {
      const action = asRecord(extractActionPayload(payload));
      const sectionKey = action.sectionKey;
      const bucket2 = (this._state.GLOBAL_CONFIG ??= {});
      if (typeof sectionKey === 'string' && !isUnsafeKey(sectionKey)) {
        bucket2[sectionKey] = {
          ...asRecord(bucket2[sectionKey]),
          ...asRecord(action.sectionCfg),
        };
      }
      return;
    }
    if (entityType === 'MENU_TREE') {
      const action = asRecord(extractActionPayload(payload));
      (this._state.MENU_TREE ??= {}).tree = action;
      return;
    }
    const bucket = (this._state[entityType] ??= {});
    const payloadKey = this._payloadKeyFor(entityType);
    switch (op.opType) {
      case 'CRT': {
        const entity = extractEntityFromPayload(payload, payloadKey, op.entityId);
        const id = entity?.id ?? (op.entityId || void 0);
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
        const parentOf =
          entityType === 'TASK'
            ? Object.fromEntries(ids.map((id) => [id, asRecord(bucket[id]).parentId]))
            : {};
        for (const id of ids) {
          if (isUnsafeKey(id)) continue;
          delete bucket[id];
        }
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
  _removeTaskFromProjectLists(projectId, taskId) {
    if (!projectId || isUnsafeKey(projectId)) return;
    const project = this._state.PROJECT?.[projectId];
    if (!project) return;
    const rec = asRecord(project);
    for (const key of ['taskIds', 'backlogTaskIds']) {
      if (Array.isArray(rec[key])) {
        rec[key] = rec[key].filter((i) => i !== taskId);
      }
    }
  }
  /**
   * Strips deleted task ids from every list that can reference them (parent
   * subTaskIds, project regular/backlog lists, tag task lists incl. TODAY, and
   * planner days), so bridge reads never show dangling task references.
   */
  _cascadeTaskDeletion(taskIds, parentOf) {
    const removed = new Set(taskIds);
    const tasks = this._state.TASK ?? {};
    for (const id of taskIds) {
      const parentId = parentOf[id];
      if (parentId && tasks[parentId]) {
        const parent = asRecord(tasks[parentId]);
        if (Array.isArray(parent.subTaskIds)) {
          parent.subTaskIds = parent.subTaskIds.filter((i) => !removed.has(i));
        }
      }
    }
    for (const project of Object.values(this._state.PROJECT ?? {})) {
      const rec = asRecord(project);
      for (const key of ['taskIds', 'backlogTaskIds']) {
        if (Array.isArray(rec[key]) && rec[key].some((i) => removed.has(i))) {
          rec[key] = rec[key].filter((i) => !removed.has(i));
        }
      }
    }
    for (const tag of Object.values(this._state.TAG ?? {})) {
      const rec = asRecord(tag);
      if (Array.isArray(rec.taskIds) && rec.taskIds.some((i) => removed.has(i))) {
        rec.taskIds = rec.taskIds.filter((i) => !removed.has(i));
      }
    }
    const planner = this._state.PLANNER ? asRecord(this._state.PLANNER.days) : null;
    if (planner) {
      for (const [day, list] of Object.entries(planner)) {
        if (Array.isArray(list) && list.some((i) => removed.has(i))) {
          planner[day] = list.filter((i) => !removed.has(i));
        }
      }
    }
  }
  /** Strips deleted tag ids from every task's tagIds (read-accuracy cascade). */
  _cascadeTagRemoval(tagIds) {
    const tasks = this._state.TASK;
    if (!tasks) return;
    const removed = new Set(tagIds);
    for (const task of Object.values(tasks)) {
      const rec = asRecord(task);
      if (Array.isArray(rec.tagIds) && rec.tagIds.some((t) => removed.has(t))) {
        rec.tagIds = rec.tagIds.filter((t) => !removed.has(t));
      }
    }
  }
  _applyEntityChange(entityType, entityId, opType, changes) {
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
        bucket[entityId] = { ...asRecord(bucket[entityId]), ...asRecord(changes) };
        break;
    }
  }
  _applyLegacy(op, payload) {
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
};

export { SyncClient, Materializer };

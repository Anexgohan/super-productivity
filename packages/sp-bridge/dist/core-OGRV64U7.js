import {
  ALLOWED_TASK_FIELDS,
  buildProjectEntity,
  buildTagEntity,
  buildTaskEntity,
  nanoid,
} from './chunk-G5JMHLQU.js';

// src/core.ts
var ALLOWED_TAG_FIELDS = /* @__PURE__ */ new Set(['title', 'color', 'icon']);
var ALLOWED_PROJECT_FIELDS = /* @__PURE__ */ new Set([
  'title',
  'isEnableBacklog',
  'isArchived',
]);
var TODAY_TAG_ID = 'TODAY';
var err = (message, statusCode) => Object.assign(new Error(message), { statusCode });
var localToday = () => /* @__PURE__ */ new Date().toLocaleDateString('en-CA');
var asRecord = (v) => (typeof v === 'object' && v !== null ? v : {});
var BridgeCore = class {
  constructor(store, ops) {
    this.store = store;
    this.ops = ops;
  }
  _bucket(type) {
    return this.store.state[type] ?? {};
  }
  listTasks(filter = {}) {
    let tasks = Object.values(this._bucket('TASK'));
    if (filter.isDone !== void 0) {
      tasks = tasks.filter((t) => Boolean(t.isDone) === filter.isDone);
    }
    if (filter.projectId !== void 0) {
      tasks = tasks.filter((t) => t.projectId === filter.projectId);
    }
    if (filter.tagId !== void 0) {
      tasks = tasks.filter(
        (t) => Array.isArray(t.tagIds) && t.tagIds.includes(filter.tagId),
      );
    }
    if (filter.dueDay !== void 0) {
      tasks = tasks.filter((t) => t.dueDay === filter.dueDay);
    }
    if (filter.parentId !== void 0) {
      tasks = tasks.filter((t) =>
        filter.parentId === null ? !t.parentId : t.parentId === filter.parentId,
      );
    }
    if (filter.search) {
      const q = filter.search.toLowerCase();
      tasks = tasks.filter(
        (t) =>
          String(t.title ?? '')
            .toLowerCase()
            .includes(q) ||
          String(t.notes ?? '')
            .toLowerCase()
            .includes(q),
      );
    }
    if (filter.parentsOnly) {
      tasks = tasks.filter((t) => !t.parentId);
    }
    if (filter.recurringOnly) {
      tasks = tasks.filter((t) => !!t.repeatCfgId);
    }
    const today = filter.today ?? localToday();
    if (filter.overdue) {
      tasks = tasks.filter(
        (t) => !t.isDone && typeof t.dueDay === 'string' && t.dueDay < today,
      );
    }
    if (filter.plannedForToday) {
      const todayTaskIds = this._todayTaskIds();
      tasks = tasks.filter((t) => todayTaskIds.has(t.id) || t.dueDay === today);
    }
    if (filter.unscheduled) {
      const todayTaskIds = this._todayTaskIds();
      const planned = this._plannedTaskIds();
      tasks = tasks.filter(
        (t) =>
          !t.dueDay && !t.dueWithTime && !todayTaskIds.has(t.id) && !planned.has(t.id),
      );
    }
    if (filter.fields && filter.fields.length > 0) {
      const keep = /* @__PURE__ */ new Set(['id', ...filter.fields]);
      tasks = tasks.map((t) => {
        const out = {};
        for (const k of keep) if (k in t) out[k] = t[k];
        return out;
      });
    }
    return tasks;
  }
  /** Task ids currently in the TODAY tag (the "planned for today" list). */
  _todayTaskIds() {
    const today = this._bucket('TAG')[TODAY_TAG_ID];
    const ids = today && Array.isArray(today.taskIds) ? today.taskIds : [];
    return new Set(ids);
  }
  /** Task ids scheduled on any PLANNER day (future planning board). */
  _plannedTaskIds() {
    const planner = this.store.state.PLANNER;
    const days = planner ? asRecord(planner.days) : {};
    const out = /* @__PURE__ */ new Set();
    for (const ids of Object.values(days)) {
      if (Array.isArray(ids)) for (const id of ids) out.add(id);
    }
    return out;
  }
  getTask(id) {
    return this._bucket('TASK')[id];
  }
  listProjects() {
    return Object.values(this._bucket('PROJECT'));
  }
  listTags() {
    return Object.values(this._bucket('TAG'));
  }
  getConfig() {
    return this._bucket('GLOBAL_CONFIG');
  }
  listTaskRepeatCfgs() {
    return Object.values(this._bucket('TASK_REPEAT_CFG'));
  }
  /** PLANNER board: { [YYYY-MM-DD]: taskId[] } future-day scheduling. */
  getPlanner() {
    return asRecord(this.store.state.PLANNER?.days);
  }
  /**
   * The "current task" is device-local UI state ([Task] SetCurrentTask is
   * non-persistent and never syncs), so a headless peer has none by design.
   * Reported honestly rather than faked.
   */
  getCurrentTask() {
    return {
      currentTask: null,
      note: 'No active task: the headless bridge tracks no running timer (current-task selection is device-local, non-synced UI state).',
    };
  }
  /**
   * Worklog: aggregates task.timeSpentOnDay across tasks, optionally bounded
   * by [from, to] (YYYY-MM-DD, inclusive).
   */
  getWorklog(from, to) {
    const byDay = {};
    for (const [id, task] of Object.entries(this._bucket('TASK'))) {
      const spent = asRecord(task.timeSpentOnDay);
      for (const [day, ms] of Object.entries(spent)) {
        if (typeof ms !== 'number' || ms <= 0) continue;
        if (from && day < from) continue;
        if (to && day > to) continue;
        byDay[day] ??= { totalTimeSpent: 0, tasks: [] };
        byDay[day].totalTimeSpent += ms;
        byDay[day].tasks.push({ id, title: task.title, timeSpent: ms });
      }
    }
    return byDay;
  }
  /** Raw access to any materialized entity bucket — API-only superset feature. */
  listEntityTypes() {
    return Object.keys(this.store.state);
  }
  rawEntities(type) {
    return this.store.state[type];
  }
  // ── Writes ────────────────────────────────────────────────────────────────
  // Every write is a real sync op (cloned from live client op shapes), uploaded
  // to the server and round-tripped back through refresh() — the bridge state
  // you read after a write is what every other client will materialize.
  async createTask(input) {
    if (!input.title || typeof input.title !== 'string') {
      throw Object.assign(new Error('title (string) is required'), { statusCode: 400 });
    }
    if (input.projectId && !this._bucket('PROJECT')[input.projectId]) {
      throw Object.assign(new Error(`Unknown projectId: ${input.projectId}`), {
        statusCode: 400,
      });
    }
    const task = buildTaskEntity(input);
    const op = await this.ops.addTask(task, this.store.nextWriteClock());
    await this.store.submitOps([op]);
    return this.getTask(task.id) ?? task;
  }
  /**
   * Validates a single task update and returns the op WITHOUT submitting it, so
   * both updateTask (one op) and bulkUpdate (many ops, one upload) share the
   * exact same validation + op shape.
   */
  async _buildUpdateOp(id, changes) {
    if (!this.getTask(id)) {
      throw err('Task not found', 404);
    }
    const rejected = Object.keys(changes).filter((k) => !ALLOWED_TASK_FIELDS.has(k));
    if (rejected.length > 0) {
      throw err(`Field(s) not writable via API: ${rejected.join(', ')}`, 400);
    }
    if (Object.keys(changes).length === 0) {
      throw err('No changes given', 400);
    }
    return this.ops.updateTask(id, changes, this.store.nextWriteClock());
  }
  async updateTask(id, changes) {
    const op = await this._buildUpdateOp(id, changes);
    await this.store.submitOps([op]);
    return this.getTask(id) ?? {};
  }
  /**
   * Applies per-task updates as N ops in a single upload+refresh. Every id is
   * validated up front — if any is unknown or has an illegal field, nothing is
   * submitted (all-or-nothing), so a bad item never partially applies.
   */
  async bulkUpdate(updates) {
    if (!Array.isArray(updates) || updates.length === 0) {
      throw err('updates must be a non-empty array', 400);
    }
    const ops = [];
    for (const u of updates) {
      if (!u || typeof u.id !== 'string') throw err('each update needs a string id', 400);
      ops.push(await this._buildUpdateOp(u.id, u.changes ?? {}));
    }
    await this.store.submitOps(ops);
    return updates.map((u) => this.getTask(u.id) ?? {});
  }
  /** Marks many tasks done in one upload (sets doneOn=now on each). */
  async bulkComplete(ids) {
    if (!Array.isArray(ids) || ids.length === 0) {
      throw err('taskIds must be a non-empty array', 400);
    }
    const now = Date.now();
    const ops = [];
    for (const id of ids) {
      ops.push(await this._buildUpdateOp(id, { isDone: true, doneOn: now }));
    }
    await this.store.submitOps(ops);
    return { completed: ids };
  }
  async completeTask(id) {
    return this.updateTask(id, { isDone: true, doneOn: Date.now() });
  }
  async deleteTask(id) {
    const existing = this.getTask(id);
    if (!existing) {
      throw Object.assign(new Error('Task not found'), { statusCode: 404 });
    }
    const liveSubtasks = (
      Array.isArray(existing.subTaskIds) ? existing.subTaskIds : []
    ).filter((sid) => this.getTask(sid));
    if (liveSubtasks.length > 0) {
      throw Object.assign(
        new Error('Task has subtasks; delete them first (safety guard)'),
        { statusCode: 409 },
      );
    }
    const op = await this.ops.deleteTask(existing, this.store.nextWriteClock());
    await this.store.submitOps([op]);
    return { deleted: id };
  }
  /**
   * Marks a task done with an explicit completion date (YYYY-MM-DD), stored as
   * local-noon ms so the card sorts on the intended day. This is the correct
   * way to close a task (bare complete leaves doneOn unset → missorts).
   */
  async completeTaskOn(id, doneOnDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(doneOnDate)) {
      throw err('doneOn must be YYYY-MM-DD', 400);
    }
    const doneOn = /* @__PURE__ */ new Date(`${doneOnDate}T12:00:00`).getTime();
    return this.updateTask(id, { isDone: true, doneOn });
  }
  /** Adds a tag to a task, preserving its other tags (the Kanban column move). */
  async addTagToTask(id, tagId) {
    const task = this.getTask(id);
    if (!task) throw err('Task not found', 404);
    if (!this._bucket('TAG')[tagId] && tagId !== TODAY_TAG_ID) {
      throw err(`Unknown tagId: ${tagId}`, 400);
    }
    const current = Array.isArray(task.tagIds) ? task.tagIds : [];
    if (current.includes(tagId)) return task;
    return this.updateTask(id, { tagIds: [...current, tagId] });
  }
  /** Removes a tag from a task, preserving its other tags. */
  async removeTagFromTask(id, tagId) {
    const task = this.getTask(id);
    if (!task) throw err('Task not found', 404);
    const current = Array.isArray(task.tagIds) ? task.tagIds : [];
    if (!current.includes(tagId)) return task;
    return this.updateTask(id, { tagIds: current.filter((t) => t !== tagId) });
  }
  /** Moves a top-level task to another project (errors on subtasks). */
  async moveTaskToProject(id, projectId) {
    const task = this.getTask(id);
    if (!task) throw err('Task not found', 404);
    if (task.parentId) throw err('Cannot move a subtask between projects', 400);
    if (!this._bucket('PROJECT')[projectId])
      throw err(`Unknown projectId: ${projectId}`, 400);
    const op = await this.ops.moveTaskToProject(
      task,
      projectId,
      this.store.nextWriteClock(),
    );
    await this.store.submitOps([op]);
    return this.getTask(id) ?? task;
  }
  // ── Subtasks & hierarchy ────────────────────────────────────────────────────
  /** Creates a subtask under a top-level parent (subtasks inherit its project). */
  async createSubTask(parentId, input) {
    if (!input.title || typeof input.title !== 'string') {
      throw err('title (string) is required', 400);
    }
    const parent = this.getTask(parentId);
    if (!parent) throw err(`Unknown parentId: ${parentId}`, 400);
    if (parent.parentId) throw err('Cannot nest a subtask under another subtask', 400);
    const task = buildTaskEntity({
      ...input,
      parentId,
      projectId: parent.projectId,
    });
    const op = await this.ops.addSubTask(task, parentId, this.store.nextWriteClock());
    await this.store.submitOps([op]);
    return this.getTask(task.id) ?? task;
  }
  /** Creates a parent task plus its subtasks in one upload. */
  async createTaskWithSubtasks(input, subTaskTitles) {
    if (!input.title || typeof input.title !== 'string') {
      throw err('title (string) is required', 400);
    }
    if (input.projectId && !this._bucket('PROJECT')[input.projectId]) {
      throw err(`Unknown projectId: ${input.projectId}`, 400);
    }
    const parent = buildTaskEntity(input);
    const ops = [await this.ops.addTask(parent, this.store.nextWriteClock())];
    for (const title of subTaskTitles) {
      if (!title || typeof title !== 'string') continue;
      const sub = buildTaskEntity({
        title,
        parentId: parent.id,
        projectId: parent.projectId,
      });
      ops.push(await this.ops.addSubTask(sub, parent.id, this.store.nextWriteClock()));
    }
    await this.store.submitOps(ops);
    return this.getTask(parent.id) ?? parent;
  }
  /**
   * Reparents a task: pass a parentId to nest it, or null/'' to promote it to a
   * top-level task. A task with its own subtasks cannot become a subtask.
   */
  async reparentTask(taskId, newParentId) {
    const task = this.getTask(taskId);
    if (!task) throw err('Task not found', 404);
    if (!newParentId) {
      if (!task.parentId) throw err('Task is already a top-level task', 400);
      const op2 = await this.ops.convertToMainTask(task, this.store.nextWriteClock());
      await this.store.submitOps([op2]);
      return this.getTask(taskId) ?? task;
    }
    if (taskId === newParentId) throw err('A task cannot be its own parent', 400);
    const parent = this.getTask(newParentId);
    if (!parent) throw err(`Unknown parentId: ${newParentId}`, 400);
    if (parent.parentId) throw err('Target parent is itself a subtask', 400);
    if (Array.isArray(task.subTaskIds) && task.subTaskIds.length > 0) {
      throw err('Task has its own subtasks and cannot become a subtask', 409);
    }
    const op = await this.ops.convertToSubTask(
      taskId,
      newParentId,
      this.store.nextWriteClock(),
    );
    await this.store.submitOps([op]);
    return this.getTask(taskId) ?? task;
  }
  /**
   * Reorders a task list in place. Exactly one container must be given:
   *  - { projectId } → the project's regular task list
   *  - { parentId }  → a parent's subtask list
   *  - { today: true } → the TODAY list
   * `taskIds` must be a permutation of that list's current members (reorder
   * only — no adds or drops).
   */
  async reorderTasks(container, taskIds) {
    if (!Array.isArray(taskIds) || taskIds.length === 0) {
      throw err('taskIds must be a non-empty array', 400);
    }
    const targets = [container.projectId, container.parentId, container.today].filter(
      (v) => v !== void 0 && v !== false,
    );
    if (targets.length !== 1) {
      throw err('specify exactly one of projectId, parentId, or today', 400);
    }
    let current;
    let op;
    if (container.projectId) {
      const project = this._bucket('PROJECT')[container.projectId];
      if (!project) throw err(`Unknown projectId: ${container.projectId}`, 400);
      current = Array.isArray(project.taskIds) ? project.taskIds : [];
      this._assertPermutation(current, taskIds);
      op = await this.ops.updateProject(
        container.projectId,
        { taskIds },
        this.store.nextWriteClock(),
      );
    } else if (container.parentId) {
      const parent = this.getTask(container.parentId);
      if (!parent) throw err(`Unknown parentId: ${container.parentId}`, 400);
      current = Array.isArray(parent.subTaskIds) ? parent.subTaskIds : [];
      this._assertPermutation(current, taskIds);
      op = await this.ops.updateTask(
        container.parentId,
        { subTaskIds: taskIds },
        this.store.nextWriteClock(),
      );
    } else {
      const today = this._bucket('TAG')[TODAY_TAG_ID];
      current = today && Array.isArray(today.taskIds) ? today.taskIds : [];
      this._assertPermutation(current, taskIds);
      op = await this.ops.updateTag(
        TODAY_TAG_ID,
        { taskIds },
        this.store.nextWriteClock(),
      );
    }
    await this.store.submitOps([op]);
    return { reordered: taskIds };
  }
  _assertPermutation(current, proposed) {
    const a = [...current].sort();
    const b = [...proposed].sort();
    if (a.length !== b.length || a.some((v, i) => v !== b[i])) {
      throw err(
        'taskIds must be a permutation of the list current members (reorder only, no adds/removes)',
        400,
      );
    }
  }
  /** Adds tasks to the TODAY list (plan for today). */
  async planTasksForToday(taskIds, today) {
    if (!Array.isArray(taskIds) || taskIds.length === 0) {
      throw err('taskIds must be a non-empty array', 400);
    }
    for (const id of taskIds) {
      if (!this.getTask(id)) throw err(`Task not found: ${id}`, 404);
    }
    const op = await this.ops.planTasksForToday(
      taskIds,
      today ?? localToday(),
      this.store.nextWriteClock(),
    );
    await this.store.submitOps([op]);
    return { planned: taskIds };
  }
  /** Removes tasks from the TODAY list. */
  async removeTasksFromToday(taskIds) {
    if (!Array.isArray(taskIds) || taskIds.length === 0) {
      throw err('taskIds must be a non-empty array', 400);
    }
    const op = await this.ops.removeTasksFromTodayTag(
      taskIds,
      this.store.nextWriteClock(),
    );
    await this.store.submitOps([op]);
    return { removed: taskIds };
  }
  // ── Links & issues ──────────────────────────────────────────────────────────
  /** Attaches a link (URL) to a task; appended to task.attachments. */
  async addLinkToTask(taskId, url, title) {
    if (!this.getTask(taskId)) throw err('Task not found', 404);
    if (!url || typeof url !== 'string') throw err('url (string) is required', 400);
    const attachment = {
      id: nanoid(),
      type: 'LINK',
      path: url,
      title: title && typeof title === 'string' ? title : url,
      icon: 'bookmark',
    };
    const op = await this.ops.addTaskAttachment(
      taskId,
      attachment,
      this.store.nextWriteClock(),
    );
    await this.store.submitOps([op]);
    return this.getTask(taskId) ?? {};
  }
  /**
   * Links a task to an external issue (e.g. a GitHub issue), setting its
   * issueId/issueType/issueProviderId so the issue panel and sync recognize it.
   */
  async linkTaskToIssue(taskId, link) {
    if (!this.getTask(taskId)) throw err('Task not found', 404);
    if (!link.issueId || !link.issueType || !link.issueProviderId) {
      throw err('issueId, issueType and issueProviderId are all required', 400);
    }
    if (!this._bucket('ISSUE_PROVIDER')[link.issueProviderId]) {
      throw err(`Unknown issueProviderId: ${link.issueProviderId}`, 400);
    }
    const changes = {
      issueId: link.issueId,
      issueType: link.issueType,
      issueProviderId: link.issueProviderId,
      ...(typeof link.issuePoints === 'number' ? { issuePoints: link.issuePoints } : {}),
    };
    const op = await this.ops.updateTask(taskId, changes, this.store.nextWriteClock());
    await this.store.submitOps([op]);
    return this.getTask(taskId) ?? {};
  }
  /**
   * Creates a task from a short-syntax string, e.g.
   *   "Ship the release #urgent +Pankha @tomorrow 1h30m"
   *   #tag  → add tag (created if it doesn't exist)
   *   +proj → move to project by title (must already exist)
   *   @date → dueDay: YYYY-MM-DD | today | tomorrow
   *   1h/30m/1h30m (bare token) → time estimate
   */
  async createTaskFromShortSyntax(text, defaultProjectId) {
    if (!text || typeof text !== 'string' || !text.trim()) {
      throw err('text (non-empty string) is required', 400);
    }
    const parsed = this._parseShortSyntax(text);
    if (!parsed.title) throw err('short-syntax has no title text', 400);
    let projectId = defaultProjectId;
    if (parsed.projectName) {
      const match = this.listProjects().find(
        (p) => String(p.title ?? '').toLowerCase() === parsed.projectName.toLowerCase(),
      );
      if (!match) throw err(`Unknown project: +${parsed.projectName}`, 400);
      projectId = match.id;
    }
    const tagIds = [];
    for (const name of parsed.tagNames) {
      const existing = this.listTags().find(
        (t) => String(t.title ?? '').toLowerCase() === name.toLowerCase(),
      );
      if (existing) {
        tagIds.push(existing.id);
      } else {
        const created = await this.createTag({ title: name });
        tagIds.push(created.id);
      }
    }
    return this.createTask({
      title: parsed.title,
      ...(projectId ? { projectId } : {}),
      ...(tagIds.length ? { tagIds } : {}),
      ...(parsed.dueDay ? { dueDay: parsed.dueDay } : {}),
      ...(parsed.timeEstimate ? { timeEstimate: parsed.timeEstimate } : {}),
    });
  }
  _parseShortSyntax(text) {
    const tagNames = [];
    let projectName = null;
    let dueDay;
    let timeEstimate;
    const titleParts = [];
    for (const tok of text.trim().split(/\s+/)) {
      if (tok.length > 1 && tok.startsWith('#')) {
        tagNames.push(tok.slice(1));
      } else if (tok.length > 1 && tok.startsWith('+')) {
        projectName = tok.slice(1);
      } else if (tok.length > 1 && tok.startsWith('@')) {
        const d = this._parseDueToken(tok.slice(1));
        if (d) dueDay = d;
        else titleParts.push(tok);
      } else {
        const ms = this._parseDurationToken(tok);
        if (ms !== null) timeEstimate = ms;
        else titleParts.push(tok);
      }
    }
    return { title: titleParts.join(' '), tagNames, projectName, dueDay, timeEstimate };
  }
  _parseDueToken(v) {
    const lower = v.toLowerCase();
    if (lower === 'today') return localToday();
    if (lower === 'tomorrow') {
      const d = /* @__PURE__ */ new Date();
      d.setDate(d.getDate() + 1);
      return d.toLocaleDateString('en-CA');
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
    return void 0;
  }
  _parseDurationToken(v) {
    const m = /^(?:(\d+)h)?(?:(\d+)m(?:in)?)?$/.exec(v);
    if (!m || (!m[1] && !m[2])) return null;
    const hours = m[1] ? parseInt(m[1], 10) : 0;
    const mins = m[2] ? parseInt(m[2], 10) : 0;
    return hours * 36e5 + mins * 6e4;
  }
  // ── Tags ────────────────────────────────────────────────────────────────────
  async createTag(input) {
    if (!input.title || typeof input.title !== 'string') {
      throw err('title (string) is required', 400);
    }
    const tag = buildTagEntity(input);
    const op = await this.ops.addTag(tag, this.store.nextWriteClock());
    await this.store.submitOps([op]);
    return this._bucket('TAG')[tag.id] ?? tag;
  }
  async updateTag(id, changes) {
    const existing = this._bucket('TAG')[id];
    if (!existing) throw err('Tag not found', 404);
    const bad = Object.keys(changes).filter((k) => !ALLOWED_TAG_FIELDS.has(k));
    if (bad.length) throw err(`Field(s) not writable: ${bad.join(', ')}`, 400);
    const applied = { ...changes };
    if (typeof changes.color === 'string') {
      applied.theme = {
        ...asRecord(existing.theme),
        primary: changes.color,
      };
    }
    const op = await this.ops.updateTag(id, applied, this.store.nextWriteClock());
    await this.store.submitOps([op]);
    return this._bucket('TAG')[id] ?? existing;
  }
  async deleteTag(id) {
    if (id === TODAY_TAG_ID)
      throw err('The TODAY tag is virtual and cannot be deleted', 400);
    if (!this._bucket('TAG')[id]) throw err('Tag not found', 404);
    const op = await this.ops.deleteTag(id, this.store.nextWriteClock());
    await this.store.submitOps([op]);
    return { deleted: id };
  }
  // ── Projects ────────────────────────────────────────────────────────────────
  async createProject(input) {
    if (!input.title || typeof input.title !== 'string') {
      throw err('title (string) is required', 400);
    }
    const project = buildProjectEntity(input);
    const op = await this.ops.addProject(project, this.store.nextWriteClock());
    await this.store.submitOps([op]);
    return this._bucket('PROJECT')[project.id] ?? project;
  }
  async updateProject(id, changes) {
    const existing = this._bucket('PROJECT')[id];
    if (!existing) throw err('Project not found', 404);
    const bad = Object.keys(changes).filter((k) => !ALLOWED_PROJECT_FIELDS.has(k));
    if (bad.length) throw err(`Field(s) not writable: ${bad.join(', ')}`, 400);
    const op = await this.ops.updateProject(id, changes, this.store.nextWriteClock());
    await this.store.submitOps([op]);
    return this._bucket('PROJECT')[id] ?? existing;
  }
  /**
   * Deletes a project and all its tasks (regular + backlog + their subtasks) and
   * notes, in one delete-wins op. INBOX_PROJECT cannot be deleted.
   */
  async deleteProject(id) {
    if (id === 'INBOX_PROJECT') throw err('The Inbox project cannot be deleted', 400);
    const project = this._bucket('PROJECT')[id];
    if (!project) throw err('Project not found', 404);
    const allTaskIds = Object.values(this._bucket('TASK'))
      .filter((t) => t.projectId === id)
      .map((t) => t.id);
    const noteIds = Array.isArray(project.noteIds) ? project.noteIds : [];
    const op = await this.ops.deleteProject(
      id,
      noteIds,
      allTaskIds,
      this.store.nextWriteClock(),
    );
    await this.store.submitOps([op]);
    return { deleted: id, taskCount: allTaskIds.length };
  }
  status() {
    const counts = {};
    for (const [type, entities] of Object.entries(this.store.state)) {
      counts[type] =
        entities && typeof entities === 'object' ? Object.keys(entities).length : 0;
    }
    return {
      lastServerSeq: this.store.lastServerSeq,
      lastSyncAt: this.store.lastSyncAt,
      lastError: this.store.lastError,
      // true = live websocket push; false = falling back to polling
      isLive: this.store.isLive,
      entityCounts: counts,
    };
  }
};
export { BridgeCore };

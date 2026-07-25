/**
 * BridgeCore — the single service layer every external surface consumes.
 * The REST API is the canonical, full-featured interface (by design there is
 * no MCP layer; agents consume the API directly).
 */
import type { StateStore } from './state-store';
import {
  ALLOWED_TASK_FIELDS,
  buildTaskEntity,
  buildTagEntity,
  buildProjectEntity,
  buildBoardEntity,
  buildPanelEntity,
  nanoid,
  OpFactory,
  type NewTaskInput,
  type NewTagInput,
  type NewProjectInput,
  type NewBoardInput,
  type NewPanelInput,
} from './op-factory';

const ALLOWED_TAG_FIELDS = new Set(['title', 'color', 'icon']);
const ALLOWED_PROJECT_FIELDS = new Set(['title', 'isEnableBacklog', 'isArchived']);
const ALLOWED_BOARD_FIELDS = new Set(['title', 'cols', 'panels']);
/**
 * Everything on a panel except `id` (identity) and `taskIds` (manual card
 * order, which has its own action so a reorder does not rewrite the filters).
 */
const ALLOWED_PANEL_FIELDS = new Set([
  'title',
  'includedTagIds',
  'excludedTagIds',
  'includedTagsMatch',
  'excludedTagsMatch',
  'projectIds',
  'taskDoneState',
  'scheduledState',
  'backlogState',
  'isParentTasksOnly',
  'sortBy',
  'sortDir',
]);
/** Virtual tag — membership is derived, never created/deleted as an entity. */
const TODAY_TAG_ID = 'TODAY';

const err = (message: string, statusCode: number): Error =>
  Object.assign(new Error(message), { statusCode });

export interface TaskFilter {
  isDone?: boolean;
  projectId?: string;
  tagId?: string;
  search?: string;
  dueDay?: string;
  parentId?: string | null;
  /** Advanced (MCP-parity) filters. `today` (YYYY-MM-DD) anchors the date-relative ones. */
  overdue?: boolean;
  unscheduled?: boolean;
  plannedForToday?: boolean;
  parentsOnly?: boolean;
  recurringOnly?: boolean;
  today?: string;
  /** Field projection: return only these top-level fields (id is always kept). */
  fields?: string[];
}

/** Local calendar day as YYYY-MM-DD (en-CA formats exactly so). */
const localToday = (): string => new Date().toLocaleDateString('en-CA');

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};

export class BridgeCore {
  constructor(
    private readonly store: StateStore,
    private readonly ops: OpFactory,
  ) {}

  private _bucket(type: string): Record<string, Record<string, unknown>> {
    return (this.store.state[type] ?? {}) as Record<string, Record<string, unknown>>;
  }

  listTasks(filter: TaskFilter = {}): Record<string, unknown>[] {
    let tasks = Object.values(this._bucket('TASK'));
    if (filter.isDone !== undefined) {
      tasks = tasks.filter((t) => Boolean(t.isDone) === filter.isDone);
    }
    if (filter.projectId !== undefined) {
      tasks = tasks.filter((t) => t.projectId === filter.projectId);
    }
    if (filter.tagId !== undefined) {
      tasks = tasks.filter(
        (t) => Array.isArray(t.tagIds) && (t.tagIds as string[]).includes(filter.tagId!),
      );
    }
    if (filter.dueDay !== undefined) {
      tasks = tasks.filter((t) => t.dueDay === filter.dueDay);
    }
    if (filter.parentId !== undefined) {
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
    // Date-relative filters share one "today" anchor (caller-overridable).
    const today = filter.today ?? localToday();
    if (filter.overdue) {
      tasks = tasks.filter(
        (t) => !t.isDone && typeof t.dueDay === 'string' && (t.dueDay as string) < today,
      );
    }
    if (filter.plannedForToday) {
      const todayTaskIds = this._todayTaskIds();
      tasks = tasks.filter((t) => todayTaskIds.has(t.id as string) || t.dueDay === today);
    }
    if (filter.unscheduled) {
      const todayTaskIds = this._todayTaskIds();
      const planned = this._plannedTaskIds();
      tasks = tasks.filter(
        (t) =>
          !t.dueDay &&
          !t.dueWithTime &&
          !todayTaskIds.has(t.id as string) &&
          !planned.has(t.id as string),
      );
    }
    if (filter.fields && filter.fields.length > 0) {
      const keep = new Set(['id', ...filter.fields]);
      tasks = tasks.map((t) => {
        const out: Record<string, unknown> = {};
        for (const k of keep) if (k in t) out[k] = t[k];
        return out;
      });
    }
    return tasks;
  }

  /** Task ids currently in the TODAY tag (the "planned for today" list). */
  private _todayTaskIds(): Set<string> {
    const today = this._bucket('TAG')[TODAY_TAG_ID];
    const ids = today && Array.isArray(today.taskIds) ? (today.taskIds as string[]) : [];
    return new Set(ids);
  }

  /** Task ids scheduled on any PLANNER day (future planning board). */
  private _plannedTaskIds(): Set<string> {
    const planner = this.store.state.PLANNER;
    const days = planner ? asRecord(planner.days) : {};
    const out = new Set<string>();
    for (const ids of Object.values(days)) {
      if (Array.isArray(ids)) for (const id of ids) out.add(id as string);
    }
    return out;
  }

  getTask(id: string): Record<string, unknown> | undefined {
    return this._bucket('TASK')[id];
  }

  listProjects(): Record<string, unknown>[] {
    return Object.values(this._bucket('PROJECT'));
  }

  listTags(): Record<string, unknown>[] {
    return Object.values(this._bucket('TAG'));
  }

  getConfig(): Record<string, unknown> {
    return this._bucket('GLOBAL_CONFIG');
  }

  listTaskRepeatCfgs(): Record<string, unknown>[] {
    return Object.values(this._bucket('TASK_REPEAT_CFG'));
  }

  /** PLANNER board: { [YYYY-MM-DD]: taskId[] } future-day scheduling. */
  getPlanner(): Record<string, unknown> {
    return asRecord(this.store.state.PLANNER?.days);
  }

  /**
   * The "current task" is device-local UI state ([Task] SetCurrentTask is
   * non-persistent and never syncs), so a headless peer has none by design.
   * Reported honestly rather than faked.
   */
  getCurrentTask(): Record<string, unknown> {
    return {
      currentTask: null,
      note: 'No active task: the headless bridge tracks no running timer (current-task selection is device-local, non-synced UI state).',
    };
  }

  /**
   * Worklog: aggregates task.timeSpentOnDay across tasks, optionally bounded
   * by [from, to] (YYYY-MM-DD, inclusive).
   */
  getWorklog(from?: string, to?: string): Record<string, unknown> {
    const byDay: Record<
      string,
      {
        totalTimeSpent: number;
        tasks: { id: string; title: unknown; timeSpent: number }[];
      }
    > = {};
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
  listEntityTypes(): string[] {
    return Object.keys(this.store.state);
  }

  rawEntities(type: string): Record<string, unknown> | undefined {
    return this.store.state[type];
  }

  // ── Writes ────────────────────────────────────────────────────────────────
  // Every write is a real sync op (cloned from live client op shapes), uploaded
  // to the server and round-tripped back through refresh() — the bridge state
  // you read after a write is what every other client will materialize.

  async createTask(input: NewTaskInput): Promise<Record<string, unknown>> {
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
    return this.getTask(task.id as string) ?? task;
  }

  /**
   * Validates a single task update and returns the op WITHOUT submitting it, so
   * both updateTask (one op) and bulkUpdate (many ops, one upload) share the
   * exact same validation + op shape.
   */
  private async _buildUpdateOp(id: string, changes: Record<string, unknown>) {
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

  async updateTask(
    id: string,
    changes: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const op = await this._buildUpdateOp(id, changes);
    await this.store.submitOps([op]);
    return this.getTask(id) ?? {};
  }

  /**
   * Applies per-task updates as N ops in a single upload+refresh. Every id is
   * validated up front — if any is unknown or has an illegal field, nothing is
   * submitted (all-or-nothing), so a bad item never partially applies.
   */
  async bulkUpdate(
    updates: { id: string; changes: Record<string, unknown> }[],
  ): Promise<Record<string, unknown>[]> {
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
  async bulkComplete(ids: string[]): Promise<{ completed: string[] }> {
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

  async completeTask(id: string): Promise<Record<string, unknown>> {
    return this.updateTask(id, { isDone: true, doneOn: Date.now() });
  }

  async deleteTask(id: string): Promise<{ deleted: string }> {
    const existing = this.getTask(id);
    if (!existing) {
      throw Object.assign(new Error('Task not found'), { statusCode: 404 });
    }
    // Count only subtasks that still exist — stale ids (children already
    // deleted) must not block deleting the parent.
    const liveSubtasks = (
      Array.isArray(existing.subTaskIds) ? (existing.subTaskIds as string[]) : []
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
  async completeTaskOn(id: string, doneOnDate: string): Promise<Record<string, unknown>> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(doneOnDate)) {
      throw err('doneOn must be YYYY-MM-DD', 400);
    }
    const doneOn = new Date(`${doneOnDate}T12:00:00`).getTime();
    return this.updateTask(id, { isDone: true, doneOn });
  }

  /** Adds a tag to a task, preserving its other tags (the Kanban column move). */
  async addTagToTask(id: string, tagId: string): Promise<Record<string, unknown>> {
    const task = this.getTask(id);
    if (!task) throw err('Task not found', 404);
    if (!this._bucket('TAG')[tagId] && tagId !== TODAY_TAG_ID) {
      throw err(`Unknown tagId: ${tagId}`, 400);
    }
    const current = Array.isArray(task.tagIds) ? (task.tagIds as string[]) : [];
    if (current.includes(tagId)) return task; // idempotent
    return this.updateTask(id, { tagIds: [...current, tagId] });
  }

  /** Removes a tag from a task, preserving its other tags. */
  async removeTagFromTask(id: string, tagId: string): Promise<Record<string, unknown>> {
    const task = this.getTask(id);
    if (!task) throw err('Task not found', 404);
    const current = Array.isArray(task.tagIds) ? (task.tagIds as string[]) : [];
    if (!current.includes(tagId)) return task; // idempotent
    return this.updateTask(id, { tagIds: current.filter((t) => t !== tagId) });
  }

  /** Moves a top-level task to another project (errors on subtasks). */
  async moveTaskToProject(
    id: string,
    projectId: string,
  ): Promise<Record<string, unknown>> {
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
  async createSubTask(
    parentId: string,
    input: NewTaskInput,
  ): Promise<Record<string, unknown>> {
    if (!input.title || typeof input.title !== 'string') {
      throw err('title (string) is required', 400);
    }
    const parent = this.getTask(parentId);
    if (!parent) throw err(`Unknown parentId: ${parentId}`, 400);
    if (parent.parentId) throw err('Cannot nest a subtask under another subtask', 400);
    const task = buildTaskEntity({
      ...input,
      parentId,
      projectId: parent.projectId as string | undefined,
    });
    const op = await this.ops.addSubTask(task, parentId, this.store.nextWriteClock());
    await this.store.submitOps([op]);
    return this.getTask(task.id as string) ?? task;
  }

  /** Creates a parent task plus its subtasks in one upload. */
  async createTaskWithSubtasks(
    input: NewTaskInput,
    subTaskTitles: string[],
  ): Promise<Record<string, unknown>> {
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
        parentId: parent.id as string,
        projectId: parent.projectId as string | undefined,
      });
      ops.push(
        await this.ops.addSubTask(sub, parent.id as string, this.store.nextWriteClock()),
      );
    }
    await this.store.submitOps(ops);
    return this.getTask(parent.id as string) ?? parent;
  }

  /**
   * Reparents a task: pass a parentId to nest it, or null/'' to promote it to a
   * top-level task. A task with its own subtasks cannot become a subtask.
   */
  async reparentTask(
    taskId: string,
    newParentId: string | null,
  ): Promise<Record<string, unknown>> {
    const task = this.getTask(taskId);
    if (!task) throw err('Task not found', 404);

    if (!newParentId) {
      // Promote to main task.
      if (!task.parentId) throw err('Task is already a top-level task', 400);
      const op = await this.ops.convertToMainTask(task, this.store.nextWriteClock());
      await this.store.submitOps([op]);
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
  async reorderTasks(
    container: { projectId?: string; parentId?: string; today?: boolean },
    taskIds: string[],
  ): Promise<{ reordered: string[] }> {
    if (!Array.isArray(taskIds) || taskIds.length === 0) {
      throw err('taskIds must be a non-empty array', 400);
    }
    const targets = [container.projectId, container.parentId, container.today].filter(
      (v) => v !== undefined && v !== false,
    );
    if (targets.length !== 1) {
      throw err('specify exactly one of projectId, parentId, or today', 400);
    }

    let current: string[];
    let op;
    if (container.projectId) {
      const project = this._bucket('PROJECT')[container.projectId];
      if (!project) throw err(`Unknown projectId: ${container.projectId}`, 400);
      current = Array.isArray(project.taskIds) ? (project.taskIds as string[]) : [];
      this._assertPermutation(current, taskIds);
      op = await this.ops.updateProject(
        container.projectId,
        { taskIds },
        this.store.nextWriteClock(),
      );
    } else if (container.parentId) {
      const parent = this.getTask(container.parentId);
      if (!parent) throw err(`Unknown parentId: ${container.parentId}`, 400);
      current = Array.isArray(parent.subTaskIds) ? (parent.subTaskIds as string[]) : [];
      this._assertPermutation(current, taskIds);
      op = await this.ops.updateTask(
        container.parentId,
        { subTaskIds: taskIds },
        this.store.nextWriteClock(),
      );
    } else {
      const today = this._bucket('TAG')[TODAY_TAG_ID];
      current = today && Array.isArray(today.taskIds) ? (today.taskIds as string[]) : [];
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

  private _assertPermutation(current: string[], proposed: string[]): void {
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
  async planTasksForToday(
    taskIds: string[],
    today?: string,
  ): Promise<{ planned: string[] }> {
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
  async removeTasksFromToday(taskIds: string[]): Promise<{ removed: string[] }> {
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
  async addLinkToTask(
    taskId: string,
    url: string,
    title?: string,
  ): Promise<Record<string, unknown>> {
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
  async linkTaskToIssue(
    taskId: string,
    link: {
      issueId?: string;
      issueType?: string;
      issueProviderId?: string;
      issuePoints?: number;
    },
  ): Promise<Record<string, unknown>> {
    if (!this.getTask(taskId)) throw err('Task not found', 404);
    if (!link.issueId || !link.issueType || !link.issueProviderId) {
      throw err('issueId, issueType and issueProviderId are all required', 400);
    }
    if (!this._bucket('ISSUE_PROVIDER')[link.issueProviderId]) {
      throw err(`Unknown issueProviderId: ${link.issueProviderId}`, 400);
    }
    const changes: Record<string, unknown> = {
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
  async createTaskFromShortSyntax(
    text: string,
    defaultProjectId?: string,
  ): Promise<Record<string, unknown>> {
    if (!text || typeof text !== 'string' || !text.trim()) {
      throw err('text (non-empty string) is required', 400);
    }
    const parsed = this._parseShortSyntax(text);
    if (!parsed.title) throw err('short-syntax has no title text', 400);

    // Resolve project by title (case-insensitive); unknown project is an error.
    let projectId = defaultProjectId;
    if (parsed.projectName) {
      const match = this.listProjects().find(
        (p) => String(p.title ?? '').toLowerCase() === parsed.projectName!.toLowerCase(),
      );
      if (!match) throw err(`Unknown project: +${parsed.projectName}`, 400);
      projectId = match.id as string;
    }

    // Resolve tags by title; create any that don't exist yet.
    const tagIds: string[] = [];
    for (const name of parsed.tagNames) {
      const existing = this.listTags().find(
        (t) => String(t.title ?? '').toLowerCase() === name.toLowerCase(),
      );
      if (existing) {
        tagIds.push(existing.id as string);
      } else {
        const created = await this.createTag({ title: name });
        tagIds.push(created.id as string);
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

  private _parseShortSyntax(text: string): {
    title: string;
    tagNames: string[];
    projectName: string | null;
    dueDay?: string;
    timeEstimate?: number;
  } {
    const tagNames: string[] = [];
    let projectName: string | null = null;
    let dueDay: string | undefined;
    let timeEstimate: number | undefined;
    const titleParts: string[] = [];

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

  private _parseDueToken(v: string): string | undefined {
    const lower = v.toLowerCase();
    if (lower === 'today') return localToday();
    if (lower === 'tomorrow') {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      return d.toLocaleDateString('en-CA');
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
    return undefined;
  }

  private _parseDurationToken(v: string): number | null {
    const m = /^(?:(\d+)h)?(?:(\d+)m(?:in)?)?$/.exec(v);
    if (!m || (!m[1] && !m[2])) return null;
    const hours = m[1] ? parseInt(m[1], 10) : 0;
    const mins = m[2] ? parseInt(m[2], 10) : 0;
    return hours * 3600000 + mins * 60000;
  }

  // ── Tags ────────────────────────────────────────────────────────────────────

  async createTag(input: NewTagInput): Promise<Record<string, unknown>> {
    if (!input.title || typeof input.title !== 'string') {
      throw err('title (string) is required', 400);
    }
    const tag = buildTagEntity(input);
    const op = await this.ops.addTag(tag, this.store.nextWriteClock());
    await this.store.submitOps([op]);
    return this._bucket('TAG')[tag.id as string] ?? tag;
  }

  async updateTag(
    id: string,
    changes: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const existing = this._bucket('TAG')[id];
    if (!existing) throw err('Tag not found', 404);
    const bad = Object.keys(changes).filter((k) => !ALLOWED_TAG_FIELDS.has(k));
    if (bad.length) throw err(`Field(s) not writable: ${bad.join(', ')}`, 400);
    // Keep theme.primary in sync when color changes so the UI recolors.
    const applied: Record<string, unknown> = { ...changes };
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

  async deleteTag(id: string): Promise<{ deleted: string }> {
    if (id === TODAY_TAG_ID)
      throw err('The TODAY tag is virtual and cannot be deleted', 400);
    if (!this._bucket('TAG')[id]) throw err('Tag not found', 404);
    const op = await this.ops.deleteTag(id, this.store.nextWriteClock());
    await this.store.submitOps([op]);
    return { deleted: id };
  }

  // ── Projects ────────────────────────────────────────────────────────────────

  async createProject(input: NewProjectInput): Promise<Record<string, unknown>> {
    if (!input.title || typeof input.title !== 'string') {
      throw err('title (string) is required', 400);
    }
    const project = buildProjectEntity(input);
    const op = await this.ops.addProject(project, this.store.nextWriteClock());
    await this.store.submitOps([op]);
    return this._bucket('PROJECT')[project.id as string] ?? project;
  }

  async updateProject(
    id: string,
    changes: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
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
  async deleteProject(id: string): Promise<{ deleted: string; taskCount: number }> {
    if (id === 'INBOX_PROJECT') throw err('The Inbox project cannot be deleted', 400);
    const project = this._bucket('PROJECT')[id];
    if (!project) throw err('Project not found', 404);

    // Authoritative task set: every task whose projectId is this project
    // (subtasks inherit the parent's projectId, so this captures them too) —
    // robust even if the project's ordering lists are stale.
    const allTaskIds = Object.values(this._bucket('TASK'))
      .filter((t) => t.projectId === id)
      .map((t) => t.id as string);
    const noteIds = Array.isArray(project.noteIds) ? (project.noteIds as string[]) : [];
    const op = await this.ops.deleteProject(
      id,
      noteIds,
      allTaskIds,
      this.store.nextWriteClock(),
    );
    await this.store.submitOps([op]);
    return { deleted: id, taskCount: allTaskIds.length };
  }

  // ── Boards ──────────────────────────────────────────────────────────────────
  // Boards are one `{ boardCfgs: [] }` record rather than an id-keyed map, so
  // these read and write the array directly instead of going through _bucket().
  // Panels have no create/update actions of their own — the app edits a panel by
  // replacing the parent board's whole `panels` array, and so do we.

  private _boardCfgs(): Record<string, unknown>[] {
    const board = (this.store.state.BOARD ?? {}) as Record<string, unknown>;
    return Array.isArray(board.boardCfgs)
      ? (board.boardCfgs as Record<string, unknown>[])
      : [];
  }

  listBoards(): Record<string, unknown>[] {
    return this._boardCfgs();
  }

  getBoard(id: string): Record<string, unknown> | undefined {
    return this._boardCfgs().find((b) => b.id === id);
  }

  private _requireBoard(id: string): Record<string, unknown> {
    const board = this.getBoard(id);
    if (!board) throw err('Board not found', 404);
    return board;
  }

  private _panelsOf(board: Record<string, unknown>): Record<string, unknown>[] {
    return Array.isArray(board.panels) ? (board.panels as Record<string, unknown>[]) : [];
  }

  async createBoard(input: NewBoardInput): Promise<Record<string, unknown>> {
    if (!input.title || typeof input.title !== 'string') {
      throw err('title (string) is required', 400);
    }
    if (input.id && this.getBoard(input.id)) {
      throw err(`Board already exists: ${input.id}`, 409);
    }
    const board = buildBoardEntity(input);
    const op = await this.ops.addBoard(board, this.store.nextWriteClock());
    await this.store.submitOps([op]);
    return this.getBoard(board.id as string) ?? board;
  }

  async updateBoard(
    id: string,
    updates: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    this._requireBoard(id);
    const bad = Object.keys(updates).filter((k) => !ALLOWED_BOARD_FIELDS.has(k));
    if (bad.length) throw err(`Field(s) not writable: ${bad.join(', ')}`, 400);
    if (Object.keys(updates).length === 0) throw err('No changes given', 400);
    const op = await this.ops.updateBoard(id, updates, this.store.nextWriteClock());
    await this.store.submitOps([op]);
    return this._requireBoard(id);
  }

  async deleteBoard(id: string): Promise<{ deleted: string }> {
    this._requireBoard(id);
    const op = await this.ops.removeBoard(id, this.store.nextWriteClock());
    await this.store.submitOps([op]);
    return { deleted: id };
  }

  /**
   * Reorders boards. The id list must name every board: a partial one is far
   * more likely to be a caller bug than an intent to shuffle a subset, and the
   * reducer would silently park the omitted boards at the tail.
   */
  async sortBoards(ids: string[]): Promise<Record<string, unknown>[]> {
    if (!Array.isArray(ids) || ids.length === 0) {
      throw err('ids (string[]) is required', 400);
    }
    const known = new Set(this._boardCfgs().map((b) => b.id as string));
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length) throw err(`Unknown board id(s): ${unknown.join(', ')}`, 400);
    if (ids.length !== known.size) {
      throw err(`ids must list all ${known.size} boards (got ${ids.length})`, 400);
    }
    const op = await this.ops.sortBoards(ids, this.store.nextWriteClock());
    await this.store.submitOps([op]);
    return this.listBoards();
  }

  async addPanel(
    boardId: string,
    input: NewPanelInput,
  ): Promise<Record<string, unknown>> {
    if (!input.title || typeof input.title !== 'string') {
      throw err('title (string) is required', 400);
    }
    const board = this._requireBoard(boardId);
    const panels = this._panelsOf(board);
    if (input.id && panels.some((p) => p.id === input.id)) {
      throw err(`Panel already exists on this board: ${input.id}`, 409);
    }
    const panel = buildPanelEntity(input);
    // `cols` grows with the panel count so a new column is actually visible
    // rather than wrapping under the existing ones.
    await this.updateBoard(boardId, {
      panels: [...panels, panel],
      cols: Math.max(Number(board.cols) || 0, panels.length + 1),
    });
    return panel;
  }

  async updatePanel(
    boardId: string,
    panelId: string,
    changes: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const board = this._requireBoard(boardId);
    const panels = this._panelsOf(board);
    const existing = panels.find((p) => p.id === panelId);
    if (!existing) throw err('Panel not found', 404);
    const bad = Object.keys(changes).filter((k) => !ALLOWED_PANEL_FIELDS.has(k));
    if (bad.length) throw err(`Field(s) not writable: ${bad.join(', ')}`, 400);
    if (Object.keys(changes).length === 0) throw err('No changes given', 400);
    await this.updateBoard(boardId, {
      panels: panels.map((p) => (p.id === panelId ? { ...p, ...changes } : p)),
    });
    return this._panelsOf(this._requireBoard(boardId)).find((p) => p.id === panelId)!;
  }

  async removePanel(boardId: string, panelId: string): Promise<{ deleted: string }> {
    const board = this._requireBoard(boardId);
    const panels = this._panelsOf(board);
    if (!panels.some((p) => p.id === panelId)) throw err('Panel not found', 404);
    const remaining = panels.filter((p) => p.id !== panelId);
    await this.updateBoard(boardId, {
      panels: remaining,
      cols: Math.max(remaining.length, 1),
    });
    return { deleted: panelId };
  }

  /** Manual card order within one panel. Panel ids are unique across boards. */
  async setPanelTaskIds(
    panelId: string,
    taskIds: string[],
  ): Promise<Record<string, unknown>> {
    if (!Array.isArray(taskIds)) throw err('taskIds (string[]) is required', 400);
    const board = this._boardCfgs().find((b) =>
      this._panelsOf(b).some((p) => p.id === panelId),
    );
    if (!board) throw err('Panel not found', 404);
    const unknown = taskIds.filter((id) => !this.getTask(id));
    if (unknown.length) throw err(`Unknown task id(s): ${unknown.join(', ')}`, 400);
    const op = await this.ops.updatePanelTaskIds(
      panelId,
      taskIds,
      this.store.nextWriteClock(),
    );
    await this.store.submitOps([op]);
    return this._panelsOf(this._requireBoard(board.id as string)).find(
      (p) => p.id === panelId,
    )!;
  }

  status(): Record<string, unknown> {
    const counts: Record<string, number> = {};
    for (const [type, entities] of Object.entries(this.store.state)) {
      if (type === 'BOARD') {
        // Not an entity map: counting keys of the `{ boardCfgs }` wrapper
        // reported 1 however many boards existed.
        counts[type] = this._boardCfgs().length;
        continue;
      }
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
}

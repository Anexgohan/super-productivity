/**
 * BridgeCore — the single service layer every external surface consumes.
 * The REST API is the canonical, full-featured interface (by design there is
 * no MCP layer; agents consume the API directly).
 */
import type { StateStore } from './state-store';
import {
  ALLOWED_TASK_FIELDS,
  buildTaskEntity,
  OpFactory,
  type NewTaskInput,
} from './op-factory';

export interface TaskFilter {
  isDone?: boolean;
  projectId?: string;
  tagId?: string;
  search?: string;
  dueDay?: string;
  parentId?: string | null;
}

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
          String(t.title ?? '').toLowerCase().includes(q) ||
          String(t.notes ?? '').toLowerCase().includes(q),
      );
    }
    return tasks;
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

  /**
   * Worklog: aggregates task.timeSpentOnDay across tasks, optionally bounded
   * by [from, to] (YYYY-MM-DD, inclusive).
   */
  getWorklog(from?: string, to?: string): Record<string, unknown> {
    const byDay: Record<
      string,
      { totalTimeSpent: number; tasks: { id: string; title: unknown; timeSpent: number }[] }
    > = {};
    for (const [id, task] of Object.entries(this._bucket('TASK'))) {
      const spent = asRecord(task.timeSpentOnDay);
      for (const [day, ms] of Object.entries(spent)) {
        if (typeof ms !== 'number' || ms <= 0) continue;
        if (from && day < from) continue;
        if (to && day > to) continue;
        (byDay[day] ??= { totalTimeSpent: 0, tasks: [] });
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

  async updateTask(
    id: string,
    changes: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const existing = this.getTask(id);
    if (!existing) {
      throw Object.assign(new Error('Task not found'), { statusCode: 404 });
    }
    const rejected = Object.keys(changes).filter((k) => !ALLOWED_TASK_FIELDS.has(k));
    if (rejected.length > 0) {
      throw Object.assign(
        new Error(`Field(s) not writable via API: ${rejected.join(', ')}`),
        { statusCode: 400 },
      );
    }
    if (Object.keys(changes).length === 0) {
      throw Object.assign(new Error('No changes given'), { statusCode: 400 });
    }
    const op = await this.ops.updateTask(id, changes, this.store.nextWriteClock());
    await this.store.submitOps([op]);
    return this.getTask(id) ?? existing;
  }

  async completeTask(id: string): Promise<Record<string, unknown>> {
    return this.updateTask(id, { isDone: true, doneOn: Date.now() });
  }

  async deleteTask(id: string): Promise<{ deleted: string }> {
    const existing = this.getTask(id);
    if (!existing) {
      throw Object.assign(new Error('Task not found'), { statusCode: 404 });
    }
    if (Array.isArray(existing.subTaskIds) && existing.subTaskIds.length > 0) {
      throw Object.assign(
        new Error('Task has subtasks; delete them first (safety guard)'),
        { statusCode: 409 },
      );
    }
    const op = await this.ops.deleteTask(existing, this.store.nextWriteClock());
    await this.store.submitOps([op]);
    return { deleted: id };
  }

  status(): Record<string, unknown> {
    const counts: Record<string, number> = {};
    for (const [type, entities] of Object.entries(this.store.state)) {
      counts[type] =
        entities && typeof entities === 'object' ? Object.keys(entities).length : 0;
    }
    return {
      lastServerSeq: this.store.lastServerSeq,
      lastSyncAt: this.store.lastSyncAt,
      lastError: this.store.lastError,
      entityCounts: counts,
    };
  }
}

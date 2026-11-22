/**
 * Stage 3 app actions (anex/app-actions) end to end in the built worker, with the friendly routes that now build them.
 * Synthetic data only.
 */
import { describe, expect, it } from 'vitest';
import { buildProjectEntity, buildTaskEntity } from '../src/op-factory';
import type { BridgeCore } from '../src/core';
import {
  actionPayloadOf,
  browser,
  FakeSync,
  lastUpload,
  nextClock,
  seedTasks,
  setConfigSection,
  startCore,
  tasksOf,
  useActionWorker,
  type Row,
} from './app-actions-harness';

useActionWorker();

const MIN = 60_000;
const M15 = 15 * MIN;

/** A local time as the ISO string a caller sends. */
const localIso = (y: number, m: number, d: number, h: number, min = 0): string =>
  new Date(y, m - 1, d, h, min).toISOString();

const localDay = (ms: number): string => new Date(ms).toLocaleDateString('en-CA');

const typesOf = (ops: Row[]): unknown[] => ops.map((op) => op.actionType);

const sectionsOf = (core: BridgeCore): Record<string, Row> =>
  ((core as unknown as { store: { state: Row } }).store.state.SECTION ?? {}) as Record<
    string,
    Row
  >;

/** A project with two tasks in it, written by a browser. */
const seedProject = async (
  sync: FakeSync,
  title = 'project',
): Promise<{ projectId: string; taskIds: string[] }> => {
  const project = buildProjectEntity({ title });
  sync.push(await browser.addProject(project, nextClock()));
  const taskIds: string[] = [];
  for (const t of ['one', 'two']) {
    const task = buildTaskEntity({
      title: `${title} ${t}`,
      projectId: project.id as string,
    });
    sync.push(await browser.addTask(task, nextClock()));
    taskIds.push(task.id as string);
  }
  return { projectId: project.id as string, taskIds };
};

describe('settings', () => {
  it('saves only the fields given, and leaves the section’s others alone', async () => {
    const sync = new FakeSync();
    await seedTasks(sync);
    const { core } = await startCore(sync);
    const before = core.getConfig().tasks as Row;

    await core.act('updateGlobalConfigSection', {
      sectionKey: 'tasks',
      changes: { isAutoMarkParentAsDone: true },
    });

    const ops = await lastUpload(sync);
    expect(ops.map((op) => [op.actionType, op.entityType, op.entityId])).toEqual([
      ['[Global Config] Update Global Config Section', 'GLOBAL_CONFIG', 'tasks'],
    ]);
    expect(actionPayloadOf(ops[0])).toEqual({
      sectionKey: 'tasks',
      sectionCfg: { isAutoMarkParentAsDone: true },
    });
    expect(core.getConfig().tasks).toEqual({ ...before, isAutoMarkParentAsDone: true });
  });

  it('moves the old today’s tasks to the new today when the start of the day moves', async () => {
    const sync = new FakeSync();
    const { otherId, parentId } = await seedTasks(sync);
    sync.push(await browser.updateTask(otherId, { dueDay: '2031-03-03' }, nextClock()));
    const { core } = await startCore(sync);

    await core.act(
      'updateGlobalConfigSection',
      {
        sectionKey: 'misc',
        changes: { startOfNextDayTime: '12:00', startOfNextDay: 12 },
      },
      { now: localIso(2031, 3, 3, 10) },
    );

    const ops = await lastUpload(sync);
    expect(typesOf(ops)).toEqual([
      '[Global Config] Update Global Config Section',
      '[Task Shared] updateTasks',
    ]);
    expect(actionPayloadOf(ops[1]).tasks).toEqual([
      { id: otherId, changes: { dueDay: '2031-03-02' } },
    ]);
    expect(core.getTask(otherId)).toMatchObject({ dueDay: '2031-03-02' });
    expect(core.getTask(parentId)?.dueDay).toBeUndefined();
  });

  it('refuses the sync section, UI preferences, unknown keys and wrong types, uploading nothing', async () => {
    const sync = new FakeSync();
    await seedTasks(sync);
    const { core } = await startCore(sync);
    const refused = (sectionKey: string, changes: Row): Promise<unknown> =>
      core.act('updateGlobalConfigSection', { sectionKey, changes });

    await expect(refused('sync', { isEnabled: false })).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(refused('misc', { uiPrefs: {} })).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(refused('tasks', { noSuchSetting: true })).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(refused('noSuchSection', { a: 1 })).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(
      refused('tasks', { isAutoMarkParentAsDone: 'yes' }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(sync.uploads).toEqual([]);
  });
});

describe('archive', () => {
  it('archives a parent with its subtask, then restores both', async () => {
    const sync = new FakeSync();
    const { parentId, subId } = await seedTasks(sync);
    const { store, core } = await startCore(sync);

    await core.act('moveToArchive', { taskIds: [parentId] });

    let ops = await lastUpload(sync);
    expect(ops.map((op) => [op.actionType, op.entityIds])).toEqual([
      ['[Task Shared] moveToArchive', [parentId]],
    ]);
    const archived = actionPayloadOf(ops[0]).tasks as Row[];
    expect(archived.map((t) => [t.id, (t.subTasks as Row[]).map((s) => s.id)])).toEqual([
      [parentId, [subId]],
    ]);
    expect(tasksOf(store)[parentId]).toBeUndefined();
    expect(tasksOf(store)[subId]).toBeUndefined();
    expect(core.getArchiveTask(parentId)).toBeDefined();
    expect(core.getArchiveTask(subId)).toBeDefined();

    await core.act('restoreTask', { taskId: parentId });

    ops = await lastUpload(sync);
    expect(typesOf(ops)).toEqual(['[Task Shared] restoreTask']);
    expect((actionPayloadOf(ops[0]).subTasks as Row[]).map((t) => t.id)).toEqual([subId]);
    expect(tasksOf(store)[parentId]).toMatchObject({
      isDone: false,
      subTaskIds: [subId],
    });
    expect(tasksOf(store)[subId]).toMatchObject({ parentId });
    expect(core.getArchiveTask(parentId)).toBeUndefined();
  });

  it('refuses a subtask, an unknown id and a restore of a live task, uploading nothing', async () => {
    const sync = new FakeSync();
    const { parentId, subId } = await seedTasks(sync);
    const { core } = await startCore(sync);

    await expect(core.act('moveToArchive', { taskIds: [subId] })).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(core.act('moveToArchive', { taskIds: ['nope'] })).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(core.act('restoreTask', { taskId: 'nope' })).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(core.act('restoreTask', { taskId: parentId })).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(sync.uploads).toEqual([]);
  });
});

describe('scheduling', () => {
  it('schedules with the board’s default reminder, and a reschedule keeps the reminder’s offset', async () => {
    const sync = new FakeSync();
    const { otherId } = await seedTasks(sync);
    const { core } = await startCore(sync);
    const at = localIso(2031, 3, 3, 15);

    await core.act('scheduleTaskWithTime', { taskId: otherId, at });

    let payload = actionPayloadOf((await lastUpload(sync))[0]);
    expect(payload).toMatchObject({
      dueWithTime: Date.parse(at),
      remindAt: Date.parse(at),
      isMoveToBacklog: false,
    });
    expect(core.getTask(otherId)).toMatchObject({ dueWithTime: Date.parse(at) });

    await core.act('scheduleTaskWithTime', { taskId: otherId, at, remind: 'm15' });
    const later = localIso(2031, 3, 4, 9);
    await core.act('scheduleTaskWithTime', { taskId: otherId, at: later });

    payload = actionPayloadOf((await lastUpload(sync))[0]);
    expect(payload).toMatchObject({
      dueWithTime: Date.parse(later),
      remindAt: Date.parse(later) - M15,
    });
  });

  it('plans for today on the caller’s day, with the app’s payload, through the today route', async () => {
    const sync = new FakeSync();
    const { parentId, subId } = await seedTasks(sync);
    const { core } = await startCore(sync);

    await core.planTasksForToday([subId], '2031-03-04');

    const ops = await lastUpload(sync);
    expect(typesOf(ops)).toEqual(['[Task Shared] planTasksForToday']);
    expect(actionPayloadOf(ops[0])).toMatchObject({
      taskIds: [subId],
      today: '2031-03-04',
      startOfNextDayDiffMs: 0,
      parentTaskMap: { [subId]: parentId },
    });

    await core.planTasksForToday([subId]);
    expect(actionPayloadOf((await lastUpload(sync))[0]).today).toBe(localDay(Date.now()));
  });

  it('carries the day a deadline due today plans the task for', async () => {
    const sync = new FakeSync();
    const { otherId } = await seedTasks(sync);
    const { core } = await startCore(sync);

    await core.act(
      'setDeadline',
      { taskId: otherId, day: '2031-03-03' },
      { today: '2031-03-03' },
    );

    expect(actionPayloadOf((await lastUpload(sync))[0])).toMatchObject({
      taskId: otherId,
      deadlineDay: '2031-03-03',
      autoPlanToday: '2031-03-03',
      autoPlanStartOfNextDayDiffMs: 0,
    });
  });

  it('builds nothing for a task already planned for that day', async () => {
    const sync = new FakeSync();
    const { otherId } = await seedTasks(sync);
    const { core } = await startCore(sync);

    await core.act('planTaskForDay', { taskId: otherId, day: '2031-03-05' });
    expect(core.getTask(otherId)).toMatchObject({ dueDay: '2031-03-05' });
    const res = await core.act('planTaskForDay', { taskId: otherId, day: '2031-03-05' });

    expect(res.opIds).toEqual([]);
    expect(sync.uploads).toHaveLength(1);
  });
});

describe('logged time', () => {
  it('logs time as additive ops that every device adds up', async () => {
    const sync = new FakeSync();
    const { otherId } = await seedTasks(sync);
    const { core } = await startCore(sync);

    await core.act('logTime', {
      taskId: otherId,
      date: '2026-11-20',
      duration: 30 * MIN,
    });
    await core.act('logTime', {
      taskId: otherId,
      date: '2026-11-20',
      duration: 10 * MIN,
    });

    const ops = await lastUpload(sync);
    expect(typesOf(ops)).toEqual(['[TimeTracking] Sync time spent']);
    expect(actionPayloadOf(ops[0])).toMatchObject({
      taskId: otherId,
      date: '2026-11-20',
      duration: 10 * MIN,
    });
    expect(core.getTask(otherId)).toMatchObject({
      timeSpent: 40 * MIN,
      timeSpentOnDay: { '2026-11-20': 40 * MIN },
    });
  });

  it('shows the logged time to the rest of the build', async () => {
    const sync = new FakeSync();
    const { otherId } = await seedTasks(sync);
    const { store } = await startCore(sync);

    const res = await store.buildActions(
      [
        {
          name: 'logTime',
          input: { taskId: otherId, date: '2026-11-20', duration: MIN },
        },
        {
          name: 'removeTimeSpent',
          input: { taskId: otherId, date: '2026-11-20', duration: MIN },
        },
      ],
      {},
    );

    expect(res.ops.map((op) => op.actionType)).toEqual([
      '[TimeTracking] Sync time spent',
      '[Task] Remove time spent',
    ]);
  });

  it('refuses removing more than the day holds, and defaults the day to the caller’s', async () => {
    const sync = new FakeSync();
    const { otherId } = await seedTasks(sync);
    const { core } = await startCore(sync);

    await core.act(
      'logTime',
      { taskId: otherId, duration: 5 * MIN },
      { today: '2031-03-03' },
    );
    expect(actionPayloadOf((await lastUpload(sync))[0]).date).toBe('2031-03-03');

    await expect(
      core.act(
        'removeTimeSpent',
        { taskId: otherId, duration: 6 * MIN },
        { today: '2031-03-03' },
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(sync.uploads).toHaveLength(1);
  });
});

describe('many tasks', () => {
  it('edits many tasks as one op each, in one upload', async () => {
    const sync = new FakeSync();
    const { parentId, subId, otherId } = await seedTasks(sync);
    const { core } = await startCore(sync);
    const ids = [parentId, subId, otherId];

    await core.act('updateManyTasks', {
      updates: ids.map((taskId, i) => ({ taskId, changes: { title: `renamed ${i}` } })),
    });

    expect(sync.uploads).toHaveLength(1);
    const ops = await lastUpload(sync);
    expect(ops.map((op) => [op.actionType, op.entityId])).toEqual(
      ids.map((id) => ['[Task Shared] updateTask', id]),
    );
    ids.forEach((id, i) => expect(core.getTask(id)?.title).toBe(`renamed ${i}`));

    await expect(
      core.act('updateManyTasks', {
        updates: [
          { taskId: parentId, changes: { title: 'x' } },
          { taskId: 'nope', changes: { title: 'x' } },
        ],
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(sync.uploads).toHaveLength(1);
  });

  it('completes the parent when its last open subtasks are done together', async () => {
    const sync = new FakeSync();
    const { parentId, subId } = await seedTasks(sync);
    const sub2: Row = { ...buildTaskEntity({ title: 'sub 2' }), parentId };
    sync.push(await browser.addSubTask(sub2, parentId, nextClock()));
    await setConfigSection(sync, 'tasks', { isAutoMarkParentAsDone: true });
    const { core } = await startCore(sync);

    await core.act('updateManyTasks', {
      updates: [subId, sub2.id as string].map((taskId) => ({
        taskId,
        changes: { isDone: true },
      })),
    });

    const ops = await lastUpload(sync);
    expect(ops.map((op) => op.entityId)).toEqual([subId, sub2.id, parentId]);
    expect(core.getTask(parentId)).toMatchObject({ isDone: true });
  });

  it('drops the reminder of a task marked done, through the bulk complete route', async () => {
    const sync = new FakeSync();
    const { otherId, parentId } = await seedTasks(sync);
    const { core } = await startCore(sync);
    await core.act('scheduleTaskWithTime', {
      taskId: otherId,
      at: localIso(2031, 3, 3, 15),
    });

    await core.bulkComplete([otherId, parentId]);

    const ops = await lastUpload(sync);
    expect(ops.map((op) => [op.actionType, op.entityId])).toEqual([
      ['[Task Shared] updateTask', otherId],
      ['[Task Shared] dismissReminderOnly', otherId],
      ['[Task Shared] updateTask', parentId],
    ]);
    expect(core.getTask(otherId)).toMatchObject({ isDone: true });
    expect(core.getTask(otherId)?.remindAt).toBeUndefined();
  });
});

describe('sections', () => {
  it('adds a section, moves a task through two sections and out, and deletes it', async () => {
    const sync = new FakeSync();
    await seedTasks(sync);
    const { projectId, taskIds } = await seedProject(sync);
    const [t, u] = taskIds;
    const { core } = await startCore(sync);

    const a = (await core.act('addSection', { title: ' A ', projectId })).refs.sectionId;
    const b = (await core.act('addSection', { title: 'B', projectId })).refs.sectionId;
    expect(sectionsOf(core)[a]).toMatchObject({
      title: 'A',
      contextId: projectId,
      contextType: 'PROJECT',
      taskIds: [],
    });

    await core.act('addTaskToSection', { sectionId: a, taskId: t });
    await core.act('addTaskToSection', { sectionId: a, taskId: u });
    expect(sectionsOf(core)[a].taskIds).toEqual([t, u]);
    await core.act('addTaskToSection', { sectionId: b, taskId: t });

    expect(actionPayloadOf((await lastUpload(sync))[0])).toMatchObject({
      sectionId: b,
      taskId: t,
      afterTaskId: null,
      sourceSectionId: a,
    });
    expect(sectionsOf(core)[a].taskIds).toEqual([u]);
    expect(sectionsOf(core)[b].taskIds).toEqual([t]);

    await core.act('updateSection', { sectionId: b, title: 'B2' });
    expect(sectionsOf(core)[b].title).toBe('B2');
    await core.act('removeTaskFromSection', { sectionId: b, taskId: t });
    expect(sectionsOf(core)[b].taskIds).toEqual([]);
    await core.act('deleteSection', { sectionId: a });
    expect(sectionsOf(core)[a]).toBeUndefined();
    expect(sync.uploads.every((ops) => ops.length === 1)).toBe(true);
  });

  it('refuses a tag’s section, another project’s task and an unknown section, uploading nothing', async () => {
    const sync = new FakeSync();
    await seedTasks(sync);
    const p = await seedProject(sync, 'p');
    const q = await seedProject(sync, 'q');
    const { core } = await startCore(sync);
    const a = (await core.act('addSection', { title: 'A', projectId: p.projectId })).refs
      .sectionId;
    const uploads = sync.uploads.length;

    await expect(
      core.act('addSection', { title: 'A', tagId: 'some-tag' }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      core.act('addTaskToSection', { sectionId: a, taskId: q.taskIds[0] }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      core.act('addTaskToSection', { sectionId: 'nope', taskId: p.taskIds[0] }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(sync.uploads).toHaveLength(uploads);
  });
});

describe('project archive', () => {
  it('archives and unarchives through the project route, reopening a completed project', async () => {
    const sync = new FakeSync();
    await seedTasks(sync);
    const { projectId } = await seedProject(sync);
    sync.push(await browser.updateProject(projectId, { isDone: true }, nextClock()));
    const { core } = await startCore(sync);
    const project = (): Row | undefined =>
      ((core as unknown as { store: { state: Row } }).store.state.PROJECT as Row)[
        projectId
      ] as Row | undefined;

    await core.updateProject(projectId, { isArchived: true });
    expect(typesOf(await lastUpload(sync))).toEqual(['[Project] Archive Project']);
    expect(project()).toMatchObject({ isArchived: true, isDone: true });

    await core.updateProject(projectId, { isArchived: false });
    expect(typesOf(await lastUpload(sync))).toEqual(['[Project] Unarchive Project']);
    expect(project()).toMatchObject({ isArchived: false, isDone: false });

    await expect(
      core.updateProject('INBOX_PROJECT', { isArchived: true }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(sync.uploads).toHaveLength(2);
  });
});

describe('task route', () => {
  it('builds each field’s own action and sends the plain fields after them, in one upload', async () => {
    const sync = new FakeSync();
    const { otherId } = await seedTasks(sync);
    const { core } = await startCore(sync);
    const doneOn = Date.parse(localIso(2031, 3, 1, 12));

    await core.updateTask(otherId, {
      title: 'edited',
      dueDay: '2031-03-05',
      timeSpent: 20 * MIN,
      doneOn,
    });

    expect(sync.uploads).toHaveLength(1);
    let ops = await lastUpload(sync);
    expect(typesOf(ops)).toEqual([
      '[Task Shared] updateTask',
      '[Planner] Plan Task for Day',
      '[TimeTracking] Sync time spent',
      '[Task Shared] updateTask',
    ]);
    expect(actionPayloadOf(ops[3])).toMatchObject({
      task: { id: otherId, changes: { doneOn } },
    });
    expect(core.getTask(otherId)).toMatchObject({
      title: 'edited',
      dueDay: '2031-03-05',
      timeSpent: 20 * MIN,
      doneOn,
    });

    await core.updateTask(otherId, { timeSpent: 5 * MIN, dueDay: null });
    ops = await lastUpload(sync);
    expect(typesOf(ops)).toEqual([
      '[Task Shared] unscheduleTask',
      '[Task] Remove time spent',
    ]);
    expect(core.getTask(otherId)).toMatchObject({ timeSpent: 5 * MIN });

    await expect(
      core.updateTask(otherId, { dueDay: '2031-03-05', dueWithTime: Date.now() }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(sync.uploads).toHaveLength(2);
  });
});

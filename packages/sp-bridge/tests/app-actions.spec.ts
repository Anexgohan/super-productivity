/**
 * App actions (anex/app-actions) end to end: built by the app's own code in the built worker, follow-ups included, uploaded to a fake sync
 * server and read back. Synthetic data only.
 */
import { describe, expect, it } from 'vitest';
import { buildTaskEntity } from '../src/op-factory';
import {
  browser,
  FakeSync,
  nextClock,
  plain,
  seedTasks,
  setTasksConfig,
  startCore,
  tasksOf,
  useActionWorker,
  type Row,
} from './app-actions-harness';

useActionWorker();

describe('app actions', () => {
  it('deletes tasks with their subtasks in one op, sending ids only', async () => {
    const sync = new FakeSync();
    const { parentId, subId, otherId } = await seedTasks(sync);
    const { store, core } = await startCore(sync);
    expect(Object.keys(tasksOf(store))).toEqual(
      expect.arrayContaining([parentId, subId, otherId]),
    );

    const res = await core.act('deleteTasks', { taskIds: [parentId, otherId] });

    expect(sync.uploads).toHaveLength(1);
    const [op] = await Promise.all(sync.uploads[0].map(plain));
    expect(sync.uploads[0]).toHaveLength(1);
    expect(res.opIds).toEqual([op.id]);
    expect(op).toMatchObject({
      actionType: '[Task Shared] deleteTasks',
      opType: 'DEL',
      clientId: expect.stringMatching(/^B_bridge-user-/),
      isPayloadEncrypted: true,
    });
    const actionPayload = (op.payload as Row).actionPayload as Row;
    expect(actionPayload.taskIds).toEqual([parentId, otherId]);
    expect(actionPayload).not.toHaveProperty('tasks');
    expect(op.entityIds).toEqual([parentId, otherId]);
    for (const id of [parentId, subId, otherId])
      expect(tasksOf(store)[id]).toBeUndefined();
  });

  it('uploads nothing when the build fails: an unknown task answers 404', async () => {
    const sync = new FakeSync();
    const { otherId } = await seedTasks(sync);
    const { core } = await startCore(sync);

    await expect(
      core.act('deleteTasks', { taskIds: [otherId, 'no-such-task'] }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(core.act('noSuchAction', {})).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      core.act('deleteTasks', { taskIds: [otherId], extra: 1 }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(sync.uploads).toEqual([]);
  });

  it("adds the app's follow-up: the last open subtask done completes its parent, in the same upload", async () => {
    const sync = new FakeSync();
    const { parentId, subId } = await seedTasks(sync);
    await setTasksConfig(sync, { isAutoMarkParentAsDone: true });
    const { store, core } = await startCore(sync);

    await core.act('updateTask', { taskId: subId, changes: { isDone: true } });

    expect(sync.uploads).toHaveLength(1);
    const ops = await Promise.all(sync.uploads[0].map(plain));
    expect(ops.map((op) => [op.actionType, op.entityId])).toEqual([
      ['[Task Shared] updateTask', subId],
      ['[Task Shared] updateTask', parentId],
    ]);
    expect(((ops[1].payload as Row).actionPayload as Row).task).toMatchObject({
      id: parentId,
      changes: { isDone: true },
    });
    expect(tasksOf(store)[parentId]).toMatchObject({ isDone: true });
    expect(tasksOf(store)[subId]).toMatchObject({ isDone: true });
  });

  it("leaves the parent open when the board's setting says so, as the app does", async () => {
    const sync = new FakeSync();
    const { parentId, subId } = await seedTasks(sync);
    const { store, core } = await startCore(sync);

    await core.act('updateTask', { taskId: subId, changes: { isDone: true } });

    expect(sync.uploads[0].map((op) => op.entityId)).toEqual([subId]);
    expect(tasksOf(store)[parentId]).toMatchObject({ isDone: false });
  });

  it("makes a task recurring with the app's follow-ups, on the caller's day", async () => {
    const sync = new FakeSync();
    const { otherId } = await seedTasks(sync);
    const { store, core } = await startCore(sync);
    const day = '2031-03-03';

    const res = await core.act(
      'addTaskRepeatCfgToTask',
      { taskId: otherId, repeatCycle: 'DAILY' },
      { today: day },
    );

    expect(sync.uploads).toHaveLength(1);
    const ops = await Promise.all(sync.uploads[0].map(plain));
    const cfgId = res.refs.taskRepeatCfgId;
    const payloads = ops.map((op) => (op.payload as Row).actionPayload as Row);
    // The add, then what updateTaskAfterMakingItRepeatable$ saves: the config's first-occurrence day, the task's due day, and the
    // config's fields copied onto the task, unchanged values included, as a browser uploads them.
    expect(ops.map((op) => [op.actionType, op.entityId])).toEqual([
      ['[TaskRepeatCfg][Task] Add TaskRepeatCfg to Task', cfgId],
      ['[TaskRepeatCfg] Update TaskRepeatCfg', cfgId],
      ['[Task Shared] updateTask', otherId],
      ['[Task Shared] updateTask', otherId],
      ['[Task Shared] updateTask', otherId],
      ['[Task Shared] updateTask', otherId],
    ]);
    expect(payloads[0]).toMatchObject({
      taskId: otherId,
      taskRepeatCfg: { id: cfgId, repeatCycle: 'DAILY', startDate: day, title: 'other' },
    });
    expect(payloads[1]).toMatchObject({
      taskRepeatCfg: {
        id: cfgId,
        changes: { lastTaskCreationDay: day, subTaskTemplates: [] },
      },
    });
    const changes = payloads.slice(2).map((p) => (p.task as Row).changes as Row);
    // The task moves to its first occurrence, created date included, so the repeat processor doesn't make a second one.
    expect(new Date(changes[0].created as number).toLocaleDateString('en-CA')).toBe(day);
    expect(changes).toEqual([
      { dueDay: day, created: changes[0].created },
      { tagIds: [] },
      { title: 'other' },
      { timeEstimate: 0 },
    ]);
    // Op times stay the container's, whatever day the caller gave.
    for (const op of ops)
      expect(Math.abs((op.timestamp as number) - Date.now())).toBeLessThan(60_000);
    expect(res.opIds).toEqual(ops.map((op) => op.id));
    expect(tasksOf(store)[otherId]).toMatchObject({ repeatCfgId: cfgId, dueDay: day });
    expect(store.state.TASK_REPEAT_CFG?.[cfgId]).toMatchObject({
      lastTaskCreationDay: day,
    });
  });

  it("refuses a change the app's validation finds breaks the board, naming why, and uploads nothing", async () => {
    const sync = new FakeSync();
    const { otherId } = await seedTasks(sync);
    const { core } = await startCore(sync);

    const err = await core
      .act('addTaskRepeatCfgToTask', { taskId: otherId, tagIds: ['no-such-tag'] })
      .catch((e: unknown) => e);

    expect(err).toMatchObject({
      statusCode: 409,
      errors: [expect.stringContaining('tagId from task not existing')],
    });
    expect(sync.uploads).toEqual([]);
  });

  it("deletes one task through the existing route as the app's delete button does, still refusing a parent", async () => {
    const sync = new FakeSync();
    const { parentId, otherId } = await seedTasks(sync);
    const { store, core } = await startCore(sync);

    await expect(core.deleteTask(parentId)).rejects.toMatchObject({ statusCode: 409 });
    expect(sync.uploads).toEqual([]);

    expect(await core.deleteTask(otherId)).toEqual({ deleted: otherId });
    const ops = await Promise.all(sync.uploads[0].map(plain));
    expect(ops.map((op) => [op.actionType, op.entityId])).toEqual([
      ['[Task Shared] deleteTask', otherId],
    ]);
    expect(((ops[0].payload as Row).actionPayload as Row).task).toMatchObject({
      id: otherId,
      subTasks: [],
    });
    expect(tasksOf(store)[otherId]).toBeUndefined();
  });

  it('makes a task recurring through the existing route and answers the saved config', async () => {
    const sync = new FakeSync();
    const { otherId } = await seedTasks(sync);
    const { core } = await startCore(sync);

    const cfg = await core.createTaskRepeatCfg(otherId, {
      repeatCycle: 'WEEKLY',
      friday: false,
    });

    expect(cfg).toMatchObject({ repeatCycle: 'WEEKLY', friday: false, title: 'other' });
    expect(sync.uploads[0][0].actionType).toBe(
      '[TaskRepeatCfg][Task] Add TaskRepeatCfg to Task',
    );
    await expect(core.createTaskRepeatCfg(otherId, {})).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(
      core.createTaskRepeatCfg(otherId, { color: 'red' }),
    ).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('builds on the newest state the server has, and is refused while writes are closed', async () => {
    const sync = new FakeSync();
    await seedTasks(sync);
    const { store, core } = await startCore(sync);
    // Another device adds a task after the board's last sync.
    const late = buildTaskEntity({ title: 'late' });
    sync.push(await browser.addTask(late, nextClock()));

    await core.act('deleteTasks', { taskIds: [late.id as string] });
    expect(sync.uploads).toHaveLength(1);

    store.closeWritesUntil(Number.MAX_SAFE_INTEGER, 'Writes are closed for the test.');
    await expect(
      core.act('deleteTasks', { taskIds: [Object.keys(tasksOf(store))[0]] }),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: 'Writes are closed for the test.',
    });
    expect(sync.uploads).toHaveLength(1);
  });
});

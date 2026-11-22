/**
 * Stage 4 app actions (anex/app-actions) end to end in the built worker, with the routes that now build them.
 * Synthetic data only.
 */
import { describe, expect, it } from 'vitest';
import { buildNoteEntity, buildProjectEntity, buildTaskEntity } from '../src/op-factory';
import type { StateStore } from '../src/state-store';
import {
  actionPayloadOf,
  browser,
  FakeSync,
  importInitialState,
  lastUpload,
  nextClock,
  startCore,
  tasksOf,
  useActionWorker,
  type Row,
} from './app-actions-harness';

useActionWorker();

const typesOf = (ops: Row[]): unknown[] => ops.map((op) => op.actionType);

const bucketOf = (store: StateStore, type: string): Record<string, Row> =>
  (store.state[type] ?? {}) as Record<string, Row>;

/** A project with two tasks in it, written by a browser. */
const seedProject = async (
  sync: FakeSync,
  title = 'project',
  isEnableBacklog = false,
): Promise<{ projectId: string; taskIds: string[] }> => {
  const project = buildProjectEntity({ title, isEnableBacklog });
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

describe('moves', () => {
  it('moves a task in its project and into the backlog, and refuses a backlog that is off', async () => {
    const sync = new FakeSync();
    await importInitialState(sync);
    const on = await seedProject(sync, 'on', true);
    const off = await seedProject(sync, 'off');
    const { store, core } = await startCore(sync);
    const [one, two] = on.taskIds;

    await core.act('moveTask', {
      taskId: two,
      list: { projectId: on.projectId },
      afterTaskId: one,
    });
    expect(typesOf(await lastUpload(sync))).toEqual([
      '[WorkContextMeta] Move Task in Today',
    ]);
    expect(bucketOf(store, 'PROJECT')[on.projectId].taskIds).toEqual([one, two]);

    await core.act('moveTask', {
      taskId: one,
      list: { projectId: on.projectId, backlog: true },
      afterTaskId: null,
    });
    expect(typesOf(await lastUpload(sync))).toEqual([
      '[Project] Move Task from regular to backlog',
    ]);
    expect(bucketOf(store, 'PROJECT')[on.projectId]).toMatchObject({
      taskIds: [two],
      backlogTaskIds: [one],
    });

    // Out of the backlog, the app's follow-up also sets the task undone, as in a browser.
    await core.act('moveTask', {
      taskId: one,
      list: { projectId: on.projectId },
      afterTaskId: null,
    });
    expect(typesOf(await lastUpload(sync))).toEqual([
      '[Project] Move Task from backlog to regular',
      '[Task Shared] updateTask',
    ]);
    expect(bucketOf(store, 'PROJECT')[on.projectId].taskIds).toEqual([one, two]);

    const uploads = sync.uploads.length;
    await expect(
      core.act('moveTask', {
        taskId: off.taskIds[0],
        list: { projectId: off.projectId, backlog: true },
        afterTaskId: null,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(sync.uploads.length).toBe(uploads);
  });

  it('reorders through the app’s moves, and empties the backlog when it is turned off', async () => {
    const sync = new FakeSync();
    await importInitialState(sync);
    const { projectId, taskIds } = await seedProject(sync, 'p', true);
    const { store, core } = await startCore(sync);
    // A browser adds a new task at the top.
    expect(bucketOf(store, 'PROJECT')[projectId].taskIds).toEqual([...taskIds].reverse());
    const [one, two] = taskIds;

    await core.reorderTasks({ projectId }, [one, two]);
    const moves = await lastUpload(sync);
    expect(typesOf(moves)).toEqual(['[WorkContextMeta] Move Task in Today']);
    expect(actionPayloadOf(moves[0])).toMatchObject({ taskId: one, afterTaskId: null });
    expect(bucketOf(store, 'PROJECT')[projectId].taskIds).toEqual([one, two]);

    await core.act('moveTask', {
      taskId: one,
      list: { projectId, backlog: true },
      afterTaskId: null,
    });
    await core.updateProject(projectId, { isEnableBacklog: false });
    expect(typesOf(await lastUpload(sync))).toEqual([
      '[Project] Update Project',
      '[Project] Move all backlog tasks to regular',
    ]);
    expect(bucketOf(store, 'PROJECT')[projectId]).toMatchObject({
      isEnableBacklog: false,
      backlogTaskIds: [],
    });
    expect(bucketOf(store, 'PROJECT')[projectId].taskIds).toContain(one);
  });
});

describe('projects and sections', () => {
  it('completes a project with its unfinished tasks marked done, then reopens and hides it', async () => {
    const sync = new FakeSync();
    await importInitialState(sync);
    const { projectId, taskIds } = await seedProject(sync);
    const { store, core } = await startCore(sync);

    await expect(core.act('completeProject', { projectId })).rejects.toMatchObject({
      statusCode: 409,
    });
    await core.act('completeProject', { projectId, unfinished: 'markDone' });
    expect(typesOf(await lastUpload(sync))).toEqual([
      '[Task Shared] updateTask',
      '[Task Shared] updateTask',
      '[Project] Complete Project',
    ]);
    expect(taskIds.map((id) => tasksOf(store)[id].isDone)).toEqual([true, true]);

    await core.act('reopenProject', { projectId });
    await core.act('setProjectHidden', { projectId, hidden: true });
    expect(bucketOf(store, 'PROJECT')[projectId]).toMatchObject({
      isHiddenFromMenu: true,
    });
    expect(bucketOf(store, 'PROJECT')[projectId].isDone).toBeFalsy();
  });

  it('orders a project’s sections', async () => {
    const sync = new FakeSync();
    await importInitialState(sync);
    const { projectId } = await seedProject(sync);
    const { store, core } = await startCore(sync);
    const a = (await core.act('addSection', { title: 'a', projectId })).refs.sectionId;
    const b = (await core.act('addSection', { title: 'b', projectId })).refs.sectionId;

    await expect(
      core.act('updateSectionOrder', { projectId, sectionIds: [b] }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await core.act('updateSectionOrder', { projectId, sectionIds: [b, a] });
    expect(typesOf(await lastUpload(sync))).toEqual(['[Section] Update Section Order']);
    const sections = Object.values(bucketOf(store, 'SECTION'));
    expect(sections.length).toBe(2);
  });
});

describe('attachments and notes', () => {
  it('edits and removes an attachment', async () => {
    const sync = new FakeSync();
    await importInitialState(sync);
    const { taskIds } = await seedProject(sync);
    const taskId = taskIds[0];
    sync.push(
      await browser.addTaskAttachment(
        taskId,
        { id: 'att1', type: 'LINK', title: 'old', path: 'https://example.test' },
        nextClock(),
      ),
    );
    const { store, core } = await startCore(sync);

    await core.act('updateAttachment', {
      taskId,
      attachmentId: 'att1',
      changes: { title: 'new' },
    });
    expect((tasksOf(store)[taskId].attachments as Row[])[0]).toMatchObject({
      title: 'new',
    });
    await core.act('deleteAttachment', { taskId, attachmentId: 'att1' });
    expect(tasksOf(store)[taskId].attachments).toEqual([]);
    await expect(
      core.act('deleteAttachment', { taskId, attachmentId: 'att1' }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('orders a project’s notes and moves one, also through PATCH', async () => {
    const sync = new FakeSync();
    await importInitialState(sync);
    const from = await seedProject(sync, 'from');
    const to = await seedProject(sync, 'to');
    const notes = [1, 2].map((n) =>
      buildNoteEntity({ content: `note ${n}`, projectId: from.projectId }),
    );
    for (const note of notes) sync.push(await browser.addNote(note, nextClock()));
    const [n1, n2] = notes.map((n) => n.id as string);
    const { store, core } = await startCore(sync);

    await core.act('updateNoteOrder', { projectId: from.projectId, noteIds: [n2, n1] });
    expect(bucketOf(store, 'PROJECT')[from.projectId].noteIds).toEqual([n2, n1]);

    await core.updateNote(n1, { projectId: to.projectId, content: 'edited' });
    expect(typesOf(await lastUpload(sync))).toEqual([
      '[Note] Move to other project',
      '[Note] Update Note',
    ]);
    expect(bucketOf(store, 'PROJECT')[from.projectId].noteIds).toEqual([n2]);
    expect(bucketOf(store, 'PROJECT')[to.projectId].noteIds).toContain(n1);
    expect(bucketOf(store, 'NOTE')[n1]).toMatchObject({
      projectId: to.projectId,
      content: 'edited',
    });
  });
});

describe('sidebar folders', () => {
  it('puts a project in a folder, renames the folder and deletes it', async () => {
    const sync = new FakeSync();
    await importInitialState(sync);
    const { projectId } = await seedProject(sync);
    const { store, core } = await startCore(sync);
    const treeOf = (): Row => store.state.MENU_TREE as Row;

    await expect(
      core.act('updateProjectTree', { tree: [{ k: 'p', id: 'nope' }] }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await core.act('updateProjectTree', {
      tree: [{ k: 'f', id: 'f1', name: 'folder', children: [{ k: 'p', id: projectId }] }],
    });
    expect(treeOf().projectTree).toEqual([
      { k: 'f', id: 'f1', name: 'folder', children: [{ k: 'p', id: projectId }] },
    ]);
    await core.act('updateFolder', { tree: 'project', folderId: 'f1', name: 'renamed' });
    expect((treeOf().projectTree as Row[])[0]).toMatchObject({ name: 'renamed' });
    await core.act('deleteFolder', { tree: 'project', folderId: 'f1' });
    expect(treeOf().projectTree).toEqual([]);
  });
});

describe('restore a deleted task', () => {
  it('puts back a deleted task with its subtask', async () => {
    const sync = new FakeSync();
    await importInitialState(sync);
    const { projectId, taskIds } = await seedProject(sync);
    const sub: Row = {
      ...buildTaskEntity({ title: 'sub', projectId }),
      parentId: taskIds[0],
    };
    sync.push(await browser.addSubTask(sub, taskIds[0], nextClock()));
    const { store, core } = await startCore(sync);

    await core.act('deleteTask', { taskId: taskIds[0] });
    expect(tasksOf(store)[taskIds[0]]).toBeUndefined();

    await core.act('restoreDeletedTask', { taskId: taskIds[0] });
    expect(typesOf(await lastUpload(sync))).toEqual(['[Task Shared] restoreDeletedTask']);
    expect(tasksOf(store)[taskIds[0]]).toBeDefined();
    expect(tasksOf(store)[sub.id as string]).toMatchObject({ parentId: taskIds[0] });
    await expect(
      core.act('restoreDeletedTask', { taskId: taskIds[0] }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('counters and metrics', () => {
  it('adds a counter, sets a day’s value, and saves a day’s evaluation', async () => {
    const sync = new FakeSync();
    await importInitialState(sync);
    const { store, core } = await startCore(sync);

    const { counterId } = (
      await core.act('addCounter', { title: 'water', type: 'ClickCounter' })
    ).refs;
    await core.act('setCounterForDay', { counterId, day: '2031-03-03', value: 4 });
    await core.act('updateCounter', { counterId, changes: { title: 'tea' } });
    expect(bucketOf(store, 'SIMPLE_COUNTER')[counterId]).toMatchObject({
      title: 'tea',
      countOnDay: { '2031-03-03': 4 },
    });

    await core.act('setMetric', { day: '2031-03-03', changes: { impactOfWork: 3 } });
    expect(typesOf(await lastUpload(sync))).toEqual(['[Metric] Upsert Metric']);
    expect(bucketOf(store, 'METRIC')['2031-03-03']).toMatchObject({ impactOfWork: 3 });

    await core.act('deleteCounter', { counterId });
    expect(bucketOf(store, 'SIMPLE_COUNTER')[counterId]).toBeUndefined();
  });
});

describe('short syntax', () => {
  it('parses through the app’s parser, creating a new tag and moving to a project', async () => {
    const sync = new FakeSync();
    await importInitialState(sync);
    const { projectId } = await seedProject(sync, 'Pankha');
    const { store, core } = await startCore(sync);

    const task = await core.createTaskFromShortSyntax('Ship it #fresh +Pankha 1h');
    const ops = await lastUpload(sync);
    expect(typesOf(ops)).toEqual([
      '[Task Shared] addTask',
      '[Task Shared] applyShortSyntax',
      '[Tag] Add Tag',
      '[Task Shared] updateTask',
    ]);
    const saved = tasksOf(store)[task.id as string];
    expect(saved).toMatchObject({ title: 'Ship it', projectId, timeEstimate: 3_600_000 });
    const tag = Object.values(bucketOf(store, 'TAG')).find((t) => t.title === 'fresh');
    expect(saved.tagIds).toEqual([tag?.id]);
  });
});

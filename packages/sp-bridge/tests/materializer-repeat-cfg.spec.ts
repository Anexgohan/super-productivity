import { describe, expect, it } from 'vitest';
import { Materializer } from '../src/materializer';
import type { SuperSyncServerOperation } from '@sp/shared-schema';

/**
 * Creating a repeat config has two effects in the client: the config entity appears, AND the task is linked to it via `repeatCfgId`
 * (src/app/features/tasks/store/task.reducer.ts, `on(addTaskRepeatCfgToTask)`).
 *
 * Replaying clients get the second for free by re-dispatching the action through their own reducers. The bridge materializes ops itself, so it has to
 * reproduce the link explicitly. It did not, and the miss was invisible in tests but obvious the moment a real task was made recurring: the bridge
 * reported `repeatCfgId: null` forever, `recurringOnly` never matched, and the "already repeats" guard never fired, so a task collected two configs.
 */
const ACTION = '[TaskRepeatCfg][Task] Add TaskRepeatCfg to Task';

const opRow = (taskId: string, cfgId: string, serverSeq = 1): SuperSyncServerOperation =>
  ({
    serverSeq,
    op: {
      id: `op-${serverSeq}`,
      clientId: 'test-client',
      actionType: ACTION,
      opType: 'CRT',
      entityType: 'TASK_REPEAT_CFG',
      entityId: cfgId,
      vectorClock: { 'test-client': serverSeq },
      timestamp: Date.now(),
      schemaVersion: 4,
      isPayloadEncrypted: false,
      payload: {
        actionPayload: {
          taskId,
          taskRepeatCfg: { id: cfgId, title: 'weekly thing', repeatCycle: 'WEEKLY' },
        },
        entityChanges: [],
      },
    },
  }) as unknown as SuperSyncServerOperation;

const withTask = (id: string): Materializer => {
  const m = new Materializer('unused-no-encryption-in-these-ops');
  m.restoreFromCache({
    state: { TASK: { [id]: { id, title: 'a task' } } },
    lastServerSeq: 0,
    mergedClock: {},
  } as never);
  return m;
};

describe('Materializer: Add TaskRepeatCfg to Task', () => {
  it('creates the config entity', async () => {
    const m = withTask('t1');
    await m.applyOps([opRow('t1', 'cfg1')]);
    expect(m.state.TASK_REPEAT_CFG?.cfg1).toMatchObject({ id: 'cfg1' });
  });

  it('links the task to it, which is the half the generic CRT path misses', async () => {
    const m = withTask('t1');
    await m.applyOps([opRow('t1', 'cfg1')]);
    expect(m.state.TASK.t1).toMatchObject({ id: 't1', repeatCfgId: 'cfg1' });
  });

  it('leaves the rest of the task alone', async () => {
    const m = withTask('t1');
    await m.applyOps([opRow('t1', 'cfg1')]);
    expect(m.state.TASK.t1).toMatchObject({ title: 'a task' });
  });

  it('does not invent a task that is not there, matching the client updateOne no-op', async () => {
    const m = withTask('t1');
    await m.applyOps([opRow('ghost', 'cfg1')]);
    expect(m.state.TASK.ghost).toBeUndefined();
    // The config is still created: it is a real entity regardless of whether this replica knows the task.
    expect(m.state.TASK_REPEAT_CFG?.cfg1).toBeDefined();
  });
});

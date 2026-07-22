/**
 * sp-bridge entry point.
 *
 * M1: `dump` command — authenticate, download the full op-log, decrypt,
 * materialize, and print a state summary. Verifies the entire read path
 * end-to-end before any server/API work builds on it.
 */
import { loadConfig } from './config';
import { SyncClient } from './sync-client';
import { Materializer } from './materializer';

const summarize = (state: Record<string, Record<string, unknown>>): void => {
  console.log('─'.repeat(60));
  console.log('Materialized state summary');
  console.log('─'.repeat(60));
  for (const [entityType, entities] of Object.entries(state)) {
    const isEntityMap =
      entities && typeof entities === 'object' && !Array.isArray(entities);
    const count = isEntityMap ? Object.keys(entities).length : 1;
    console.log(`${entityType.padEnd(20)} ${count}`);
  }

  const tasks = state.TASK ?? state.task;
  if (tasks && typeof tasks === 'object') {
    console.log('─'.repeat(60));
    console.log('Tasks:');
    for (const [id, task] of Object.entries(tasks)) {
      const t = task as { title?: string; isDone?: boolean };
      console.log(`  [${t.isDone ? 'x' : ' '}] ${t.title ?? '(untitled)'} (${id})`);
    }
  }
  console.log('─'.repeat(60));
};

const main = async (): Promise<void> => {
  const command = process.argv[2] ?? 'dump';
  const cfg = loadConfig();

  if (command !== 'dump') {
    console.error(`Unknown command: ${command} (M1 supports: dump)`);
    process.exit(1);
  }

  console.log(`sp-bridge: connecting to ${cfg.syncServerUrl} as "${cfg.clientId}"`);
  const client = new SyncClient(cfg);
  await client.authenticate();
  console.log('sp-bridge: authenticated');

  const { ops, latestSeq } = await client.downloadOpsSince(0);
  console.log(`sp-bridge: downloaded ${ops.length} ops (latestSeq=${latestSeq})`);

  const materializer = new Materializer(cfg.encryptionPassword);
  await materializer.applyOps(ops);
  console.log(`sp-bridge: materialized to seq ${materializer.lastServerSeq}`);

  summarize(materializer.state);
};

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

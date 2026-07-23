import { Materializer, SyncClient } from './chunk-P3LHLXUO.js';

// src/index.ts
import { join } from 'path';

// src/config.ts
var requireEnv = (name) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`sp-bridge: required env var ${name} is not set`);
  }
  return value;
};
var loadConfig = () => ({
  syncServerUrl: (process.env.SP_BRIDGE_SYNC_URL ?? 'http://supersync:1900').replace(
    /\/+$/,
    '',
  ),
  jwtSecret: requireEnv('JWT_SECRET'),
  encryptionPassword: requireEnv('SP_SYNC_ENCRYPTION_PASSWORD'),
  clientId: process.env.SP_BRIDGE_CLIENT_ID ?? 'sp-bridge',
  dataDir: process.env.SP_BRIDGE_DATA_DIR ?? './data',
  apiKey: requireEnv('SP_BRIDGE_API_KEY'),
  apiPort: Number(process.env.SP_BRIDGE_API_PORT ?? 1902),
  pollIntervalSec: Number(process.env.SP_BRIDGE_POLL_INTERVAL_SEC ?? 15),
  authEnabled: process.env.SP_AUTH_ENABLED !== 'false',
  authSessionTtlHours: Number(process.env.SP_AUTH_SESSION_TTL_H ?? 720),
  authSecureCookie: process.env.ALLOW_INSECURE_HTTP !== 'true',
});

// src/index.ts
var summarize = (state) => {
  console.log('\u2500'.repeat(60));
  console.log('Materialized state summary');
  console.log('\u2500'.repeat(60));
  for (const [entityType, entities] of Object.entries(state)) {
    const isEntityMap =
      entities && typeof entities === 'object' && !Array.isArray(entities);
    const count = isEntityMap ? Object.keys(entities).length : 1;
    console.log(`${entityType.padEnd(20)} ${count}`);
  }
  const tasks = state.TASK ?? state.task;
  if (tasks && typeof tasks === 'object') {
    console.log('\u2500'.repeat(60));
    console.log('Tasks:');
    for (const [id, task] of Object.entries(tasks)) {
      const t = task;
      console.log(`  [${t.isDone ? 'x' : ' '}] ${t.title ?? '(untitled)'} (${id})`);
    }
  }
  console.log('\u2500'.repeat(60));
};
var runDump = async () => {
  const cfg = loadConfig();
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
var runServe = async () => {
  const cfg = loadConfig();
  const { StateStore } = await import('./state-store-5FDYD6B4.js');
  const { BridgeCore } = await import('./core-OGRV64U7.js');
  const { createRestServer } = await import('./rest-IWQHPB4N.js');
  const { OpFactory } = await import('./op-factory-2HE5SILV.js');
  const store = new StateStore(cfg);
  await store.start(cfg.pollIntervalSec * 1e3);
  let auth;
  if (cfg.authEnabled) {
    const { AuthStore } = await import('./store-ZMUE7AVY.js');
    const { SessionManager } = await import('./session-F3MRIMKM.js');
    const authStore = new AuthStore(join(cfg.dataDir, 'auth.sqlite'));
    const secret = authStore.getOrCreateSetting(SessionManager.secretSettingKey, () =>
      SessionManager.generateSecret(),
    );
    auth = {
      store: authStore,
      sessions: new SessionManager(secret, {
        ttlSeconds: cfg.authSessionTtlHours * 3600,
        secureCookie: cfg.authSecureCookie,
      }),
    };
    const n = authStore.userCount();
    console.log(
      n === 0
        ? 'sp-bridge: auth enabled \u2014 no account yet, visit /login to create one'
        : `sp-bridge: auth enabled (${n} account${n === 1 ? '' : 's'})`,
    );
  }
  const core = new BridgeCore(store, new OpFactory(cfg.clientId, cfg.encryptionPassword));
  const app = createRestServer(core, store, cfg.apiKey, auth);
  await app.listen({ port: cfg.apiPort, host: '0.0.0.0' });
  console.log(
    `sp-bridge: REST API on :${cfg.apiPort} (poll every ${cfg.pollIntervalSec}s, seq ${store.lastServerSeq})`,
  );
  const shutdown = async () => {
    store.stop();
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
};
var main = async () => {
  const command = process.argv[2] ?? 'serve';
  if (command === 'dump') return runDump();
  if (command === 'serve') return runServe();
  console.error(`Unknown command: ${command} (supported: serve, dump)`);
  process.exit(1);
};
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

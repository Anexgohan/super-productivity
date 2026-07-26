import { Materializer, SyncClient, mintSuperSyncToken } from './chunk-BKQKDC6L.js';

// src/index.ts
import { randomBytes, randomUUID } from 'crypto';
import { setDeploymentEncryptSalt } from '@sp/sync-core';

// src/config.ts
var resolveDatabaseUrl = () => {
  const explicit = process.env.DATABASE_URL;
  if (explicit) {
    return explicit;
  }
  const password = process.env.POSTGRES_PASSWORD;
  if (!password) {
    return '';
  }
  const user = process.env.POSTGRES_USER ?? 'sp_user';
  const database = process.env.POSTGRES_DB ?? 'db_sp';
  const host = process.env.POSTGRES_HOST ?? 'sp_postgres';
  const port = process.env.POSTGRES_PORT ?? '5432';
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
};
var requireEnv = (name) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`sp-bridge: required env var ${name} is not set`);
  }
  return value;
};
var loadConfig = () => ({
  syncServerUrl: (process.env.SP_BRIDGE_SYNC_URL ?? 'http://sp_supersync:1900').replace(
    /\/+$/,
    '',
  ),
  jwtSecret: requireEnv('JWT_SECRET'),
  encryptionPassword: requireEnv('SP_SYNC_ENCRYPTION_PASSWORD'),
  clientId: process.env.SP_BRIDGE_CLIENT_ID ?? 'sp-bridge',
  dataDir: process.env.SP_BRIDGE_DATA_DIR ?? './data',
  apiPort: Number(process.env.SP_BRIDGE_API_PORT ?? 1902),
  pollIntervalSec: Number(process.env.SP_BRIDGE_POLL_INTERVAL_SEC ?? 15),
  authEnabled: process.env.SP_AUTH_ENABLED !== 'false',
  databaseUrl: resolveDatabaseUrl(),
  webUrl: (process.env.SP_PUBLIC_WEB_URL ?? '').replace(/\/+$/, ''),
  authSessionTtlHours: Number(process.env.SP_AUTH_SESSION_TTL_H ?? 720),
  syncAccountEmail: (process.env.SP_SYNC_ACCOUNT_EMAIL ?? '').trim().toLowerCase(),
  syncAccountPassword: process.env.SP_SYNC_ACCOUNT_PASSWORD ?? '',
  // Same default and same var the web entrypoint uses, so both agree on the URL.
  publicSyncUrl: (process.env.SP_SYNC_SERVER_URL ?? '/sync').replace(/\/+$/, ''),
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
  const { StateStore } = await import('./state-store-264HWJI4.js');
  const { BridgeCore } = await import('./core-MGH2DCR6.js');
  const { createRestServer } = await import('./rest-EVVSPB47.js');
  const { OpFactory } = await import('./op-factory-NXIK3L3D.js');
  const store = new StateStore(cfg);
  await store.start(cfg.pollIntervalSec * 1e3);
  const { AuthStore, INSTANCE_ID_SETTING_KEY, ENCRYPT_SALT_SETTING_KEY } =
    await import('./store-QYTLY2J2.js');
  const authStore = cfg.databaseUrl ? new AuthStore(cfg.databaseUrl) : void 0;
  let encryptSaltB64;
  if (authStore) {
    await authStore.init();
    encryptSaltB64 = await authStore.getOrCreateSetting(ENCRYPT_SALT_SETTING_KEY, () =>
      randomBytes(16).toString('base64'),
    );
    setDeploymentEncryptSalt(new Uint8Array(Buffer.from(encryptSaltB64, 'base64')));
  }
  let auth;
  if (cfg.authEnabled) {
    if (!authStore) {
      throw new Error(
        'sp-bridge: SP_AUTH_ENABLED requires DATABASE_URL (set SP_AUTH_ENABLED=false to run without browser auth)',
      );
    }
    const { SessionManager } = await import('./session-2KISGRHT.js');
    const secret = await authStore.getOrCreateSetting(
      SessionManager.secretSettingKey,
      () => SessionManager.generateSecret(),
    );
    const { SyncIdentityProvider, purgeSyncAccount, boardHasData } =
      await import('./sync-identity-UGGVM5ZY.js');
    const identities = new SyncIdentityProvider(authStore, cfg);
    auth = {
      store: authStore,
      jwtSecret: cfg.jwtSecret,
      webUrl: cfg.webUrl,
      purgeSyncAccount: (supersyncUserId) => purgeSyncAccount(cfg, supersyncUserId),
      forgetBoardReadToken: (ownerId) => identities.forgetBoardReadToken(ownerId),
      sessions: new SessionManager(secret, {
        ttlSeconds: cfg.authSessionTtlHours * 3600,
        secureCookie: cfg.authSecureCookie,
      }),
      override: {
        baseUrl: cfg.publicSyncUrl,
        encryptKey: cfg.encryptionPassword,
        // Generated once and persisted: it must be stable for the life of the deployment, since changing it only makes the next session derive a new key.
        // Resolved at startup above, so browsers and this process are guaranteed to be writing under the same salt.
        encryptSalt: async () => encryptSaltB64,
        identities,
        boardHasData: (supersyncUserId) => boardHasData(cfg, supersyncUserId),
        // Resolved per request rather than captured at boot: the value has to
        // follow the database, and a bridge that outlives a wipe would
        // otherwise keep serving the dead instance's id.
        instanceId: () =>
          authStore.getOrCreateSetting(INSTANCE_ID_SETTING_KEY, () => randomUUID()),
      },
    };
    const n = await authStore.userCount();
    console.log(
      n === 0
        ? 'sp-bridge: auth enabled - no account yet, visit /login to create one'
        : `sp-bridge: auth enabled (${n} account${n === 1 ? '' : 's'})`,
    );
  }
  let internal;
  if (authStore) {
    const { WebappTokenProvider } = await import('./webapp-token-HAGLTMJM.js');
    const webappToken = new WebappTokenProvider(authStore, () => mintSuperSyncToken(cfg));
    internal = { secret: cfg.jwtSecret, webappToken: () => webappToken.get() };
  }
  if (!auth) {
    throw new Error(
      'sp-bridge: the REST API requires SP_AUTH_ENABLED=true and DATABASE_URL: API keys are issued per user account',
    );
  }
  const core = new BridgeCore(store, new OpFactory(cfg.clientId, cfg.encryptionPassword));
  let boards;
  if (auth?.override) {
    const { UserBoards } = await import('./user-boards-HUXW4J5F.js');
    boards = new UserBoards(cfg, auth.override.identities, { core, store });
  }
  const app = createRestServer(core, store, auth, internal, boards);
  await app.listen({ port: cfg.apiPort, host: '0.0.0.0' });
  console.log(
    `sp-bridge: REST API on :${cfg.apiPort} (poll every ${cfg.pollIntervalSec}s, seq ${store.lastServerSeq})`,
  );
  const shutdown = async () => {
    boards?.stopAll();
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

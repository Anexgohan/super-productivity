/**
 * sp-bridge entry point.
 *
 * M1: `dump` command - authenticate, download the full op-log, decrypt,
 * materialize, and print a state summary. Verifies the entire read path
 * end-to-end before any server/API work builds on it.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { setDeploymentEncryptSalt } from '@sp/sync-core';
import { loadConfig } from './config';
import { SyncClient, mintSuperSyncToken } from './sync-client';
import { Materializer } from './materializer';
import type { AuthWiring, InternalWiring } from './rest';
import type { UserBoards } from './user-boards';

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

const runDump = async (): Promise<void> => {
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

const runServe = async (): Promise<void> => {
  const cfg = loadConfig();
  const { StateStore } = await import('./state-store');
  const { BridgeCore } = await import('./core');
  const { createRestServer } = await import('./rest');

  const { OpFactory } = await import('./op-factory');

  const store = new StateStore(cfg);
  await store.start(cfg.pollIntervalSec * 1000);

  // Postgres backs two independent things - browser accounts and the durable
  // web-app sync token - so it is opened once here rather than by either.
  const { AuthStore, INSTANCE_ID_SETTING_KEY, ENCRYPT_SALT_SETTING_KEY } =
    await import('./auth/store');
  const authStore = cfg.databaseUrl ? new AuthStore(cfg.databaseUrl) : undefined;
  let encryptSaltB64: string | undefined;
  if (authStore) {
    await authStore.init();
    // Resolved at startup and applied to this process too, not just handed to browsers: an op the bridge writes with its own random salt costs every
    // client a separate ~200ms key derivation on the next cold load, so API writes would keep re-introducing the exact cost the shared salt removes.
    encryptSaltB64 = await authStore.getOrCreateSetting(ENCRYPT_SALT_SETTING_KEY, () =>
      randomBytes(16).toString('base64'),
    );
    setDeploymentEncryptSalt(new Uint8Array(Buffer.from(encryptSaltB64, 'base64')));
  }

  // Browser auth (username/password + session cookies). The signing secret is
  // generated once and persisted, so sessions survive restarts.
  let auth: AuthWiring | undefined;
  if (cfg.authEnabled) {
    if (!authStore) {
      throw new Error(
        'sp-bridge: SP_AUTH_ENABLED requires DATABASE_URL (set SP_AUTH_ENABLED=false to run without browser auth)',
      );
    }
    const { SessionManager } = await import('./auth/session');
    const secret = await authStore.getOrCreateSetting(
      SessionManager.secretSettingKey,
      () => SessionManager.generateSecret(),
    );
    // Each browser gets its own board's credentials, resolved from its session.
    const { SyncIdentityProvider, purgeSyncAccount, boardHasData } =
      await import('./auth/sync-identity');
    // One provider instance: the routes and the override must share its token caches, or each would mint and persist its own.
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
        encryptSalt: async () => encryptSaltB64 as string,
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

  // Durable access token for served browsers. Without Postgres there is nowhere
  // to persist it, so the route stays absent and the web entrypoint degrades to
  // serving no token - browsers then keep whatever config they already hold.
  let internal: InternalWiring | undefined;
  if (authStore) {
    const { WebappTokenProvider } = await import('./webapp-token');
    const webappToken = new WebappTokenProvider(authStore, () => mintSuperSyncToken(cfg));
    internal = { secret: cfg.jwtSecret, webappToken: () => webappToken.get() };
  }

  // API keys belong to users now, so accounts ARE the credential store. With
  // auth off there is nothing left to authenticate a caller with, and every
  // route would answer 401, so fail loudly here instead of looking alive.
  if (!auth) {
    throw new Error(
      'sp-bridge: the REST API requires SP_AUTH_ENABLED=true and DATABASE_URL: API keys are issued per user account',
    );
  }

  const core = new BridgeCore(store, new OpFactory(cfg.clientId, cfg.encryptionPassword));

  // One board per user, started on demand. The container's board is already
  // running, so it is handed in rather than opened a second time.
  let boards: UserBoards | undefined;
  if (auth?.override) {
    const { UserBoards } = await import('./user-boards');
    boards = new UserBoards(cfg, auth.override.identities, { core, store });
  }

  const app = createRestServer(core, store, auth, internal, boards);
  await app.listen({ port: cfg.apiPort, host: '0.0.0.0' });
  console.log(
    `sp-bridge: REST API on :${cfg.apiPort} (poll every ${cfg.pollIntervalSec}s, seq ${store.lastServerSeq})`,
  );

  const shutdown = async (): Promise<void> => {
    boards?.stopAll();
    store.stop();
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
};

const main = async (): Promise<void> => {
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

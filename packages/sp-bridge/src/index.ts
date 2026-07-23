/**
 * sp-bridge entry point.
 *
 * M1: `dump` command — authenticate, download the full op-log, decrypt,
 * materialize, and print a state summary. Verifies the entire read path
 * end-to-end before any server/API work builds on it.
 */
import { loadConfig } from './config';
import { SyncClient, mintSuperSyncToken } from './sync-client';
import { Materializer } from './materializer';
import type { AuthWiring, InternalWiring } from './rest';

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

/**
 * Resolves the digest the REST layer compares presented keys against.
 *
 * An admin-set SP_BRIDGE_API_KEY wins — existing deployments and scripts keep
 * working, and the value stays theirs to rotate. With none set, the bridge
 * mints one and persists only the hash, so the plaintext exists exactly once:
 * in the startup log the operator copies it from.
 */
const resolveApiKeyHash = async (
  configured: string,
  authStore:
    | { getOrCreateSetting: (k: string, c: () => string) => Promise<string> }
    | undefined,
): Promise<string> => {
  const { hashApiKey, mintApiKey, API_KEY_HASH_SETTING_KEY } =
    await import('./auth/api-key');

  if (configured) {
    return hashApiKey(configured);
  }
  if (!authStore) {
    throw new Error(
      'sp-bridge: set SP_BRIDGE_API_KEY, or provide DATABASE_URL so a key can be minted and its hash persisted',
    );
  }

  const minted = mintApiKey();
  const storedHash = await authStore.getOrCreateSetting(API_KEY_HASH_SETTING_KEY, () =>
    hashApiKey(minted),
  );
  if (storedHash === hashApiKey(minted)) {
    console.log(
      `sp-bridge: minted API key (shown once, store it now): ${minted}\n` +
        'sp-bridge: set SP_BRIDGE_API_KEY in .env to choose the value yourself instead.',
    );
  } else {
    // A key already exists and its plaintext is unrecoverable by design.
    console.log(
      'sp-bridge: using the previously minted API key (its hash is stored; the key itself is not).\n' +
        'sp-bridge: lost it? set SP_BRIDGE_API_KEY in .env to take over.',
    );
  }
  return storedHash;
};

const runServe = async (): Promise<void> => {
  const cfg = loadConfig();
  const { StateStore } = await import('./state-store');
  const { BridgeCore } = await import('./core');
  const { createRestServer } = await import('./rest');

  const { OpFactory } = await import('./op-factory');

  const store = new StateStore(cfg);
  await store.start(cfg.pollIntervalSec * 1000);

  // Postgres backs two independent things — browser accounts and the durable
  // web-app sync token — so it is opened once here rather than by either.
  const { AuthStore } = await import('./auth/store');
  const authStore = cfg.databaseUrl ? new AuthStore(cfg.databaseUrl) : undefined;
  if (authStore) {
    await authStore.init();
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
    auth = {
      store: authStore,
      webUrl: cfg.webUrl,
      sessions: new SessionManager(secret, {
        ttlSeconds: cfg.authSessionTtlHours * 3600,
        secureCookie: cfg.authSecureCookie,
      }),
    };
    const n = await authStore.userCount();
    console.log(
      n === 0
        ? 'sp-bridge: auth enabled — no account yet, visit /login to create one'
        : `sp-bridge: auth enabled (${n} account${n === 1 ? '' : 's'})`,
    );
  }

  // Durable access token for served browsers. Without Postgres there is nowhere
  // to persist it, so the route stays absent and the web entrypoint degrades to
  // serving no token — browsers then keep whatever config they already hold.
  let internal: InternalWiring | undefined;
  if (authStore) {
    const { WebappTokenProvider } = await import('./webapp-token');
    const webappToken = new WebappTokenProvider(authStore, () => mintSuperSyncToken(cfg));
    internal = { secret: cfg.jwtSecret, webappToken: () => webappToken.get() };
  }

  const apiKeyHash = await resolveApiKeyHash(cfg.apiKey, authStore);

  const core = new BridgeCore(store, new OpFactory(cfg.clientId, cfg.encryptionPassword));
  const app = createRestServer(core, store, apiKeyHash, auth, internal);
  await app.listen({ port: cfg.apiPort, host: '0.0.0.0' });
  console.log(
    `sp-bridge: REST API on :${cfg.apiPort} (poll every ${cfg.pollIntervalSec}s, seq ${store.lastServerSeq})`,
  );

  const shutdown = async (): Promise<void> => {
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

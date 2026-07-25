/**
 * sp-bridge configuration — everything user-controlled via env (.env in the
 * compose stack), nothing hardcoded.
 */

export interface BridgeConfig {
  /** SuperSync server base URL (compose-internal) */
  syncServerUrl: string;
  /** JWT_SECRET shared with the sync server; used for the internal token endpoint */
  jwtSecret: string;
  /** E2E encryption passphrase (same one the clients use) */
  encryptionPassword: string;
  /** Client id this bridge identifies as in vector clocks / op uploads */
  clientId: string;
  /** Directory for the persisted cursor + state cache */
  dataDir: string;
  /**
   * API key required on all non-public REST routes. Optional: leave it unset
   * and the bridge mints one on first boot, storing only its digest (the
   * plaintext is printed once). Setting it keeps admin control of the value.
   */
  apiKey: string;
  /** REST listen port */
  apiPort: number;
  /** Op-log poll interval in seconds */
  pollIntervalSec: number;
  /** Username/password auth for browsers (login page + session cookies) */
  authEnabled: boolean;
  /** Postgres connection string — same database the stack already runs, own schema */
  databaseUrl: string;
  /**
   * Public URL of the web app. The bridge serves the login page but is not the
   * app, so it needs to know where to send a browser after a successful login.
   */
  webUrl: string;
  /** Session lifetime in hours (sliding) */
  authSessionTtlHours: number;
  /**
   * The container's own SuperSync account, from the same vars the sync server
   * provisions it with. The bridge needs it to recognise which board belongs to
   * the stack itself, so an upgraded single-user deployment keeps its data.
   */
  syncAccountEmail: string;
  syncAccountPassword: string;
  /**
   * Sync URL as the BROWSER should reach it — root-relative under the
   * single-port layout, which is not the same as `syncServerUrl` (how this
   * process reaches it on the compose network).
   */
  publicSyncUrl: string;
  /**
   * Mark session cookies Secure. Derived from ALLOW_INSECURE_HTTP so putting
   * the stack behind TLS hardens the cookie automatically, instead of leaving
   * it quietly insecure because nobody remembered a separate switch.
   */
  authSecureCookie: boolean;
}

/** Explicit DATABASE_URL wins; else assembled from POSTGRES_*. Percent-encoded so `@` or `:` in a password can't corrupt the URL. */
const resolveDatabaseUrl = (): string => {
  const explicit = process.env.DATABASE_URL;
  if (explicit) {
    return explicit;
  }
  const password = process.env.POSTGRES_PASSWORD;
  if (!password) {
    return '';
  }
  // Defaults match the supersync image, so both services resolve the same database from the same .env.
  const user = process.env.POSTGRES_USER ?? 'sp_user';
  const database = process.env.POSTGRES_DB ?? 'db_sp';
  const host = process.env.POSTGRES_HOST ?? 'sp_postgres';
  const port = process.env.POSTGRES_PORT ?? '5432';
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
};

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`sp-bridge: required env var ${name} is not set`);
  }
  return value;
};

export const loadConfig = (): BridgeConfig => ({
  syncServerUrl: (process.env.SP_BRIDGE_SYNC_URL ?? 'http://sp_supersync:1900').replace(
    /\/+$/,
    '',
  ),
  jwtSecret: requireEnv('JWT_SECRET'),
  encryptionPassword: requireEnv('SP_SYNC_ENCRYPTION_PASSWORD'),
  clientId: process.env.SP_BRIDGE_CLIENT_ID ?? 'sp-bridge',
  dataDir: process.env.SP_BRIDGE_DATA_DIR ?? './data',
  apiKey: process.env.SP_BRIDGE_API_KEY ?? '',
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

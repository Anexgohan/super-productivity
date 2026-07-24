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
  const user = process.env.POSTGRES_USER;
  const password = process.env.POSTGRES_PASSWORD;
  const database = process.env.POSTGRES_DB;
  if (!user || !password || !database) {
    return '';
  }
  const host = process.env.POSTGRES_HOST ?? 'postgres';
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
  syncServerUrl: (process.env.SP_BRIDGE_SYNC_URL ?? 'http://supersync:1900').replace(
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
  authSecureCookie: process.env.ALLOW_INSECURE_HTTP !== 'true',
});

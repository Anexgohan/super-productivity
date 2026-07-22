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
}

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`sp-bridge: required env var ${name} is not set`);
  }
  return value;
};

export const loadConfig = (): BridgeConfig => ({
  syncServerUrl: (
    process.env.SP_BRIDGE_SYNC_URL ?? 'http://supersync:1900'
  ).replace(/\/+$/, ''),
  jwtSecret: requireEnv('JWT_SECRET'),
  encryptionPassword: requireEnv('SP_SYNC_ENCRYPTION_PASSWORD'),
  clientId: process.env.SP_BRIDGE_CLIENT_ID ?? 'sp-bridge',
  dataDir: process.env.SP_BRIDGE_DATA_DIR ?? './data',
});

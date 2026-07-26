import { WEBAPP_TOKEN_SETTING_KEY, WebappTokenProvider } from './chunk-QFVUSAKW.js';

// src/auth/sync-identity.ts
import { createHmac } from 'crypto';
var tokenSettingKey = (userId) => `supersync.user_token.${userId}`;
var deriveSyncPassword = (jwtSecret, address) =>
  createHmac('sha256', jwtSecret).update(`sync-account:${address}`).digest('base64url');
var syncAddressFor = (bridgeUserId) => `sp-user-${bridgeUserId}@sp.invalid`;
var provision = async (cfg, email, password) => {
  const res = await fetch(`${cfg.syncServerUrl}/api/internal/provision`, {
    method: 'POST',
    headers: {
      'X-Internal-Secret': cfg.jwtSecret,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `sp-bridge: provisioning ${email} failed (${res.status}) ${body.slice(0, 200)}`,
    );
  }
  return await res.json();
};
var purgeSyncAccount = async (cfg, supersyncUserId) => {
  const res = await fetch(`${cfg.syncServerUrl}/api/internal/users/${supersyncUserId}`, {
    method: 'DELETE',
    headers: { 'X-Internal-Secret': cfg.jwtSecret },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`sync server returned ${res.status} ${body.slice(0, 200)}`);
  }
};
var boardHasData = async (cfg, supersyncUserId) => {
  if (!supersyncUserId) {
    return true;
  }
  try {
    const res = await fetch(
      `${cfg.syncServerUrl}/api/internal/users/${supersyncUserId}/has-data`,
      { headers: { 'X-Internal-Secret': cfg.jwtSecret } },
    );
    if (!res.ok) return true;
    const body = await res.json();
    return body.hasData !== false;
  } catch {
    return true;
  }
};
var SyncIdentityProvider = class {
  constructor(_store, _cfg) {
    this._store = _store;
    this._cfg = _cfg;
  }
  _tokens = /* @__PURE__ */ new Map();
  /**
   * The address a user's board lives under.
   *
   * The first user gets the container account, so a stack upgraded from
   * single-user keeps the data it already had - otherwise the upgrade would
   * present an empty board while their tasks sat in an account nothing pointed
   * at. Everyone else gets an address derived from their immutable id.
   *
   * `email` is never consulted: it is profile data, and identity that a user
   * can edit is identity that can move their board out from under them.
   */
  async _addressFor(user) {
    const isFirstUser = (await this._store.listUsers())[0]?.id === user.id;
    if (isFirstUser && this._cfg.syncAccountEmail) {
      return this._cfg.syncAccountEmail;
    }
    return syncAddressFor(user.id);
  }
  /**
   * Access token for the board this user owns, provisioning the account the
   * first time. Persisted per user, so the token a browser holds survives
   * restarts - a rotating one puts the "Server Already Contains Data" prompt
   * back in front of them.
   */
  /**
   * Whether this user IS the container account, and so shares the board the
   * bridge already syncs. UserBoards needs this to avoid opening a second store
   * against the same account.
   */
  async isContainerAccount(user) {
    const address = await this._addressFor(user);
    return Boolean(this._cfg.syncAccountEmail && address === this._cfg.syncAccountEmail);
  }
  async tokenForUser(user) {
    const existing = this._tokens.get(user.id);
    if (existing) return existing.get();
    const address = await this._addressFor(user);
    const isContainerAccount = Boolean(
      this._cfg.syncAccountEmail && address === this._cfg.syncAccountEmail,
    );
    const password =
      isContainerAccount && this._cfg.syncAccountPassword
        ? this._cfg.syncAccountPassword
        : deriveSyncPassword(this._cfg.jwtSecret, address);
    const provider = new WebappTokenProvider(
      this._store,
      async () => {
        const result = await provision(this._cfg, address, password);
        await this._store.setSyncUserId(user.id, result.userId);
        return result.token;
      },
      isContainerAccount ? WEBAPP_TOKEN_SETTING_KEY : tokenSettingKey(user.id),
    );
    this._tokens.set(user.id, provider);
    return provider.get();
  }
};
export {
  SyncIdentityProvider,
  boardHasData,
  deriveSyncPassword,
  purgeSyncAccount,
  syncAddressFor,
};

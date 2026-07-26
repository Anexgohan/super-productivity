// src/webapp-token.ts
var WEBAPP_TOKEN_SETTING_KEY = 'supersync.webapp_access_token';
var RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1e3;
var decodeClaims = (token) => {
  const segment = token.split('.')[1];
  if (!segment) return null;
  try {
    const json = Buffer.from(
      segment.replace(/-/g, '+').replace(/_/g, '/'),
      'base64',
    ).toString('utf8');
    const claims = JSON.parse(json);
    return claims && typeof claims === 'object' ? claims : null;
  } catch {
    return null;
  }
};
var isTokenUsable = (token, nowMs = Date.now()) => {
  const claims = decodeClaims(token);
  if (!claims) return false;
  if (typeof claims.exp !== 'number') return true;
  return claims.exp * 1e3 - nowMs > RENEW_BEFORE_MS;
};
var WebappTokenProvider = class {
  /**
   * `key` selects which stored token this instance owns. The container's own
   * account uses the default; multi-user gives each board its own key, because
   * every distinct token needs the same durability for the same reason.
   */
  constructor(_store, _mint, _key = WEBAPP_TOKEN_SETTING_KEY) {
    this._store = _store;
    this._mint = _mint;
    this._key = _key;
  }
  _cached = null;
  async get() {
    if (this._cached && isTokenUsable(this._cached)) {
      return this._cached;
    }
    const stored = await this._store.getSetting(this._key);
    if (stored && isTokenUsable(stored)) {
      this._cached = stored;
      return stored;
    }
    const minted = await this._mint();
    if (stored) {
      await this._store.setSetting(this._key, minted);
      this._cached = minted;
      return minted;
    }
    const settled = await this._store.getOrCreateSetting(this._key, () => minted);
    this._cached = settled;
    return settled;
  }
};

export { WEBAPP_TOKEN_SETTING_KEY, isTokenUsable, WebappTokenProvider };

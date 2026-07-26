// src/auth/store.ts
import { Pool } from 'pg';
var ROLES = ['admin', 'operator', 'viewer'];
var ROLE_LEVELS = {
  viewer: 1,
  operator: 2,
  admin: 3,
};
var isRole = (value) => typeof value === 'string' && ROLES.includes(value);
var USER_COLUMNS = `id, username, password_hash, role, email, supersync_user_id, is_public, sort_order`;
var toUserRow = (row) =>
  row
    ? {
        id: row.id,
        username: row.username,
        passwordHash: row.password_hash,
        role: row.role,
        email: row.email,
        supersyncUserId: row.supersync_user_id,
        isPublic: row.is_public,
        sortOrder: row.sort_order,
      }
    : null;
var API_KEY_COLUMNS = `id, user_id, label, salt, version, created_at, last_used_at, revoked_at`;
var toApiKeyRow = (row) =>
  row
    ? {
        id: row.id,
        userId: row.user_id,
        label: row.label,
        salt: row.salt,
        version: row.version,
        createdAt: Number(row.created_at),
        lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at),
        revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
      }
    : null;
var SCHEMA = 'bridge';
var INSTANCE_ID_SETTING_KEY = 'bridge.instance_id';
var AuthStore = class {
  _pool;
  constructor(connectionString) {
    this._pool = new Pool({
      connectionString,
      max: 4,
      idleTimeoutMillis: 3e4,
      connectionTimeoutMillis: 1e4,
    });
    this._pool.on('error', (err) => {
      console.warn(`sp-bridge: idle postgres client error: ${err.message}`);
    });
  }
  /**
   * Creates the schema/tables if absent, retrying while Postgres comes up.
   * The bridge starts alongside the database, so a few seconds of unavailability
   * at boot is normal rather than an error.
   */
  async init(retries = 10, delayMs = 2e3) {
    for (let attempt = 1; ; attempt++) {
      try {
        await this._pool.query(`
          CREATE SCHEMA IF NOT EXISTS ${SCHEMA};
          CREATE TABLE IF NOT EXISTS ${SCHEMA}.users (
            id            SERIAL PRIMARY KEY,
            username      TEXT   NOT NULL UNIQUE,
            password_hash TEXT   NOT NULL,
            role          TEXT   NOT NULL DEFAULT 'admin',
            created_at    BIGINT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS ${SCHEMA}.settings (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
          );
          -- Multi-user columns, added separately so stacks created before them upgrade in place.
          ALTER TABLE ${SCHEMA}.users
            ADD COLUMN IF NOT EXISTS email             TEXT,
            ADD COLUMN IF NOT EXISTS supersync_user_id INTEGER,
            ADD COLUMN IF NOT EXISTS is_public         BOOLEAN NOT NULL DEFAULT FALSE,
            ADD COLUMN IF NOT EXISTS sort_order        INTEGER;
          CREATE UNIQUE INDEX IF NOT EXISTS users_email_key
            ON ${SCHEMA}.users (lower(email)) WHERE email IS NOT NULL;
          -- Key material only. The key itself is derived on demand (see api-key.ts), so nothing here is a secret.
          CREATE TABLE IF NOT EXISTS ${SCHEMA}.api_keys (
            id           SERIAL PRIMARY KEY,
            user_id      INTEGER NOT NULL REFERENCES ${SCHEMA}.users(id) ON DELETE CASCADE,
            label        TEXT    NOT NULL,
            salt         TEXT    NOT NULL,
            version      INTEGER NOT NULL DEFAULT 1,
            created_at   BIGINT  NOT NULL,
            last_used_at BIGINT,
            revoked_at   BIGINT
          );
          CREATE INDEX IF NOT EXISTS api_keys_user_id_idx ON ${SCHEMA}.api_keys (user_id);
        `);
        return;
      } catch (err) {
        if (attempt >= retries) throw err;
        console.warn(
          `sp-bridge: postgres not ready (${err.message}); retry ${attempt}/${retries}`,
        );
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  async userCount() {
    const { rows } = await this._pool.query(
      `SELECT COUNT(*)::text AS n FROM ${SCHEMA}.users`,
    );
    return Number.parseInt(rows[0].n, 10);
  }
  async findUser(username) {
    const { rows } = await this._pool.query(
      `SELECT ${USER_COLUMNS} FROM ${SCHEMA}.users WHERE lower(username) = lower($1)`,
      [username],
    );
    return toUserRow(rows[0]);
  }
  async findUserById(id) {
    const { rows } = await this._pool.query(
      `SELECT ${USER_COLUMNS} FROM ${SCHEMA}.users WHERE id = $1`,
      [id],
    );
    return toUserRow(rows[0]);
  }
  /**
   * In the admin's chosen order. Rows never reordered have no sort_order and
   * fall to the end by id, so an upgraded stack keeps its existing sequence
   * until someone actually moves something.
   */
  async listUsers() {
    const { rows } = await this._pool.query(
      `SELECT ${USER_COLUMNS} FROM ${SCHEMA}.users
       ORDER BY sort_order NULLS LAST, id`,
    );
    return rows.map((row) => toUserRow(row));
  }
  /**
   * Rewrites the whole order in one statement. Taking the full id list rather
   * than a pair of swaps keeps the stored sequence dense and total, so it can
   * never drift into ties or gaps that reorder unpredictably later.
   */
  async setOrder(orderedIds) {
    if (!orderedIds.length) return;
    await this._pool.query(
      `UPDATE ${SCHEMA}.users AS u
       SET sort_order = v.position
       FROM unnest($1::int[]) WITH ORDINALITY AS v(id, position)
       WHERE u.id = v.id`,
      [orderedIds],
    );
  }
  async setUsername(id, username) {
    const { rowCount } = await this._pool.query(
      `UPDATE ${SCHEMA}.users SET username = $2
       WHERE id = $1
         AND NOT EXISTS (
           SELECT 1 FROM ${SCHEMA}.users
           WHERE lower(username) = lower($2) AND id <> $1
         )`,
      [id, username],
    );
    return (rowCount ?? 0) > 0;
  }
  /** Boards a viewer may open. */
  async listPublicUsers() {
    const { rows } = await this._pool.query(
      `SELECT ${USER_COLUMNS} FROM ${SCHEMA}.users
       WHERE is_public AND supersync_user_id IS NOT NULL ORDER BY username`,
    );
    return rows.map((row) => toUserRow(row));
  }
  /**
   * Records which SuperSync account this user's board lives under, on first
   * provision. The address itself is derived from the immutable bridge id
   * rather than stored (see sync-identity.ts), so there is nothing here that
   * editing a profile could move.
   */
  async setSyncUserId(id, supersyncUserId) {
    await this._pool.query(
      `UPDATE ${SCHEMA}.users SET supersync_user_id = $2
       WHERE id = $1 AND supersync_user_id IS NULL`,
      [id, supersyncUserId],
    );
  }
  /** How many admins exist. Guards the last-admin checks on demote and delete. */
  async adminCount() {
    const { rows } = await this._pool.query(
      `SELECT COUNT(*)::text AS n FROM ${SCHEMA}.users WHERE role = 'admin'`,
    );
    return Number.parseInt(rows[0].n, 10);
  }
  async setRole(id, role) {
    await this._pool.query(`UPDATE ${SCHEMA}.users SET role = $2 WHERE id = $1`, [
      id,
      role,
    ]);
  }
  /** Profile data only - it is not the sync identity, so changing it moves nothing. */
  async setEmail(id, email) {
    await this._pool.query(`UPDATE ${SCHEMA}.users SET email = $2 WHERE id = $1`, [
      id,
      email,
    ]);
  }
  async setPassword(id, passwordHash) {
    await this._pool.query(
      `UPDATE ${SCHEMA}.users SET password_hash = $2 WHERE id = $1`,
      [id, passwordHash],
    );
  }
  async deleteUser(id) {
    await this._pool.query(`DELETE FROM ${SCHEMA}.users WHERE id = $1`, [id]);
  }
  async deleteSetting(key) {
    await this._pool.query(`DELETE FROM ${SCHEMA}.settings WHERE key = $1`, [key]);
  }
  async setPublic(id, isPublic) {
    await this._pool.query(`UPDATE ${SCHEMA}.users SET is_public = $2 WHERE id = $1`, [
      id,
      isPublic,
    ]);
  }
  /**
   * Creates a user. `onlyIfNone` makes it the race-safe first-admin insert:
   * two concurrent setup submissions cannot both succeed.
   */
  async createUser(username, passwordHash, role, onlyIfNone = false, email = null) {
    const sql = onlyIfNone
      ? `INSERT INTO ${SCHEMA}.users (username, password_hash, role, created_at, email)
         SELECT $1, $2, $3, $4, $5
         WHERE NOT EXISTS (SELECT 1 FROM ${SCHEMA}.users)
         ON CONFLICT (username) DO NOTHING
         RETURNING ${USER_COLUMNS}`
      : `INSERT INTO ${SCHEMA}.users (username, password_hash, role, created_at, email)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (username) DO NOTHING
         RETURNING ${USER_COLUMNS}`;
    const { rows } = await this._pool.query(sql, [
      username,
      passwordHash,
      role,
      Date.now(),
      email,
    ]);
    return toUserRow(rows[0]);
  }
  async createApiKey(userId, label, salt) {
    const { rows } = await this._pool.query(
      `INSERT INTO ${SCHEMA}.api_keys (user_id, label, salt, created_at)
       VALUES ($1, $2, $3, $4)
       RETURNING ${API_KEY_COLUMNS}`,
      [userId, label, salt, Date.now()],
    );
    return toApiKeyRow(rows[0]);
  }
  /** Every key a user owns, revoked ones included, since the UI shows them greyed rather than hiding the history. */
  async listApiKeys(userId) {
    const { rows } = await this._pool.query(
      `SELECT ${API_KEY_COLUMNS} FROM ${SCHEMA}.api_keys
       WHERE user_id = $1 ORDER BY id`,
      [userId],
    );
    return rows.map((row) => toApiKeyRow(row));
  }
  /** Live keys only. Verification must never resurrect a revoked row. */
  async findLiveApiKey(id) {
    const { rows } = await this._pool.query(
      `SELECT ${API_KEY_COLUMNS} FROM ${SCHEMA}.api_keys
       WHERE id = $1 AND revoked_at IS NULL`,
      [id],
    );
    return toApiKeyRow(rows[0]);
  }
  async findApiKey(id) {
    const { rows } = await this._pool.query(
      `SELECT ${API_KEY_COLUMNS} FROM ${SCHEMA}.api_keys WHERE id = $1`,
      [id],
    );
    return toApiKeyRow(rows[0]);
  }
  /**
   * Marks a key dead but keeps the row: its label and last-used stamp are the only record of what had been calling in with it.
   */
  async revokeApiKey(id) {
    const { rowCount } = await this._pool.query(
      `UPDATE ${SCHEMA}.api_keys SET revoked_at = $2
       WHERE id = $1 AND revoked_at IS NULL`,
      [id, Date.now()],
    );
    return (rowCount ?? 0) > 0;
  }
  /**
   * Drops the record entirely.
   * Safe because a SERIAL sequence only ever moves forward, so the freed id is never handed to a future key and the old string can never verify again.
   */
  async deleteApiKey(id) {
    const { rowCount } = await this._pool.query(
      `DELETE FROM ${SCHEMA}.api_keys WHERE id = $1`,
      [id],
    );
    return (rowCount ?? 0) > 0;
  }
  /** Fire-and-forget: a failed usage stamp must never fail the request it describes. */
  async touchApiKey(id) {
    await this._pool.query(
      `UPDATE ${SCHEMA}.api_keys SET last_used_at = $2 WHERE id = $1`,
      [id, Date.now()],
    );
  }
  async getSetting(key) {
    const { rows } = await this._pool.query(
      `SELECT value FROM ${SCHEMA}.settings WHERE key = $1`,
      [key],
    );
    return rows[0]?.value ?? null;
  }
  async setSetting(key, value) {
    await this._pool.query(
      `INSERT INTO ${SCHEMA}.settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, value],
    );
  }
  /**
   * Insert-if-absent, returning whatever ended up stored. Concurrency-safe: if
   * two bridges boot together, both end up reading the same secret rather than
   * each minting one and invalidating the other's sessions.
   */
  async getOrCreateSetting(key, create) {
    const existing = await this.getSetting(key);
    if (existing) return existing;
    await this._pool.query(
      `INSERT INTO ${SCHEMA}.settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO NOTHING`,
      [key, create()],
    );
    const stored = await this.getSetting(key);
    if (!stored) throw new Error('sp-bridge: failed to persist setting');
    return stored;
  }
  async close() {
    await this._pool.end();
  }
};

export { ROLES, ROLE_LEVELS, isRole, INSTANCE_ID_SETTING_KEY, AuthStore };

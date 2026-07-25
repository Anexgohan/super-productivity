/**
 * Local auth store — users + small key/value settings, in Postgres.
 *
 * Lives in the SAME Postgres the stack already runs, under its own `bridge`
 * schema. One engine, one backup, one thing to operate: a `pg_dump` of the
 * database now captures accounts as well as sync data. The dedicated schema is
 * what keeps us clear of SuperSync's Prisma migrations, which only ever touch
 * their own tables — isolation without a second datastore.
 *
 * Multi-user readiness (wanted later, not now): `users` is a real table with
 * ids and roles rather than a single admin blob, so adding accounts is INSERTs
 * and per-user data scoping is one more column plus a join — additive, not a
 * rewrite. Everything downstream already carries a userId.
 */
import { Pool } from 'pg';

export interface UserRow {
  id: number;
  username: string;
  passwordHash: string;
  role: string;
  /** Profile data, shown in the UI. NOT the sync identity — see sync-identity.ts. */
  email: string | null;
  /** The sync server's own user id, resolved at provisioning time. */
  supersyncUserId: number | null;
  /** Board published to viewers. Whole-board: the server cannot read encrypted ops to filter finer. */
  isPublic: boolean;
  /** Admin-chosen position in the user list; null until someone reorders. */
  sortOrder: number | null;
}

/** Roles, ordered by privilege. */
export const ROLES = ['admin', 'operator', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

/** Numeric privilege for comparisons. Ported from pankha's role gate. */
export const ROLE_LEVELS: Record<Role, number> = {
  viewer: 1,
  operator: 2,
  admin: 3,
};

export const isRole = (value: unknown): value is Role =>
  typeof value === 'string' && (ROLES as readonly string[]).includes(value);

const USER_COLUMNS = `id, username, password_hash, role, email, supersync_user_id, is_public, sort_order`;

interface UserRecord {
  id: number;
  username: string;
  password_hash: string;
  role: string;
  email: string | null;
  supersync_user_id: number | null;
  is_public: boolean;
  sort_order: number | null;
}

const toUserRow = (row: UserRecord | undefined): UserRow | null =>
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

const SCHEMA = 'bridge';

/**
 * Identity of the data in this database, minted on first use.
 *
 * It lives in `settings` rather than in `.env` so that it is destroyed with the
 * data it names: wiping the database mints a new id, which is precisely the
 * signal browsers need to stop treating their replica as this stack's.
 */
export const INSTANCE_ID_SETTING_KEY = 'bridge.instance_id';

export class AuthStore {
  private readonly _pool: Pool;

  constructor(connectionString: string) {
    this._pool = new Pool({
      connectionString,
      max: 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    // A pooled client can be dropped by the server (restart, idle reaper);
    // without a listener that surfaces as an unhandled 'error' event and takes
    // the process down. pg replaces the client on the next acquire.
    this._pool.on('error', (err) => {
      console.warn(`sp-bridge: idle postgres client error: ${err.message}`);
    });
  }

  /**
   * Creates the schema/tables if absent, retrying while Postgres comes up.
   * The bridge starts alongside the database, so a few seconds of unavailability
   * at boot is normal rather than an error.
   */
  async init(retries = 10, delayMs = 2_000): Promise<void> {
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
        `);
        return;
      } catch (err) {
        if (attempt >= retries) throw err;
        console.warn(
          `sp-bridge: postgres not ready (${(err as Error).message}); retry ${attempt}/${retries}`,
        );
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  async userCount(): Promise<number> {
    const { rows } = await this._pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM ${SCHEMA}.users`,
    );
    return Number.parseInt(rows[0].n, 10);
  }

  async findUser(username: string): Promise<UserRow | null> {
    // Case-insensitive lookup so "Anex" and "anex" are the same account.
    const { rows } = await this._pool.query<UserRecord>(
      `SELECT ${USER_COLUMNS} FROM ${SCHEMA}.users WHERE lower(username) = lower($1)`,
      [username],
    );
    return toUserRow(rows[0]);
  }

  async findUserById(id: number): Promise<UserRow | null> {
    const { rows } = await this._pool.query<UserRecord>(
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
  async listUsers(): Promise<UserRow[]> {
    const { rows } = await this._pool.query<UserRecord>(
      `SELECT ${USER_COLUMNS} FROM ${SCHEMA}.users
       ORDER BY sort_order NULLS LAST, id`,
    );
    return rows.map((row) => toUserRow(row) as UserRow);
  }

  /**
   * Rewrites the whole order in one statement. Taking the full id list rather
   * than a pair of swaps keeps the stored sequence dense and total, so it can
   * never drift into ties or gaps that reorder unpredictably later.
   */
  async setOrder(orderedIds: number[]): Promise<void> {
    if (!orderedIds.length) return;
    await this._pool.query(
      `UPDATE ${SCHEMA}.users AS u
       SET sort_order = v.position
       FROM unnest($1::int[]) WITH ORDINALITY AS v(id, position)
       WHERE u.id = v.id`,
      [orderedIds],
    );
  }

  async setUsername(id: number, username: string): Promise<boolean> {
    // Case-insensitive collision check mirrors findUser(), which resolves
    // logins the same way — otherwise "Bob" could shadow "bob" at sign-in.
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
  async listPublicUsers(): Promise<UserRow[]> {
    const { rows } = await this._pool.query<UserRecord>(
      `SELECT ${USER_COLUMNS} FROM ${SCHEMA}.users
       WHERE is_public AND supersync_user_id IS NOT NULL ORDER BY username`,
    );
    return rows.map((row) => toUserRow(row) as UserRow);
  }

  /**
   * Records which SuperSync account this user's board lives under, on first
   * provision. The address itself is derived from the immutable bridge id
   * rather than stored (see sync-identity.ts), so there is nothing here that
   * editing a profile could move.
   */
  async setSyncUserId(id: number, supersyncUserId: number): Promise<void> {
    await this._pool.query(
      `UPDATE ${SCHEMA}.users SET supersync_user_id = $2
       WHERE id = $1 AND supersync_user_id IS NULL`,
      [id, supersyncUserId],
    );
  }

  /** How many admins exist. Guards the last-admin checks on demote and delete. */
  async adminCount(): Promise<number> {
    const { rows } = await this._pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM ${SCHEMA}.users WHERE role = 'admin'`,
    );
    return Number.parseInt(rows[0].n, 10);
  }

  async setRole(id: number, role: Role): Promise<void> {
    await this._pool.query(`UPDATE ${SCHEMA}.users SET role = $2 WHERE id = $1`, [
      id,
      role,
    ]);
  }

  /** Profile data only — it is not the sync identity, so changing it moves nothing. */
  async setEmail(id: number, email: string | null): Promise<void> {
    await this._pool.query(`UPDATE ${SCHEMA}.users SET email = $2 WHERE id = $1`, [
      id,
      email,
    ]);
  }

  async setPassword(id: number, passwordHash: string): Promise<void> {
    await this._pool.query(
      `UPDATE ${SCHEMA}.users SET password_hash = $2 WHERE id = $1`,
      [id, passwordHash],
    );
  }

  async deleteUser(id: number): Promise<void> {
    await this._pool.query(`DELETE FROM ${SCHEMA}.users WHERE id = $1`, [id]);
  }

  async deleteSetting(key: string): Promise<void> {
    await this._pool.query(`DELETE FROM ${SCHEMA}.settings WHERE key = $1`, [key]);
  }

  async setPublic(id: number, isPublic: boolean): Promise<void> {
    await this._pool.query(`UPDATE ${SCHEMA}.users SET is_public = $2 WHERE id = $1`, [
      id,
      isPublic,
    ]);
  }

  /**
   * Creates a user. `onlyIfNone` makes it the race-safe first-admin insert:
   * two concurrent setup submissions cannot both succeed.
   */
  async createUser(
    username: string,
    passwordHash: string,
    role: Role,
    onlyIfNone = false,
    email: string | null = null,
  ): Promise<UserRow | null> {
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
    const { rows } = await this._pool.query<UserRecord>(sql, [
      username,
      passwordHash,
      role,
      Date.now(),
      email,
    ]);
    return toUserRow(rows[0]);
  }

  async getSetting(key: string): Promise<string | null> {
    const { rows } = await this._pool.query<{ value: string }>(
      `SELECT value FROM ${SCHEMA}.settings WHERE key = $1`,
      [key],
    );
    return rows[0]?.value ?? null;
  }

  async setSetting(key: string, value: string): Promise<void> {
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
  async getOrCreateSetting(key: string, create: () => string): Promise<string> {
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

  async close(): Promise<void> {
    await this._pool.end();
  }
}

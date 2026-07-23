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
}

/** Roles, ordered by privilege. `viewer` exists for the multi-user future. */
export const ROLES = ['admin', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

const SCHEMA = 'bridge';

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
    const { rows } = await this._pool.query<{
      id: number;
      username: string;
      password_hash: string;
      role: string;
    }>(
      `SELECT id, username, password_hash, role
       FROM ${SCHEMA}.users WHERE lower(username) = lower($1)`,
      [username],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      username: row.username,
      passwordHash: row.password_hash,
      role: row.role,
    };
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
  ): Promise<UserRow | null> {
    const sql = onlyIfNone
      ? `INSERT INTO ${SCHEMA}.users (username, password_hash, role, created_at)
         SELECT $1, $2, $3, $4
         WHERE NOT EXISTS (SELECT 1 FROM ${SCHEMA}.users)
         ON CONFLICT (username) DO NOTHING
         RETURNING id, username, password_hash, role`
      : `INSERT INTO ${SCHEMA}.users (username, password_hash, role, created_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (username) DO NOTHING
         RETURNING id, username, password_hash, role`;
    const { rows } = await this._pool.query<{
      id: number;
      username: string;
      password_hash: string;
      role: string;
    }>(sql, [username, passwordHash, role, Date.now()]);
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      username: row.username,
      passwordHash: row.password_hash,
      role: row.role,
    };
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

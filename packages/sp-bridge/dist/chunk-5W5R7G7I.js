// src/auth/store.ts
import { createRequire } from 'module';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
var { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
var ROLES = ['admin', 'viewer'];
var AuthStore = class {
  _db;
  constructor(dbPath) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this._db = new DatabaseSync(dbPath);
    this._db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS users (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT    NOT NULL,
        role          TEXT    NOT NULL DEFAULT 'admin',
        created_at    INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }
  userCount() {
    const row = this._db.prepare('SELECT COUNT(*) AS n FROM users').get();
    return row.n;
  }
  findUser(username) {
    const row = this._db
      .prepare('SELECT id, username, password_hash, role FROM users WHERE username = ?')
      .get(username);
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
  createUser(username, passwordHash, role, onlyIfNone = false) {
    const sql = onlyIfNone
      ? `INSERT INTO users (username, password_hash, role, created_at)
         SELECT ?, ?, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM users)`
      : `INSERT INTO users (username, password_hash, role, created_at)
         VALUES (?, ?, ?, ?)`;
    const res = this._db.prepare(sql).run(username, passwordHash, role, Date.now());
    if (!res.changes) return null;
    return this.findUser(username);
  }
  getSetting(key) {
    const row = this._db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row?.value ?? null;
  }
  setSetting(key, value) {
    this._db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }
  /** Insert-if-absent; returns the value that ended up stored (race-safe). */
  getOrCreateSetting(key, create) {
    const existing = this.getSetting(key);
    if (existing) return existing;
    this._db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT DO NOTHING')
      .run(key, create());
    return this.getSetting(key);
  }
  close() {
    this._db.close();
  }
};

export { ROLES, AuthStore };

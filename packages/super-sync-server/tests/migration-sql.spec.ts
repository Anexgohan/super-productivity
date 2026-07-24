import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const currentDir = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(currentDir, '../prisma/migrations');

const readMigration = (name: string): string =>
  readFileSync(join(migrationsDir, name, 'migration.sql'), 'utf8');

const allMigrationSql = (): string =>
  readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readMigration(entry.name))
    .join('\n');

describe('performance migrations', () => {
  it('adds the entity sequence index without a blocking or destructive migration', () => {
    const migrationSql = readFileSync(
      join(
        currentDir,
        '../prisma/migrations/20260511000000_add_entity_sequence_index/migration.sql',
      ),
      'utf8',
    );

    expect(migrationSql).toContain('CREATE INDEX CONCURRENTLY');
    expect(migrationSql).not.toMatch(/\bIF\s+NOT\s+EXISTS\b/i);
    expect(migrationSql).toContain(
      '"operations_user_id_entity_type_entity_id_server_seq_idx"',
    );
    expect(migrationSql).toContain(
      'ON "operations"("user_id", "entity_type", "entity_id", "server_seq")',
    );
    expect(migrationSql).not.toMatch(/\bDROP\s+INDEX\b/i);
    expect(migrationSql).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(migrationSql).not.toMatch(/\bBEGIN\b|\bCOMMIT\b/i);
  });

  it('adds partial full-state sequence index and drops redundant indexes', () => {
    const migrationSql = readFileSync(
      join(
        currentDir,
        '../prisma/migrations/20260512000000_add_full_state_sequence_index_drop_redundant_indexes/migration.sql',
      ),
      'utf8',
    );

    expect(migrationSql).toContain('CREATE INDEX CONCURRENTLY');
    expect(migrationSql).toContain('"operations_user_id_full_state_server_seq_idx"');
    expect(migrationSql).toContain('ON "operations"("user_id", "server_seq")');
    expect(migrationSql).toContain(
      `WHERE "op_type" IN ('SYNC_IMPORT', 'BACKUP_IMPORT', 'REPAIR')`,
    );
    expect(migrationSql).toContain(
      'DROP INDEX CONCURRENTLY IF EXISTS "operations_user_id_op_type_idx"',
    );
    expect(migrationSql).toContain(
      'DROP INDEX CONCURRENTLY IF EXISTS "operations_user_id_entity_type_entity_id_idx"',
    );
    expect(migrationSql).toContain(
      'DROP INDEX CONCURRENTLY IF EXISTS "operations_user_id_server_seq_idx"',
    );
    expect(migrationSql).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(migrationSql).not.toMatch(/\bALTER\s+TABLE\b/i);
    expect(migrationSql).not.toMatch(/\bBEGIN\b|\bCOMMIT\b/i);
  });

  it('adds partial encrypted-op sequence index concurrently', () => {
    const migrationSql = readFileSync(
      join(
        currentDir,
        '../prisma/migrations/20260514000000_add_encrypted_ops_partial_index/migration.sql',
      ),
      'utf8',
    );

    expect(migrationSql).toContain('CREATE INDEX CONCURRENTLY');
    expect(migrationSql).toContain(
      'DROP INDEX CONCURRENTLY IF EXISTS "operations_user_id_server_seq_encrypted_idx"',
    );
    expect(migrationSql).toContain('"operations_user_id_server_seq_encrypted_idx"');
    expect(migrationSql).toContain('ON "operations"("user_id", "server_seq")');
    expect(migrationSql).toContain('WHERE "is_payload_encrypted" = true');
    expect(migrationSql).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(migrationSql).not.toMatch(/\bBEGIN\b|\bCOMMIT\b/i);
  });

  it('adds operation payload_bytes as a metadata-only column (no table rewrite)', () => {
    const migrationSql = readFileSync(
      join(
        currentDir,
        '../prisma/migrations/20260514000001_add_operation_payload_bytes/migration.sql',
      ),
      'utf8',
    );

    // ADD COLUMN ... NOT NULL DEFAULT <constant> is a metadata-only operation on
    // PostgreSQL 11+ (the default is stored in pg_attribute, no table rewrite).
    // These guards lock in the fast path: a future edit to a volatile/expression
    // default or a separate UPDATE backfill would rewrite/lock a 100M-row table.
    expect(migrationSql).toMatch(
      /ALTER TABLE "operations"\s+ADD COLUMN "payload_bytes" BIGINT NOT NULL DEFAULT 0/i,
    );
    expect(migrationSql).not.toMatch(/\bUPDATE\b/i);
    expect(migrationSql).not.toMatch(/\bUSING\b/i);
    expect(migrationSql).not.toMatch(/DEFAULT\s+(?!0\b)/i);
    expect(migrationSql).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(migrationSql).not.toMatch(/\bBEGIN\b|\bCOMMIT\b/i);
  });

  it('adds the payload_bytes unbackfilled partial index concurrently', () => {
    const migrationSql = readFileSync(
      join(
        currentDir,
        '../prisma/migrations/20260514000002_add_payload_bytes_unbackfilled_index/migration.sql',
      ),
      'utf8',
    );

    expect(migrationSql).toContain('CREATE INDEX CONCURRENTLY');
    expect(migrationSql).toContain(
      'DROP INDEX CONCURRENTLY IF EXISTS "operations_payload_bytes_unbackfilled_idx"',
    );
    expect(migrationSql).toContain('"operations_payload_bytes_unbackfilled_idx"');
    expect(migrationSql).toContain('ON "operations"("user_id", "id")');
    // Partial predicate must match the boot self-check / quota probe
    // (payload_bytes = 0) so the index drains to empty post-backfill.
    expect(migrationSql).toContain('WHERE "payload_bytes" = 0');
    expect(migrationSql).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(migrationSql).not.toMatch(/\bALTER\s+TABLE\b/i);
    expect(migrationSql).not.toMatch(/\bBEGIN\b|\bCOMMIT\b/i);
  });

  it('adds the operation entity_ids column as a metadata-only column (no table rewrite)', () => {
    const migrationSql = readMigration('20260613000000_add_operation_entity_ids');

    // Same fast-path guards as payload_bytes: ADD COLUMN with a constant default is
    // metadata-only on PG 11+. A future edit to an expression default or a separate
    // UPDATE backfill would rewrite/lock a 100M-row table — #8334 is forward-only by
    // design (pre-migration rows fall back to the scalar entity_id), so no backfill.
    expect(migrationSql).toMatch(
      /ALTER TABLE "operations"\s+ADD COLUMN "entity_ids" TEXT\[\] NOT NULL DEFAULT '\{\}'/i,
    );
    expect(migrationSql).not.toMatch(/\bUPDATE\b/i);
    expect(migrationSql).not.toMatch(/\bUSING\b/i);
    expect(migrationSql).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(migrationSql).not.toMatch(/\bBEGIN\b|\bCOMMIT\b/i);
  });

  it('adds the entity_ids GIN index concurrently as a single native-apply statement', () => {
    const migrationSql = readMigration(
      '20260613000001_add_operation_entity_ids_gin_index',
    );

    expect(migrationSql).toContain('CREATE INDEX CONCURRENTLY');
    expect(migrationSql).toContain('"operations_entity_ids_gin"');
    expect(migrationSql).toContain('USING GIN ("entity_ids")');
    // Bare CREATE (no IF NOT EXISTS / no drop-then-create): an interrupted concurrent
    // build must fail loudly, matching the 20260511000000 precedent.
    expect(migrationSql).not.toMatch(/\bIF\s+NOT\s+EXISTS\b/i);
    expect(migrationSql).not.toMatch(/\bALTER\s+TABLE\b/i);
    expect(migrationSql).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(migrationSql).not.toMatch(/\bBEGIN\b|\bCOMMIT\b/i);
  });

  it('backfills operation payload bytes with per-user batched updates', () => {
    const script = readFileSync(
      join(currentDir, '../scripts/migrate-payload-bytes.ts'),
      'utf8',
    );
    const packageJson = readFileSync(join(currentDir, '../package.json'), 'utf8');

    expect(script).toContain('SELECT DISTINCT user_id');
    // Batch size sized for throughput: a tiny batch made a 100M-row backfill take
    // tens of hours, prolonging the slow octet_length() quota fallback window.
    expect(script).toContain('const DEFAULT_BATCH_SIZE = 500');
    expect(script).toContain('const MAX_BATCH_SIZE = 1000');
    // The override is still clamped so a fat-fingered value cannot OOM the
    // Node process building the VALUES string.
    expect(script).toContain('Math.min(parsed, MAX_BATCH_SIZE)');
    expect(script).toContain('userId,');
    expect(script).toContain('FROM (VALUES ${values}) AS v(id, bytes)');
    expect(script).toContain('SET payload_bytes = v.bytes');
    expect(script).toContain('storage_used_bytes = usage.total_bytes');
    expect(packageJson).toContain(
      '"migrate-payload-bytes": "node dist/scripts/migrate-payload-bytes.js"',
    );
    expect(packageJson).toContain(
      '"migrate-payload-bytes:dev": "ts-node scripts/migrate-payload-bytes.ts"',
    );
    expect(script).not.toContain('prisma.operation.update({');
  });
});

// Regression coverage for issue #8187: the migration chain must be able to
// create a fresh database on its own, and must stay in sync with schema.prisma.
describe('schema bootstrap and drift (#8187)', () => {
  const migrationNames = (): string[] =>
    readdirSync(migrationsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

  it('starts with a baseline that creates the base tables (no ALTER on a missing table)', () => {
    const sql = readMigration('0_init');

    // migrate deploy applies migrations in lexicographic order; the baseline
    // must sort before the first incremental (ALTER-only) migration so the
    // tables those migrations ALTER actually exist on a fresh database.
    expect(migrationNames()[0]).toBe('0_init');

    for (const table of ['users', 'operations', 'user_sync_state', 'sync_devices']) {
      expect(sql).toContain(`CREATE TABLE "${table}"`);
    }
  });

  it('adds the magic-link login_token columns and index that schema.prisma requires', () => {
    const sql = readMigration('20260601000000_add_login_token');

    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS "login_token" TEXT/i);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS "login_token_expires_at" BIGINT/i);
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS "users_login_token_idx" ON "users"\("login_token"\)/i,
    );
  });

  it('keeps every @map column in schema.prisma backed by a migration', () => {
    const schema = readFileSync(join(currentDir, '../prisma/schema.prisma'), 'utf8');
    const migrations = allMigrationSql();

    // The #8187 root cause was a column declared in schema.prisma (login_token)
    // with no migration creating it, so a migrate-only database crashed at
    // runtime with `column users.login_token does not exist`. Guard the whole
    // bug class: every `@map("col")` (single @, so model `@@map` table names are
    // excluded by the lookbehind) must appear as a quoted identifier in some
    // migration. Quoting avoids substring matches (e.g. "login_token" must not
    // be satisfied by "login_token_expires_at").
    const mappedColumns = [...schema.matchAll(/(?<!@)@map\("([^"]+)"\)/g)].map(
      (match) => match[1],
    );
    expect(mappedColumns.length).toBeGreaterThan(0);

    const missing = mappedColumns.filter((column) => !migrations.includes(`"${column}"`));
    expect(missing).toEqual([]);
  });
});

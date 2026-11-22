/**
 * The import check's own process: how each way it can end answers.
 * Runs dist/import-check.js, the file that ships; `npm test` builds it first (build:app-rules). Synthetic data only.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ImportCheckUnavailableError,
  runImportCheck,
  type ImportCheckOptions,
} from '../src/import-check';

const CHECK = join(__dirname, '../dist/import-check.js');
const dir = mkdtempSync(join(tmpdir(), 'import-check-test-'));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A stand-in check process that only does `code`. */
const script = (name: string, code: string): ImportCheckOptions => {
  const path = join(dir, `${name}.mjs`);
  writeFileSync(path, code);
  return { path };
};

const run = (body: string, opts: ImportCheckOptions): ReturnType<typeof runImportCheck> =>
  runImportCheck({ body: Buffer.from(body) }, opts);

describe('import check process', () => {
  it('refuses as too large when the check runs out of its heap', async () => {
    const entries = Array.from({ length: 1_000_000 }, (_, i) => `"k${i}":0`);
    const res = await run(`{${entries.join(',')}}`, { path: CHECK, heapMb: 48 });
    expect(res).toEqual({
      accepted: false,
      reason: 'too-large',
      errors: ['needs more than the 48 MB the import check may use'],
    });
  }, 60_000);

  it('refuses as too large when something else kills the check, as the kernel does when memory runs out', async () => {
    const res = await run(
      '{}',
      script('killed', "process.kill(process.pid, 'SIGKILL');"),
    );
    expect(res).toMatchObject({ accepted: false, reason: 'too-large' });
  });

  it('cannot check, rather than refusing, when the check fails for another reason, runs too long or cannot start', async () => {
    await expect(run('{}', script('crash', 'process.exit(3);'))).rejects.toThrow(
      new ImportCheckUnavailableError('the import check stopped (exit code 3)'),
    );
    await expect(
      run('{}', { ...script('hang', 'setInterval(() => {}, 1000);'), timeoutMs: 300 }),
    ).rejects.toThrow('did not finish within 0.3s');
    await expect(run('{}', { path: join(dir, 'missing.mjs') })).rejects.toBeInstanceOf(
      ImportCheckUnavailableError,
    );
  });

  it('cannot check when the result is cut short', async () => {
    // A header that announces more bytes than follow.
    const res = run(
      '{}',
      script(
        'short',
        `import { writeSync } from 'node:fs';
writeSync(3, JSON.stringify({ accepted: true, bytes: 10, migratedLegacy: false, repaired: false, counts: {}, schemaVersion: 1 }) + '\\n' + 'abc');`,
      ),
    );
    await expect(res).rejects.toThrow('the import check gave no complete result');
  });
});

/** The import upload on the bridge's main thread, in a child process with the bridge's heap cap. */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('import upload', () => {
  it('encrypts and sends a 40 MiB board without running out of a 96 MB heap', () => {
    const run = spawnSync(
      process.execPath,
      [
        '--max-old-space-size=96',
        '--import',
        'tsx',
        join(__dirname, 'large-upload-child.ts'),
        '40',
      ],
      { encoding: 'utf8', cwd: join(__dirname, '..') },
    );
    expect({
      status: run.status,
      out: run.stdout,
      err: run.stderr.slice(-300),
    }).toMatchObject({
      status: 0,
      out: 'accepted true\n',
    });
  }, 120_000);
});

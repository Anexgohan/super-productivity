import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Shared rules are tested from source, so a stale shared-schema `dist/` can never test old rules.
  resolve: {
    alias: [
      {
        find: '@sp/shared-schema',
        replacement: fileURLToPath(
          new URL('../shared-schema/src/index.ts', import.meta.url),
        ),
      },
      {
        find: '@sp/sync-core',
        replacement: fileURLToPath(new URL('../sync-core/src/index.ts', import.meta.url)),
      },
      // Some app files import from the repo root (`src/...`), as the app's baseUrl allows; the worker build resolves them the same way.
      {
        find: /^src\//,
        replacement: fileURLToPath(new URL('../../src/', import.meta.url)),
      },
    ],
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    // scrypt at N=2^17 costs a few hundred ms per call, and shared CI runners are slower still.
    testTimeout: 30_000,
  },
});

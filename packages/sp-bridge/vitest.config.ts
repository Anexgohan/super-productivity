import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Shared rules are tested from source, so a stale shared-schema `dist/` can never test old rules.
  resolve: {
    alias: {
      '@sp/shared-schema': fileURLToPath(
        new URL('../shared-schema/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    // scrypt at N=2^17 costs a few hundred ms per call, and shared CI runners are slower still.
    testTimeout: 30_000,
  },
});

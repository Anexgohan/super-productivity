import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    // scrypt at N=2^17 costs a few hundred ms per call, and shared CI runners are slower still.
    testTimeout: 30_000,
  },
});

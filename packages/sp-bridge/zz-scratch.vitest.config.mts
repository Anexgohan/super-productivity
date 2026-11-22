import { defineConfig } from 'vitest/config';
export default defineConfig({
  resolve: {
    alias: [
      { find: /^src\//, replacement: '/root/anex/super-productivity/src/' },
      {
        find: '@sp/shared-schema',
        replacement: '/root/anex/super-productivity/packages/shared-schema/src/index.ts',
      },
      {
        find: '@sp/sync-core',
        replacement: '/root/anex/super-productivity/packages/sync-core/src/index.ts',
      },
    ],
  },
  test: { globals: true, environment: 'node', include: ['tests/zz-*.spec.ts'] },
});

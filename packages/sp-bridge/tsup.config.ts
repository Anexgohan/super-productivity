import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  // Matches the runtime image (node:24-alpine). Must be >= node22 or esbuild
  // does not know `node:sqlite` is a builtin and rewrites it to a bare
  // `sqlite` import, which fails at startup.
  target: 'node22',
  // Belt and braces: keep the node: specifier verbatim regardless of target.
  external: ['node:sqlite'],
  clean: true,
  sourcemap: false,
  dts: false,
});

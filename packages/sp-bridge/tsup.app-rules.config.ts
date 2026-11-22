import { resolve } from 'node:path';
import { defineConfig } from 'tsup';
import type { Plugin } from 'esbuild';
import { typiaTransformPlugin } from './app-rules/typia-plugin';

/**
 * App rules bundle (anex/app-rules): the app's own reducers and archive code, built into one self-contained file.
 *
 * Built from the app's source with the app's compiler settings, so it needs the repo root's packages at build time (the image's
 * build stage installs them) and none at runtime. Runs after the bridge's own build: separate configs, so neither cleans the other's output.
 */

/** Angular's production build swaps environment.ts for environment.prod.ts (angular.json fileReplacements); so do the app rules. */
const productionEnvironment: Plugin = {
  name: 'production-environment',
  setup: (build) => {
    build.onResolve({ filter: /\/environments\/environment$/ }, (args) => ({
      path: resolve(args.resolveDir, `${args.path}.prod.ts`),
    }));
  },
};

export default defineConfig({
  // The import check runs in a process of its own (src/import-check.ts), so it is a file of its own.
  entry: {
    'app-rules-worker': 'app-rules/worker.ts',
    'import-check': 'app-rules/import-check.ts',
  },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  tsconfig: 'app-rules/tsconfig.json',
  // Bundle every package, so the runtime image needs none of the app's dependencies.
  noExternal: [/.*/],
  // Some bundled CommonJS code calls require(); an ES module has none until one is made.
  banner: {
    js: "import { createRequire as __spCreateRequire } from 'node:module'; const require = __spCreateRequire(import.meta.url);",
  },
  esbuildPlugins: [
    productionEnvironment,
    typiaTransformPlugin(
      resolve(__dirname, '../..'),
      resolve(__dirname, 'app-rules/tsconfig.json'),
    ),
  ],
  outDir: 'dist',
  clean: false,
  sourcemap: false,
  dts: false,
  splitting: false,
});

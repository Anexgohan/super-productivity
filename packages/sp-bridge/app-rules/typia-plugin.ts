/**
 * Build-time typia transform for the app rules bundle (anex/state-check).
 *
 * The app validates data with `typia.createValidate<T>()`, which only works after typia's TypeScript transform has rewritten
 * the call into generated validation code. The app's Angular build gets that transform through ts-patch; esbuild never runs
 * TypeScript transforms, so untransformed calls throw at runtime ("no transform has been configured").
 * This plugin compiles just the app files that import typia through TypeScript with typia's transform, and lets esbuild
 * handle everything else as usual. It uses the root's own typescript and typia, so no new packages.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import type { Plugin } from 'esbuild';
import type * as TS from 'typescript';

const IMPORTS_TYPIA = /from\s+['"]typia['"]/;

const typiaFiles = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) typiaFiles(path, out);
    else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.spec.ts') &&
      IMPORTS_TYPIA.test(readFileSync(path, 'utf-8'))
    ) {
      out.push(path);
    }
  }
  return out;
};

export const typiaTransformPlugin = (repoRoot: string, tsconfigPath: string): Plugin => ({
  name: 'typia-transform',
  setup: (build) => {
    const require = createRequire(join(repoRoot, 'package.json'));
    const ts = require('typescript') as typeof TS;
    const typiaTransform = (require('typia/lib/transform') as { default: TypiaTransform })
      .default;
    const appDir = resolve(repoRoot, 'src/app');

    let program: TS.Program | undefined;
    const getProgram = (): TS.Program => {
      if (program) return program;
      const config = ts.readConfigFile(tsconfigPath, (p) => ts.sys.readFile(p));
      const parsed = ts.parseJsonConfigFileContent(
        config.config,
        ts.sys,
        dirname(tsconfigPath),
      );
      program = ts.createProgram(typiaFiles(appDir), {
        ...parsed.options,
        noEmit: false,
        declaration: false,
        sourceMap: false,
        // Angular's compiler does not emit decorator metadata either; with it, type-only imports would turn into runtime imports.
        emitDecoratorMetadata: false,
        module: ts.ModuleKind.ESNext,
      });
      return program;
    };

    build.onLoad({ filter: /\/src\/app\/.*\.ts$/ }, (args) => {
      const source = readFileSync(args.path, 'utf-8');
      if (!IMPORTS_TYPIA.test(source)) return undefined;

      const prog = getProgram();
      const file = prog.getSourceFile(args.path);
      if (!file) throw new Error(`typia-transform: ${args.path} is not in the program`);
      const problems: string[] = [];
      const transformer = typiaTransform(prog, undefined, {
        addDiagnostic: (d: TS.Diagnostic) => {
          problems.push(ts.flattenDiagnosticMessageText(d.messageText, '\n'));
          return 0;
        },
      });
      let js = '';
      prog.emit(
        file,
        (name, text) => {
          if (name.endsWith('.js')) js = text;
        },
        undefined,
        false,
        { before: [transformer] },
      );
      if (problems.length)
        throw new Error(`typia-transform: ${args.path}: ${problems.join('; ')}`);
      if (!js) throw new Error(`typia-transform: no output for ${args.path}`);
      return { contents: js, loader: 'js', resolveDir: dirname(args.path) };
    });
  },
});

type TypiaTransform = (
  program: TS.Program,
  options: undefined,
  extras: { addDiagnostic: (d: TS.Diagnostic) => number },
) => TS.TransformerFactory<TS.SourceFile>;

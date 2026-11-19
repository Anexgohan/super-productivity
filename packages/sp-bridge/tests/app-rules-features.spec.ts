import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The app rules assemble the app's root reducer by hand (app-rules/root-reducer.ts), since the app's feature module also
 * pulls in effects and components. A feature registered in the app but missing from the app rules would silently drop that
 * slice of state, so this fails the moment the two lists differ.
 */
const read = (path: string): string => readFileSync(join(__dirname, path), 'utf-8');

describe('app rules root reducer', () => {
  it('registers every store feature the app registers', () => {
    const app = read('../../../src/app/root-store/feature-stores.module.ts');
    const appRules = read('../app-rules/root-reducer.ts');

    const features = [...app.matchAll(/StoreModule\.forFeature\(([^)]*)\)/g)].map((m) => {
      const args = m[1].split(',').map((a) => a.trim());
      // forFeature(feature) passes a createFeature object; forFeature(KEY, reducer) a key and reducer.
      return args.length === 1 ? `${args[0]}.reducer` : args[1];
    });

    expect(features.length).toBeGreaterThan(20);
    const missing = features.filter((ref) => !appRules.includes(ref));
    expect(missing).toEqual([]);
  });
});

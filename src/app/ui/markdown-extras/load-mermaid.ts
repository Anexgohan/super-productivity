/**
 * The one place Mermaid is imported, so the test build can swap it for `load-mermaid.stub.ts` (angular.json, test fileReplacements).
 * Mermaid and its dependencies are thousands of modules; no spec draws a diagram, and compiling them pushed the Karma build out of memory.
 */
export const loadMermaid = (): Promise<typeof import('mermaid').default> =>
  import('mermaid').then((m) => m.default);

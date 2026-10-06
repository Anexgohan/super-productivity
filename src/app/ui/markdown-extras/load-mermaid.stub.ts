/** Test-build stand-in for `load-mermaid.ts`: keeps Mermaid out of the Karma bundle. A spec that reaches it fails loudly instead of drawing. */
export const loadMermaid = (): Promise<typeof import('mermaid').default> =>
  Promise.reject(new Error('Mermaid is not bundled into unit tests'));

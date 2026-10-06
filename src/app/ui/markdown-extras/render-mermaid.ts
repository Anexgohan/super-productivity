/**
 * Draws the Mermaid diagrams in a rendered note.
 * Mermaid is large, so it is imported the first time a note actually contains a diagram, never at app start.
 * A note re-renders on every edit, so drawn diagrams are cached by source and theme and only a changed diagram is drawn again.
 * Mermaid runs in its `strict` security level, which sanitizes its own SVG.
 * That SVG is inserted after the note filter, because the filter refuses the `<style>` Mermaid needs.
 */

type MermaidApi = typeof import('mermaid').default;

export interface MermaidTheme {
  isDark: boolean;
  fontFamily: string;
}

const CACHE_LIMIT = 50;
const cache = new Map<string, string>();

let mermaidPromise: Promise<MermaidApi> | null = null;
let queue: Promise<unknown> = Promise.resolve();
let renderCount = 0;

const loadMermaid = (): Promise<MermaidApi> => {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => m.default);
  }
  return mermaidPromise;
};

const remember = (key: string, svg: string): void => {
  cache.delete(key);
  cache.set(key, svg);
  if (cache.size > CACHE_LIMIT) {
    cache.delete(cache.keys().next().value as string);
  }
};

/** Mermaid keeps global state, so diagrams are drawn strictly one after another. */
const drawSerially = (
  source: string,
  theme: MermaidTheme,
): Promise<{ svg: string } | { error: string }> => {
  const job = queue.then(async () => {
    const mermaid = await loadMermaid();
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: theme.isDark ? 'dark' : 'default',
      fontFamily: theme.fontFamily,
    });
    try {
      // parse() first, because a failed render() can leave its error graphic attached to the page.
      await mermaid.parse(source);
      const { svg } = await mermaid.render(`note-mermaid-${++renderCount}`, source);
      return { svg };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });
  queue = job.catch(() => undefined);
  return job;
};

const showError = (block: HTMLElement, message: string): void => {
  block.querySelector('.mermaid-error')?.remove();
  const errorEl = document.createElement('div');
  errorEl.className = 'mermaid-error';
  errorEl.textContent = message.split('\n')[0];
  block.append(errorEl);
};

/** Draws every diagram not drawn yet; `redraw` draws all of them again, for a theme change. */
export const renderMermaidBlocks = async (
  container: HTMLElement,
  theme: MermaidTheme,
  redraw = false,
): Promise<void> => {
  const blocks = Array.from(
    container.querySelectorAll<HTMLElement>(
      redraw ? '.mermaid-block' : '.mermaid-block:not(.is-drawn)',
    ),
  );
  for (const block of blocks) {
    const source = block.querySelector('.mermaid-src')?.textContent ?? '';
    if (!source.trim()) continue;
    const key = `${theme.isDark ? 'dark' : 'light'}|${theme.fontFamily}|${source}`;
    const cached = cache.get(key);
    const result = cached ? { svg: cached } : await drawSerially(source, theme);
    // The note may have re-rendered while Mermaid was busy, leaving this block detached.
    if (!block.isConnected) continue;
    if ('svg' in result) {
      remember(key, result.svg);
      block.querySelector('.mermaid-error')?.remove();
      // The source stays in the block, hidden, so a theme change can draw the diagram again.
      let svgEl = block.querySelector<HTMLElement>('.mermaid-svg');
      if (!svgEl) {
        svgEl = document.createElement('div');
        svgEl.className = 'mermaid-svg';
        block.append(svgEl);
      }
      svgEl.innerHTML = result.svg;
      block.classList.add('is-drawn');
    } else {
      showError(block, result.error);
    }
  }
};

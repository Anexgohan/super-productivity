import { escapeHtml } from '../../util/escape-html';

/**
 * Code blocks in notes: a copy button, the language as a class for `highlight-code.ts` to colour later.
 * A `mermaid` block becomes the placeholder its diagram is drawn into.
 * Highlighting happens after render, so highlight.js loads only when a note has code and never at app start.
 */

export const MERMAID_LANG = 'mermaid';

/** The fence's info string can carry more than the language (```ts title=x), so only its first word counts. */
const languageOf = (lang: string | undefined): string =>
  (lang ?? '').trim().split(/\s+/)[0].toLowerCase();

/** A class name is all that reaches the page, so anything outside a plain language name is dropped. */
const SAFE_LANGUAGE = /^[a-z0-9_+#.-]+$/;

/** HTML for a fenced or indented code block; the copy button, highlighting and Mermaid are wired up by `NoteMarkdownExtrasDirective`. */
export const renderCodeBlock = (code: string, lang: string | undefined): string => {
  const language = languageOf(lang);
  if (language === MERMAID_LANG) {
    return `<div class="mermaid-block"><pre class="mermaid-src"><code>${escapeHtml(code)}</code></pre></div>\n`;
  }
  const langClass = SAFE_LANGUAGE.test(language)
    ? ` class="language-${escapeHtml(language)}"`
    : '';
  return (
    `<div class="code-block">` +
    `<button type="button" class="code-copy-btn" title="Copy code" aria-label="Copy code">` +
    `<span class="material-icons">content_copy</span></button>` +
    `<pre><code${langClass}>${escapeHtml(code)}</code></pre></div>\n`
  );
};

import { Marked, type Token, type Tokens } from 'marked';
import { markedOptionsFactory } from '../marked-options-factory';
import { noteMarkedExtensions } from '../markdown-extras/note-markdown-config';

/**
 * Scroll sync for the full-screen split view: scrolling either half keeps the other on the same part of the note.
 * The preview's source gets an empty `<div data-source-line>` before each top-level block, so each rendered block names its source line.
 * List items and table rows carry their own lines too, so a long checklist or table follows row by row rather than as one block.
 * Between two known points the position is interpolated, and the two ends always meet.
 */

export const SOURCE_LINE_ATTR = 'data-source-line';
export const ITEM_LINES_ATTR = 'data-item-lines';

/** Blocks that render an element; blank space and link or footnote definitions leave nothing to anchor to. */
const ANCHORED_TOKENS = new Set([
  'heading',
  'paragraph',
  'list',
  'code',
  'table',
  'blockquote',
  'hr',
  'html',
  'noteAlert',
]);

const countNewlines = (text: string): number => text.split('\n').length - 1;

/** What may lie between two tokens: blank lines, and link definitions, which get no token once a label repeats (the `[//]: #` comment idiom). */
const isSkippableGap = (gap: string): boolean =>
  gap.split('\n').every((l) => !l.trim() || /^ {0,3}\[[^\]\n]+\]:/.test(l));

/** Source lines of a list's top-level items or a table's rows (header first), in render order. */
const itemLinesOf = (token: Token, line: number): number[] | undefined => {
  if (token.type === 'table') {
    // One line per row, with the delimiter row between the header and the body.
    const rows = (token as Tokens.Table).rows.length;
    return [line, ...Array.from({ length: rows }, (_, i) => line + 2 + i)];
  }
  if (token.type !== 'list') return undefined;
  const lines: number[] = [];
  let cursor = 0;
  for (const item of (token as Tokens.List).items) {
    const at = token.raw.indexOf(item.raw, cursor);
    if (at < 0) return undefined;
    lines.push(line + countNewlines(token.raw.slice(0, at)));
    cursor = at + item.raw.length;
  }
  return lines;
};

/**
 * Returns the note with a line marker before each top-level block after the first, or the note untouched when it cannot be tagged safely.
 * Markers go only where the lexer, configured exactly as the render is, already ends one block and starts the next.
 * An HTML block there ends at the blank line that follows it and changes nothing else, and an empty div takes no space.
 */
export const addSourceLineMarkers = (markdown: string): string => {
  const src = markdown.replace(/\r\n|\r/g, '\n');
  let tokens: Token[];
  try {
    const { gfm, breaks, pedantic } = markedOptionsFactory();
    // A fresh instance each time: marked-footnote keeps state that only a full render resets, and lexing on the shared instance would leave it stale.
    tokens = new Marked({ gfm, breaks, pedantic }, ...noteMarkedExtensions()).lexer(src);
  } catch {
    return markdown;
  }

  let out = '';
  // How much of the source has been copied out, and the line that point is on.
  let offset = 0;
  let line = 0;
  let hasBlock = false;
  for (const token of tokens) {
    // Added by marked-footnote to collect the definitions; it is not part of the source.
    if (token.type === 'footnotes') continue;
    // marked moves trailing newlines between tokens (a leading blank line can land on the footnotes token), so only the rest must match.
    const raw = token.raw.trimEnd();
    if (!raw) continue;
    const at = src.indexOf(raw, offset);
    // Anything else between one token and the next means the tokens no longer spell out the source.
    if (at < 0 || !isSkippableGap(src.slice(offset, at))) return markdown;
    out += src.slice(offset, at);
    line += countNewlines(src.slice(offset, at));
    if (ANCHORED_TOKENS.has(token.type)) {
      // Not before the first block, where a marker would take `:first-child` and with it the top margin reset.
      if (hasBlock && src[at - 1] === '\n') {
        const items = itemLinesOf(token, line);
        const itemAttr = items ? ` ${ITEM_LINES_ATTR}="${items.join(',')}"` : '';
        out += `<div ${SOURCE_LINE_ATTR}="${line}"${itemAttr}></div>\n\n`;
      }
      hasBlock = true;
    }
    out += raw;
    offset = at + raw.length;
    line += countNewlines(raw);
  }
  return out + src.slice(offset);
};

/** A source line and where its rendered element starts, in px from the top of the preview's content. */
export interface ScrollAnchor {
  line: number;
  y: number;
}

/** Reads the markers back out of the rendered preview. */
export const collectPreviewAnchors = (container: HTMLElement): ScrollAnchor[] => {
  const contentTop = container.getBoundingClientRect().top - container.scrollTop;
  const yOf = (el: Element): number => el.getBoundingClientRect().top - contentTop;
  const anchors: ScrollAnchor[] = [];
  container.querySelectorAll(`[${SOURCE_LINE_ATTR}]`).forEach((marker) => {
    // The block itself, not the marker: the marker sits somewhere inside the collapsed margin above it.
    const block = marker.nextElementSibling;
    if (!block) return;
    anchors.push({ line: Number(marker.getAttribute(SOURCE_LINE_ATTR)), y: yOf(block) });
    const itemLines = marker.getAttribute(ITEM_LINES_ATTR)?.split(',').map(Number);
    if (!itemLines) return;
    const items = block.querySelectorAll(block.matches('ul, ol') ? ':scope > li' : 'tr');
    if (items.length !== itemLines.length) return;
    items.forEach((item, i) => anchors.push({ line: itemLines[i], y: yOf(item) }));
  });
  return anchors;
};

/** Piecewise-linear lookup of `value` from the rising `from` positions onto the matching `to` positions. */
export const interpolate = (from: number[], to: number[], value: number): number => {
  if (value <= from[0]) return to[0];
  for (let i = 1; i < from.length; i++) {
    if (value <= from[i]) {
      const span = from[i] - from[i - 1];
      const t = span > 0 ? (value - from[i - 1]) / span : 0;
      const moved = (to[i] - to[i - 1]) * t;
      return to[i - 1] + moved;
    }
  }
  return to[to.length - 1];
};

/** The editor half: CodeMirror, or the plain text box while CodeMirror loads, which then follows by proportion. */
export interface ScrollSyncEditor {
  el: HTMLElement;
  lineTopPx?: (line: number) => number;
}

type Side = 'editor' | 'preview';

/** Keeps the two halves of the split view on the same part of the note while either one scrolls. */
export class MarkdownScrollSync {
  private _editor: ScrollSyncEditor | null = null;
  private _preview: HTMLElement | null = null;
  /** Where a scroll this class made put each half, so the event it fires back is not taken for the user's. */
  private readonly _expected = new Map<HTMLElement, number>();
  private _frame = 0;

  attach(editor: ScrollSyncEditor, preview: HTMLElement): void {
    if (this._editor?.el === editor.el && this._preview === preview) {
      this._editor = editor;
      return;
    }
    this.detach();
    this._editor = editor;
    this._preview = preview;
    editor.el.addEventListener('scroll', this._onEditorScroll, { passive: true });
    preview.addEventListener('scroll', this._onPreviewScroll, { passive: true });
  }

  detach(): void {
    cancelAnimationFrame(this._frame);
    this._editor?.el.removeEventListener('scroll', this._onEditorScroll);
    this._preview?.removeEventListener('scroll', this._onPreviewScroll);
    this._editor = null;
    this._preview = null;
    this._expected.clear();
  }

  /** After the preview re-renders, puts it back level with the editor, which is where the typing happens. */
  syncFromEditor(): void {
    this._schedule('editor');
  }

  private readonly _onEditorScroll = (): void => this._onScroll('editor');
  private readonly _onPreviewScroll = (): void => this._onScroll('preview');

  private _onScroll(side: Side): void {
    const el = side === 'editor' ? this._editor?.el : this._preview;
    if (!el) return;
    const expected = this._expected.get(el);
    if (expected !== undefined) {
      this._expected.delete(el);
      if (Math.abs(el.scrollTop - expected) <= 1) return;
    }
    this._schedule(side);
  }

  private _schedule(side: Side): void {
    cancelAnimationFrame(this._frame);
    this._frame = requestAnimationFrame(() => this._sync(side));
  }

  private _sync(side: Side): void {
    const editor = this._editor;
    const preview = this._preview;
    if (!editor || !preview) return;
    const from = side === 'editor' ? editor.el : preview;
    const to = side === 'editor' ? preview : editor.el;
    const fromMax = from.scrollHeight - from.clientHeight;
    const toMax = to.scrollHeight - to.clientHeight;
    if (fromMax <= 0 || toMax <= 0) return;

    let target: number;
    if (from.scrollTop >= fromMax - 1) {
      target = toMax;
    } else {
      const editorYs = [0];
      const previewYs = [0];
      const lineTopPx = editor.lineTopPx;
      if (lineTopPx) {
        for (const anchor of collectPreviewAnchors(preview)) {
          const editorY = lineTopPx(anchor.line);
          // Both sides have to rise together; a point that does not (an image still loading, say) is skipped.
          if (
            editorY > editorYs[editorYs.length - 1] &&
            anchor.y >= previewYs[previewYs.length - 1]
          ) {
            editorYs.push(editorY);
            previewYs.push(anchor.y);
          }
        }
      }
      editorYs.push(Math.max(editor.el.scrollHeight, editorYs[editorYs.length - 1] + 1));
      previewYs.push(Math.max(preview.scrollHeight, previewYs[previewYs.length - 1]));
      target =
        side === 'editor'
          ? interpolate(editorYs, previewYs, from.scrollTop)
          : interpolate(previewYs, editorYs, from.scrollTop);
    }

    to.scrollTop = target;
    // Read back: the browser clamps and rounds what it is given.
    this._expected.set(to, to.scrollTop);
  }
}

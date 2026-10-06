import { EditorSelection, EditorState, Prec } from '@codemirror/state';
import { EditorView, drawSelection, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import {
  bracketMatching,
  HighlightStyle,
  syntaxHighlighting,
} from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { tags } from '@lezer/highlight';
import { EditableText } from '../../core/clipboard-image/clipboard-paste-handler.service';

/**
 * The full-screen note editor: CodeMirror with markdown, highlighted code blocks, search and bracket matching.
 * This module is imported only when the full-screen editor opens, so CodeMirror never weighs on app start.
 * Code inside fenced blocks is highlighted by the language named after the fence; each language's parser loads on first use.
 * Colours come from the app theme's tokens, the same ones the rendered note uses.
 */

export interface NoteCodeEditorOptions {
  parent: HTMLElement;
  doc: string;
  selection?: { start: number; end: number };
  ariaLabel: string;
  onChange: (text: string) => void;
  /** Runs before CodeMirror's own keys; return true when the key was handled. */
  onKeydown: (ev: KeyboardEvent) => boolean;
  /** Return true when the paste was handled (an image), false to let the text paste through. */
  onPaste: (ev: ClipboardEvent) => boolean;
}

export interface NoteCodeEditor extends EditableText {
  /** Replaces the text with `text`, touching only the part that differs so undo and the cursor stay sensible. */
  setValue(text: string, selection?: { start: number; end: number }): void;
  destroy(): void;
}

const noteHighlightStyle = HighlightStyle.define([
  { tag: tags.heading, fontWeight: 'bold', color: 'var(--c-primary)' },
  { tag: tags.strong, fontWeight: 'bold' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: [tags.link, tags.url], color: 'var(--c-accent)' },
  { tag: tags.monospace, color: 'var(--c-warning, #c28a2b)' },
  { tag: tags.quote, color: 'var(--text-color-muted)', fontStyle: 'italic' },
  { tag: [tags.list, tags.processingInstruction], color: 'var(--c-primary)' },
  { tag: [tags.meta, tags.comment], color: 'var(--text-color-muted)' },
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier], color: 'var(--c-primary)' },
  {
    tag: [tags.string, tags.regexp, tags.special(tags.string)],
    color: 'var(--c-success, #4e9a4e)',
  },
  {
    tag: [tags.number, tags.bool, tags.null, tags.atom],
    color: 'var(--c-warning, #c28a2b)',
  },
  {
    tag: [
      tags.typeName,
      tags.className,
      tags.function(tags.variableName),
      tags.propertyName,
      tags.attributeName,
      tags.tagName,
    ],
    color: 'var(--c-accent)',
  },
  { tag: tags.invalid, color: 'var(--c-error, var(--c-warn))' },
]);

/* eslint-disable @typescript-eslint/naming-convention -- CodeMirror theme keys are CSS selectors */
const noteEditorTheme = EditorView.theme({
  '&': {
    height: '100%',
    color: 'inherit',
    backgroundColor: 'transparent',
    fontSize: '14px',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    lineHeight: '1.5',
    overflow: 'auto',
  },
  '.cm-content': { padding: 'var(--s) var(--s2)', caretColor: 'var(--c-primary)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--c-primary)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection':
    { backgroundColor: 'var(--c-dark-20)' },
  '.cm-matchingBracket': { backgroundColor: 'var(--c-dark-20)', outline: 'none' },
  '.cm-panels': { backgroundColor: 'var(--bg-lightest)', color: 'inherit' },
  '.cm-searchMatch': { backgroundColor: 'var(--c-dark-20)' },
  '.cm-searchMatch-selected': { backgroundColor: 'var(--c-dark-30)' },
});
/* eslint-enable @typescript-eslint/naming-convention */

const sel = (
  doc: string,
  s?: { start: number; end: number },
): EditorSelection | undefined =>
  s
    ? EditorSelection.single(Math.min(s.start, doc.length), Math.min(s.end, doc.length))
    : undefined;

export const createNoteCodeEditor = (opts: NoteCodeEditorOptions): NoteCodeEditor => {
  const view = new EditorView({
    parent: opts.parent,
    state: EditorState.create({
      doc: opts.doc,
      selection: sel(opts.doc, opts.selection),
      extensions: [
        // The note's own keys (formatting shortcuts, list continuation, Ctrl+Enter) come first, as they did in the plain text box.
        Prec.highest(
          EditorView.domEventHandlers({
            keydown: (ev) => opts.onKeydown(ev),
            paste: (ev) => opts.onPaste(ev),
          }),
        ),
        history(),
        drawSelection(),
        bracketMatching(),
        search({ top: true }),
        highlightSelectionMatches(),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
        markdown({
          base: markdownLanguage,
          codeLanguages: languages,
          addKeymap: false,
          completeHTMLTags: false,
        }),
        syntaxHighlighting(noteHighlightStyle),
        EditorView.lineWrapping,
        // eslint-disable-next-line @typescript-eslint/naming-convention
        EditorView.contentAttributes.of({ 'aria-label': opts.ariaLabel }),
        noteEditorTheme,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) opts.onChange(update.state.doc.toString());
        }),
      ],
    }),
  });

  return {
    get value() {
      return view.state.doc.toString();
    },
    get selectionStart() {
      return view.state.selection.main.from;
    },
    get selectionEnd() {
      return view.state.selection.main.to;
    },
    focus: () => view.focus(),
    setSelectionRange: (start, end) =>
      view.dispatch({ selection: sel(view.state.doc.toString(), { start, end }) }),
    setValue: (text, selection) => {
      const current = view.state.doc.toString();
      let from = 0;
      while (
        from < current.length &&
        from < text.length &&
        current[from] === text[from]
      ) {
        from++;
      }
      let toOld = current.length;
      let toNew = text.length;
      while (toOld > from && toNew > from && current[toOld - 1] === text[toNew - 1]) {
        toOld--;
        toNew--;
      }
      view.dispatch({
        changes:
          text === current
            ? undefined
            : { from, to: toOld, insert: text.slice(from, toNew) },
        selection: sel(text, selection),
      });
    },
    destroy: () => view.destroy(),
  };
};

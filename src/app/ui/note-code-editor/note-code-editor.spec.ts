import { createNoteCodeEditor, NoteCodeEditor } from './note-code-editor';

describe('createNoteCodeEditor', () => {
  let parent: HTMLElement;
  let editor: NoteCodeEditor;
  let changes: string[];

  const create = (
    doc: string,
    onKeydown: (ev: KeyboardEvent) => boolean = () => false,
  ): NoteCodeEditor =>
    createNoteCodeEditor({
      parent,
      doc,
      ariaLabel: 'Note',
      onChange: (text) => changes.push(text),
      onKeydown,
      onPaste: () => false,
    });

  beforeEach(() => {
    parent = document.createElement('div');
    document.body.appendChild(parent);
    changes = [];
  });

  afterEach(() => {
    editor?.destroy();
    parent.remove();
  });

  it('starts with the note text and reports edits', () => {
    editor = create('# Title');
    expect(editor.value).toBe('# Title');
    editor.setValue('# Title\n\nBody');
    expect(editor.value).toBe('# Title\n\nBody');
    expect(changes).toEqual(['# Title\n\nBody']);
  });

  it('does not report a change when the text is the same', () => {
    editor = create('same');
    editor.setValue('same', { start: 1, end: 2 });
    expect(changes).toEqual([]);
    expect(editor.selectionStart).toBe(1);
    expect(editor.selectionEnd).toBe(2);
  });

  it('sets and clamps the selection', () => {
    editor = create('abc');
    editor.setSelectionRange(1, 99);
    expect(editor.selectionStart).toBe(1);
    expect(editor.selectionEnd).toBe(3);
  });

  it('lets the note handle a key before CodeMirror does', () => {
    const seen: string[] = [];
    editor = create('x', (ev) => {
      seen.push(ev.key);
      return true;
    });
    parent
      .querySelector('.cm-content')!
      .dispatchEvent(
        new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true }),
      );
    expect(seen).toEqual(['b']);
  });
});

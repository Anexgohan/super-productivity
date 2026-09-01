import { selectElementText } from './select-element-text';

/**
 * Assertions read the RANGE, not `Selection.toString()`.
 * `Selection.toString()` returns rendered text, so under Karma's headless
 * iframe an appended-but-unlaid-out node yields '' even though the selection is
 * correct. `Range.toString()` concatenates the text nodes and is layout
 * independent, which is what we actually want to assert.
 */
const selectedText = (): string => {
  const selection = window.getSelection();
  return selection && selection.rangeCount > 0 ? selection.getRangeAt(0).toString() : '';
};

describe('selectElementText', () => {
  let el: HTMLElement;

  beforeEach(() => {
    el = document.createElement('code');
    document.body.appendChild(el);
  });

  afterEach(() => {
    window.getSelection()?.removeAllRanges();
    el.remove();
  });

  it('selects the element text so Ctrl+C works when a scripted copy is blocked', () => {
    el.textContent = 'spk_1_gYOdjEZyHNY8DLwD';

    expect(selectElementText(el)).toBe(true);
    expect(window.getSelection()?.rangeCount).toBe(1);
    expect(selectedText()).toBe('spk_1_gYOdjEZyHNY8DLwD');
  });

  it('reports false for an empty element, so no "press Ctrl+C" is promised', () => {
    el.textContent = '';
    expect(selectElementText(el)).toBe(false);
  });

  it('replaces any previous selection rather than adding to it', () => {
    const other = document.createElement('span');
    other.textContent = 'PREVIOUS';
    document.body.appendChild(other);
    selectElementText(other);

    el.textContent = 'spk_1_abc';
    selectElementText(el);

    expect(window.getSelection()?.rangeCount).toBe(1);
    expect(selectedText()).toBe('spk_1_abc');
    other.remove();
  });
});

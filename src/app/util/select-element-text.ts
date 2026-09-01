/**
 * Select an element's visible text, as a click-drag would.
 *
 * The point is that this is a REAL selection of on-screen text, so a content
 * blocker has nothing to object to: the scripted-clipboard techniques they
 * refuse all write from a hidden element the user never sees. With the text
 * selected, Ctrl+C always works even when a scripted copy is denied.
 *
 * Returns whether a selection was actually made, so callers can tell the user
 * "press Ctrl+C" only when that advice is true.
 */
export const selectElementText = (el: HTMLElement): boolean => {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return false;
  }
  const selection = window.getSelection();
  if (!selection || !el.textContent) {
    return false;
  }
  try {
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  } catch {
    return false;
  }
};

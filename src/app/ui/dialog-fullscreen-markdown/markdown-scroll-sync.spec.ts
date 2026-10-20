import {
  addSourceLineMarkers,
  collectPreviewAnchors,
  interpolate,
} from './markdown-scroll-sync';

describe('markdown scroll sync', () => {
  describe('addSourceLineMarkers', () => {
    it('tags every block after the first with its source line', () => {
      expect(addSourceLineMarkers('# A\n\nPara\n\n- x\n- y\n')).toBe(
        '# A\n\n<div data-source-line="2"></div>\n\nPara\n\n' +
          '<div data-source-line="4" data-item-lines="4,5"></div>\n\n- x\n- y\n',
      );
    });

    it('leaves a single block untouched', () => {
      expect(addSourceLineMarkers('Only one paragraph\n')).toBe('Only one paragraph\n');
    });

    it('counts lines in notes saved with Windows line endings', () => {
      expect(addSourceLineMarkers('# A\r\nB\r\n')).toBe(
        '# A\n<div data-source-line="1"></div>\n\nB\n',
      );
    });

    it('gives table rows their own lines, skipping the delimiter row', () => {
      expect(addSourceLineMarkers('# T\n\n| a |\n|---|\n| 1 |\n| 2 |\n')).toContain(
        '<div data-source-line="2" data-item-lines="2,4,5"></div>',
      );
    });

    it('keeps the first block unmarked when the note starts with a blank line and has footnotes', () => {
      expect(addSourceLineMarkers('\n# A\n\nB[^1]\n\n[^1]: n\n')).toBe(
        '\n# A\n\n<div data-source-line="3"></div>\n\nB[^1]\n\n[^1]: n\n',
      );
    });

    it('steps over repeated link definitions, which marked consumes without a token', () => {
      expect(
        addSourceLineMarkers('# A\n\n[x]: http://e.com\n[x]: http://f.com\n\nB\n'),
      ).toContain('<div data-source-line="5"></div>\n\nB\n');
    });
  });

  describe('interpolate', () => {
    const from = [0, 100, 200];
    const to = [0, 50, 400];

    it('maps linearly inside each segment', () => {
      expect(interpolate(from, to, 50)).toBe(25);
      expect(interpolate(from, to, 150)).toBe(225);
    });

    it('clamps outside the known range', () => {
      expect(interpolate(from, to, -5)).toBe(0);
      expect(interpolate(from, to, 300)).toBe(400);
    });

    it('does not divide by a zero-length segment', () => {
      expect(interpolate([0, 10, 10, 20], [0, 5, 9, 20], 10)).toBe(5);
    });
  });

  describe('collectPreviewAnchors', () => {
    let container: HTMLElement;

    beforeEach(() => {
      container = document.createElement('div');
      container.innerHTML =
        '<h1>A</h1><div data-source-line="2"></div><p>Para</p>' +
        '<div data-source-line="4" data-item-lines="4,5"></div><ul><li>x</li><li>y</li></ul>';
      document.body.appendChild(container);
    });

    afterEach(() => container.remove());

    it('reads the block lines and the list item lines back in document order', () => {
      const anchors = collectPreviewAnchors(container);
      expect(anchors.map((a) => a.line)).toEqual([2, 4, 4, 5]);
      for (let i = 1; i < anchors.length; i++) {
        expect(anchors[i].y).toBeGreaterThanOrEqual(anchors[i - 1].y);
      }
    });

    it('ignores item lines that no longer match the rendered items', () => {
      container.querySelector('li')!.remove();
      expect(collectPreviewAnchors(container).map((a) => a.line)).toEqual([2, 4]);
    });
  });
});

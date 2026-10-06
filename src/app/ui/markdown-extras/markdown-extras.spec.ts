import { Marked } from 'marked';
import markedFootnote from 'marked-footnote';
import { renderCodeBlock } from './code-block';
import { highlightCodeIn } from './highlight-code';
import { noteAlertsExtension } from './note-alerts';
import { sanitizeNoteHtml } from './sanitize-note-html';

const render = (md: string): string => {
  const marked = new Marked({ gfm: true, breaks: true });
  marked.use(markedFootnote(), noteAlertsExtension(), {
    renderer: {
      code: ({ text, lang }: { text: string; lang?: string }) =>
        renderCodeBlock(text.replace(/\n$/, ''), lang),
    },
  });
  return marked.parse(md) as string;
};

describe('markdown extras', () => {
  describe('renderCodeBlock', () => {
    it('marks the language for highlighting and adds a copy button', () => {
      const html = renderCodeBlock('const x = 1;', 'ts');
      expect(html).toContain('<code class="language-ts">const x = 1;</code>');
      expect(html).toContain('class="code-copy-btn"');
    });

    it('uses only the first word of the info string', () => {
      expect(renderCodeBlock('x = 1', 'python title=demo.py')).toContain(
        'class="language-python"',
      );
    });

    it('escapes the code and drops a language that is not a plain name', () => {
      const html = renderCodeBlock('<script>alert(1)</script>', '"><img');
      expect(html).not.toContain('<script>');
      expect(html).toContain('&lt;script&gt;');
      expect(html).not.toContain('language-');
    });

    it('turns a mermaid block into an escaped placeholder', () => {
      const html = renderCodeBlock('graph TD; A-->B', 'mermaid');
      expect(html).toContain('class="mermaid-block"');
      expect(html).toContain('A--&gt;B');
      expect(html).not.toContain('code-copy-btn');
    });
  });

  describe('highlightCodeIn', () => {
    const container = (html: string): HTMLElement => {
      const el = document.createElement('div');
      el.innerHTML = html;
      return el;
    };

    it('highlights a block in a bundled language', () => {
      const el = container(renderCodeBlock('const x = 1;', 'ts'));
      highlightCodeIn(el);
      const code = el.querySelector('code')!;
      expect(code.classList).toContain('hljs');
      expect(code.innerHTML).toContain('<span class="hljs-keyword">const</span>');
      expect(code.textContent).toBe('const x = 1;');
    });

    it('leaves an unknown language and its text untouched', () => {
      const el = container(renderCodeBlock('<b>x</b>', 'nosuchlang'));
      highlightCodeIn(el);
      const code = el.querySelector('code')!;
      expect(code.classList).not.toContain('hljs');
      expect(code.textContent).toBe('<b>x</b>');
      expect(code.querySelector('b')).toBeNull();
    });
  });

  describe('callouts', () => {
    it('renders each GitHub marker as a titled callout', () => {
      for (const type of ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION']) {
        const html = render(`> [!${type}]\n> Body **text**`);
        expect(html).toContain(`note-alert-${type.toLowerCase()}`);
        expect(html).toContain('<strong>text</strong>');
        expect(html).not.toContain('[!');
      }
    });

    it('leaves an ordinary blockquote alone', () => {
      const html = render('> just a quote');
      expect(html).toContain('<blockquote>');
      expect(html).not.toContain('note-alert');
    });

    it('needs the marker on its own first line', () => {
      expect(render('> text [!NOTE]')).not.toContain('note-alert');
    });
  });

  describe('footnotes', () => {
    it('links a reference to its footnote', () => {
      const html = render('Text[^1].\n\n[^1]: The note.');
      expect(html).toContain('href="#footnote-1"');
      expect(html).toContain('id="footnote-1"');
    });
  });

  describe('sanitizeNoteHtml', () => {
    it('drops script, handlers, javascript: links, frames and forms', () => {
      const out = sanitizeNoteHtml(
        '<script>x()</script><img src="a.png" onerror="x()">' +
          '<a href="javascript:x()">j</a><iframe src="https://e.x"></iframe>' +
          '<form><input name="p"></form>',
      );
      expect(out).not.toContain('<script');
      expect(out).not.toContain('onerror');
      expect(out).not.toContain('javascript:');
      expect(out).not.toContain('<iframe');
      expect(out).not.toContain('<form');
      expect(out).not.toContain('<input');
    });

    it('drops style attributes and style elements', () => {
      const out = sanitizeNoteHtml(
        '<div style="position:fixed;inset:0">x</div><style>body{}</style>',
      );
      expect(out).not.toContain('style');
    });

    it('keeps buttons, classes and footnote links, prefixing ids', () => {
      const out = sanitizeNoteHtml(
        '<button type="button" class="code-copy-btn">c</button>' +
          '<a href="#footnote-1">1</a><li id="footnote-1">n</li>',
      );
      expect(out).toContain('<button type="button" class="code-copy-btn">');
      expect(out).toContain('href="#footnote-1"');
      expect(out).toContain('id="user-content-footnote-1"');
    });

    it('keeps the link schemes the app allows and blob: images', () => {
      const out = sanitizeNoteHtml(
        '<a href="https://e.x" target="_blank" rel="noopener">w</a>' +
          '<a href="obsidian://open?vault=v">o</a>' +
          '<img src="blob:https://app/123" loading="lazy">',
      );
      expect(out).toContain('href="https://e.x"');
      expect(out).toContain('target="_blank"');
      expect(out).toContain('href="obsidian://open?vault=v"');
      expect(out).toContain('src="blob:https://app/123"');
      expect(out).toContain('loading="lazy"');
    });

    it('drops a scheme the app does not allow', () => {
      expect(sanitizeNoteHtml('<a href="ms-msdt:x">m</a>')).not.toContain('ms-msdt');
    });
  });
});

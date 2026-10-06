import { marked } from 'marked';
import { markedOptionsFactory, noteMarkedExtension } from './marked-options-factory';
import { sanitizeNoteHtml } from './markdown-extras/sanitize-note-html';

/**
 * End-to-end sanitization contract for the note render surfaces
 * (inline-markdown, dialog-fullscreen-markdown, dialog-view-archived-task).
 *
 * At runtime ngx-markdown runs our rendered output through `sanitizeNoteHtml`
 * (main.ts provides it as SANITIZE), the fork's DOMPurify filter that replaced
 * Angular's fixed SecurityContext.HTML allowlist.
 * See ngx-markdown MarkdownService: `disableSanitizer ? marked : sanitizeHtml(marked)`.
 *
 * This guards GHSA-4rrp-xhp8-hf4p (stored XSS via raw HTML in task notes):
 *  - injected event-handler attributes / script must be stripped, AND
 *  - the custom renderer's legitimate output (checkboxes, links, sized & pasted
 *    images, tables) must still survive sanitization.
 *
 * If anyone re-adds disableSanitizer to those surfaces, the rendering still works
 * but this contract no longer protects users — keep these surfaces sanitized.
 */
const renderAsApp = (markdown: string): string => {
  marked.setOptions(marked.getDefaults());
  marked.use(noteMarkedExtension());
  marked.setOptions(markedOptionsFactory());
  const html = marked.parse(markdown) as string;
  return sanitizeNoteHtml(html);
};

describe('markdown note sanitization (GHSA-4rrp-xhp8-hf4p)', () => {
  describe('strips XSS vectors', () => {
    it('removes onerror from a raw <img> in the note body', () => {
      const out = renderAsApp('<img src=x onerror="alert(document.domain)">');
      expect(out).not.toContain('onerror');
      expect(out.toLowerCase()).not.toContain('alert(');
    });

    it('removes onload from raw <svg>', () => {
      expect(renderAsApp('<svg onload=alert(1)>')).not.toContain('onload');
    });

    it('removes ontoggle from <details>', () => {
      const out = renderAsApp('<details open ontoggle=alert(1)>x</details>');
      expect(out).not.toContain('ontoggle');
    });

    it('removes onmouseover from an arbitrary injected element', () => {
      const out = renderAsApp('<a href="#" onmouseover="alert(1)">x</a>');
      expect(out).not.toContain('onmouseover');
    });

    it('drops <script> content', () => {
      const out = renderAsApp('<script>alert(1)</script>');
      expect(out.toLowerCase()).not.toContain('<script');
    });

    it('neutralizes a javascript: link href', () => {
      const out = renderAsApp('[click](javascript:alert(1))');
      expect(out).not.toContain('href="javascript:');
    });
  });

  describe('preserves legitimate rendering', () => {
    it('keeps the custom checkbox markup', () => {
      const out = renderAsApp('- [ ] todo\n- [x] done');
      expect(out).toContain('checkbox-wrapper');
      expect(out).toContain('check_box_outline_blank');
      expect(out).toContain('check_box');
      expect(out).toContain('material-icons');
      expect(out).not.toContain('<input');
    });

    it('keeps links with target="_blank"', () => {
      const out = renderAsApp('[link](https://example.com)');
      expect(out).toContain('href="https://example.com"');
      expect(out).toContain('target="_blank"');
    });

    it('keeps pasted (blob:) and data: image sources', () => {
      expect(renderAsApp('![a](blob:https://app/abc-123)')).toContain(
        'src="blob:https://app/abc-123"',
      );
      expect(renderAsApp('![a](data:image/png;base64,iVBORw0KGgo=)')).toContain(
        'src="data:image/png;base64,iVBORw0KGgo="',
      );
    });

    it('keeps width/height from the =WxH sizing syntax', () => {
      const out = renderAsApp('![a](https://x/y.png =200x150)');
      expect(out).toContain('width="200"');
      expect(out).toContain('height="150"');
    });

    it('keeps tables', () => {
      const out = renderAsApp('| a | b |\n| - | - |\n| 1 | 2 |');
      expect(out).toContain('<table');
      expect(out).toContain('<td');
    });

    it('keeps headings, emphasis and code', () => {
      const out = renderAsApp('# Title\n\n**bold** `code`');
      expect(out).toContain('<h1');
      expect(out).toContain('<strong>bold</strong>');
      expect(out).toContain('<code>code</code>');
    });
  });
});

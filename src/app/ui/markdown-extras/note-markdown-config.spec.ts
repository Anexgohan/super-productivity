import { TestBed } from '@angular/core/testing';
import { MarkdownService, provideMarkdown } from 'ngx-markdown';
import { noteMarkdownModuleConfig } from './note-markdown-config';

/**
 * Runs notes through ngx-markdown's own MarkdownService with the app's real config.
 * Rendering helpers alone missed that the per-call marked options replaced the registered extensions.
 * So footnotes and callouts never rendered in the app, while every helper-based spec passed.
 */
describe('note markdown, rendered as the app renders it', () => {
  let service: MarkdownService;

  const render = async (md: string): Promise<string> => await service.parse(md);

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideMarkdown(noteMarkdownModuleConfig())],
    });
    service = TestBed.inject(MarkdownService);
  });

  it('renders callouts', async () => {
    const html = await render('> [!WARNING]\n> Careful');
    expect(html).toContain('note-alert-warning');
    expect(html).not.toContain('[!WARNING]');
  });

  it('renders footnotes with linked, prefixed ids', async () => {
    const html = await render('Text[^1]\n\n[^1]: A footnote.');
    expect(html).toContain('href="#footnote-1"');
    expect(html).toContain('id="user-content-footnote-1"');
    expect(html).not.toContain('[^1]');
  });

  it('renders code blocks with a copy button and the language class', async () => {
    const html = await render('```ts\nconst x = 1;\n```');
    expect(html).toContain('class="code-copy-btn"');
    expect(html).toContain('class="language-ts"');
  });

  it('keeps the app syntax: webexteams auto-links and =WxH image sizing', async () => {
    expect(await render('webexteams://im?space=abc')).toContain(
      'href="webexteams://im?space=abc"',
    );
    const img = await render('![a](https://x/y.png =200x150)');
    expect(img).toContain('width="200"');
    expect(img).toContain('height="150"');
  });

  it('filters raw HTML through the note filter', async () => {
    const html = await render(
      '<img src="x" onerror="alert(1)"><div style="position:fixed">x</div>',
    );
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('style=');
  });
});

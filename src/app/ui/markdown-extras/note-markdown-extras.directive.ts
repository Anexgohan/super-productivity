import {
  DestroyRef,
  Directive,
  ElementRef,
  HostListener,
  inject,
  Injector,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DOCUMENT } from '@angular/common';
import { MarkdownComponent } from 'ngx-markdown';
import { BodyClass } from '../../app.constants';
import { ShareService } from '../../core/share/share.service';
import { NOTE_ID_PREFIX } from './sanitize-note-html';
import { MermaidTheme, renderMermaidBlocks } from './render-mermaid';

/**
 * The interactive parts of a rendered note: code highlighting and copy buttons, links to the note's own footnotes, and Mermaid diagrams.
 * Put it on every `<markdown>` that shows a note, so these work the same in the task panel, project notes and the full-screen editor.
 * It needs nothing beyond the markdown element until a note actually uses one of these, so hosting it costs a component nothing.
 */
@Directive({
  selector: 'markdown[noteMarkdownExtras]',
  standalone: true,
})
export class NoteMarkdownExtrasDirective {
  private readonly _host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly _document = inject(DOCUMENT);
  private readonly _injector = inject(Injector);
  private readonly _destroyRef = inject(DestroyRef);

  /** Watches light/dark mode, started only once this note has a diagram to recolour. */
  private _themeObserver: MutationObserver | null = null;
  private _isDarkDrawn: boolean | null = null;

  constructor() {
    inject(MarkdownComponent)
      .ready.pipe(takeUntilDestroyed(this._destroyRef))
      .subscribe(() => {
        void this._highlightCode();
        void this._drawDiagrams(false);
      });
    this._destroyRef.onDestroy(() => this._themeObserver?.disconnect());
  }

  @HostListener('click', ['$event'])
  onClick(ev: MouseEvent): void {
    const target = ev.target as HTMLElement;

    const copyBtn = target.closest<HTMLElement>('.code-copy-btn');
    if (copyBtn) {
      ev.preventDefault();
      ev.stopPropagation();
      const code = copyBtn.closest('.code-block')?.querySelector('pre code');
      // ShareService falls back to execCommand where the async Clipboard API is missing, as on a plain-HTTP deployment.
      void this._injector
        .get(ShareService)
        .copyToClipboard(code?.textContent ?? '', 'Code');
      return;
    }

    // Footnote links point inside the note; the app routes on the URL hash, so following them would navigate away instead of scrolling.
    const link = target.closest<HTMLAnchorElement>('a[href^="#"]');
    if (link) {
      ev.preventDefault();
      ev.stopPropagation();
      const fragment = decodeURIComponent(link.getAttribute('href')!.slice(1));
      // Scoped to this note: several notes on one page can each have a footnote 1.
      const dest = this._host.nativeElement.querySelector(
        `[id="${CSS.escape(NOTE_ID_PREFIX + fragment)}"]`,
      );
      dest?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  /** Every render replaces the note's HTML, so highlighting runs after each one; once loaded, the module answers before the next paint. */
  private async _highlightCode(): Promise<void> {
    const host = this._host.nativeElement;
    if (!host.querySelector('.code-block code[class*="language-"]')) return;
    const { highlightCodeIn } = await import('./highlight-code');
    highlightCodeIn(host);
  }

  private _isDark(): boolean {
    return this._document.body.classList.contains(BodyClass.isDarkTheme);
  }

  private async _drawDiagrams(redraw: boolean): Promise<void> {
    const host = this._host.nativeElement;
    if (!host.querySelector('.mermaid-block')) return;
    this._watchTheme();
    const theme: MermaidTheme = {
      isDark: this._isDark(),
      fontFamily: getComputedStyle(host).fontFamily,
    };
    this._isDarkDrawn = theme.isDark;
    await renderMermaidBlocks(host, theme, redraw);
  }

  /** Diagrams take their colours from light or dark mode, so a switch draws them again. */
  private _watchTheme(): void {
    if (this._themeObserver) return;
    this._themeObserver = new MutationObserver(() => {
      if (this._isDark() !== this._isDarkDrawn) {
        void this._drawDiagrams(true);
      }
    });
    this._themeObserver.observe(this._document.body, {
      attributes: true,
      attributeFilter: ['class'],
    });
  }
}

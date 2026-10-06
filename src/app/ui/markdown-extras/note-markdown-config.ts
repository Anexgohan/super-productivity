import markedFootnote from 'marked-footnote';
import {
  MARKED_EXTENSIONS,
  MARKED_OPTIONS,
  MarkdownModuleConfig,
  SANITIZE,
} from 'ngx-markdown';
import { markedOptionsFactory, noteMarkedExtension } from '../marked-options-factory';
import { noteAlertsExtension } from './note-alerts';
import { sanitizeNoteHtml } from './sanitize-note-html';

/** How every note renders: one definition for main.ts and for the spec that runs notes through ngx-markdown exactly as the app does. */
export const noteMarkdownModuleConfig = (): MarkdownModuleConfig => ({
  markedOptions: { provide: MARKED_OPTIONS, useFactory: markedOptionsFactory },
  markedExtensions: [noteMarkedExtension(), markedFootnote(), noteAlertsExtension()].map(
    (extension) => ({ provide: MARKED_EXTENSIONS, useValue: extension, multi: true }),
  ),
  sanitize: { provide: SANITIZE, useValue: sanitizeNoteHtml },
});

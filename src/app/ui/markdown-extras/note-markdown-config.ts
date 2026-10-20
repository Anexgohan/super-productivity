import markedFootnote from 'marked-footnote';
import type { MarkedExtension } from 'marked';
import {
  MARKED_EXTENSIONS,
  MARKED_OPTIONS,
  MarkdownModuleConfig,
  SANITIZE,
} from 'ngx-markdown';
import { markedOptionsFactory, noteMarkedExtension } from '../marked-options-factory';
import { noteAlertsExtension } from './note-alerts';
import { sanitizeNoteHtml } from './sanitize-note-html';

/** The marked extensions every note renders with; the full-screen preview's source-line pass lexes with them too, so its blocks match. */
export const noteMarkedExtensions = (): MarkedExtension[] => [
  noteMarkedExtension(),
  markedFootnote(),
  noteAlertsExtension(),
];

/** How every note renders: one definition for main.ts and for the spec that runs notes through ngx-markdown exactly as the app does. */
export const noteMarkdownModuleConfig = (): MarkdownModuleConfig => ({
  markedOptions: { provide: MARKED_OPTIONS, useFactory: markedOptionsFactory },
  markedExtensions: noteMarkedExtensions().map((extension) => ({
    provide: MARKED_EXTENSIONS,
    useValue: extension,
    multi: true,
  })),
  sanitize: { provide: SANITIZE, useValue: sanitizeNoteHtml },
});

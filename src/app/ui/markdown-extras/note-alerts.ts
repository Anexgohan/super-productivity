import type { MarkedExtension, Tokens } from 'marked';

/**
 * GitHub-style callouts: a blockquote whose first line is `[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]` or `[!CAUTION]`.
 * Any other blockquote, including one whose marker is not on its own first line, stays an ordinary blockquote.
 */
export const NOTE_ALERT_TYPES = [
  'note',
  'tip',
  'important',
  'warning',
  'caution',
] as const;

export type NoteAlertType = (typeof NOTE_ALERT_TYPES)[number];

const ALERT_META: Record<NoteAlertType, { title: string; icon: string }> = {
  note: { title: 'Note', icon: 'info' },
  tip: { title: 'Tip', icon: 'lightbulb' },
  important: { title: 'Important', icon: 'feedback' },
  warning: { title: 'Warning', icon: 'warning' },
  caution: { title: 'Caution', icon: 'report' },
};

/** The marker line, then every following line that still belongs to the blockquote. */
const ALERT_BLOCK_RE =
  /^ {0,3}> ?\[!(note|tip|important|warning|caution)\][ \t]*(?:\n|$)((?: {0,3}>[^\n]*(?:\n|$))*)/i;

interface NoteAlertToken extends Tokens.Generic {
  type: 'noteAlert';
  alertType: NoteAlertType;
  tokens: Tokens.Generic[];
}

export const noteAlertsExtension = (): MarkedExtension => ({
  extensions: [
    {
      name: 'noteAlert',
      level: 'block',
      start: (src: string) => src.match(/^ {0,3}> ?\[!/m)?.index,
      tokenizer(src: string): NoteAlertToken | undefined {
        const match = ALERT_BLOCK_RE.exec(src);
        if (!match) return undefined;
        const body = match[2].replace(/^ {0,3}> ?/gm, '');
        return {
          type: 'noteAlert',
          raw: match[0],
          alertType: match[1].toLowerCase() as NoteAlertType,
          tokens: this.lexer.blockTokens(body, []),
        };
      },
      renderer(token): string {
        const { alertType, tokens } = token as NoteAlertToken;
        const { title, icon } = ALERT_META[alertType];
        return (
          `<div class="note-alert note-alert-${alertType}">` +
          `<p class="note-alert-title"><span class="material-icons">${icon}</span>${title}</p>` +
          `${this.parser.parse(tokens)}</div>\n`
        );
      },
    },
  ],
});

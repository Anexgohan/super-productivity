/**
 * Colour overrides for rendered and edited notes, chosen per theme and per light/dark variant.
 * Stored as one JSON map under `LS.NOTE_COLORS`, which follows the account through `SyncedUiPrefsService`.
 */

export type NoteColorField = 'bg' | 'fg' | 'codeBg' | 'inlineCodeBg';

export type NoteColors = Partial<Record<NoteColorField, string>>;

export type NoteColorsByTheme = Record<string, NoteColors>;

export const NOTE_COLOR_FIELDS: readonly NoteColorField[] = [
  'bg',
  'fg',
  'codeBg',
  'inlineCodeBg',
];

/**
 * The CSS custom property each field sets, and the root class that switches its rules on in `note-colors.scss`.
 * With no class set, the theme's own colour stays.
 */
export const NOTE_COLOR_CSS: Record<
  NoteColorField,
  { cssVar: string; rootClass: string }
> = {
  bg: { cssVar: '--note-bg', rootClass: 'note-bg-set' },
  fg: { cssVar: '--note-fg', rootClass: 'note-fg-set' },
  codeBg: { cssVar: '--note-code-bg', rootClass: 'note-code-bg-set' },
  inlineCodeBg: { cssVar: '--note-inline-code-bg', rootClass: 'note-inline-code-bg-set' },
};

/** Neutrals that work as a note background, text or code-block colour: darks first, then lights. The picker's hue square covers anything else. */
export const NOTE_COLOR_PRESETS: readonly string[] = [
  '#111111',
  '#1a1a1a',
  '#202124',
  '#2b2b2b',
  '#1e2430',
  '#24273a',
  '#2e3440',
  '#3b3f45',
  '#ffffff',
  '#f5f5f5',
  '#eceff4',
  '#faf6ef',
  '#fdf6e3',
  '#d9d9d9',
  '#9e9e9e',
  '#5c5c5c',
];

/** What each picker shows while no colour is set: the theme colour that surface already uses. */
export const NOTE_COLOR_THEME_DEFAULTS: Record<NoteColorField, string> = {
  bg: 'var(--bg-lightest)',
  fg: 'var(--text-color)',
  codeBg: 'var(--c-dark-10)',
  // Inline code has no background of its own unless a theme gives it one.
  inlineCodeBg: 'transparent',
};

const HEX_COLOR = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;

/**
 * The pickers only produce #rrggbb, or #rrggbbaa for a see-through tint.
 * Anything else came from a corrupt or foreign value and is dropped rather than written into a style.
 */
const isNoteColor = (value: unknown): value is string =>
  typeof value === 'string' && HEX_COLOR.test(value);

export const noteColorsThemeKey = (themeValue: string, isDark: boolean): string =>
  `${themeValue}:${isDark ? 'dark' : 'light'}`;

export const parseNoteColors = (raw: string | null): NoteColorsByTheme => {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: NoteColorsByTheme = {};
  for (const [themeKey, colors] of Object.entries(parsed as Record<string, unknown>)) {
    if (!colors || typeof colors !== 'object') continue;
    const clean: NoteColors = {};
    for (const field of NOTE_COLOR_FIELDS) {
      const value = (colors as Record<string, unknown>)[field];
      if (isNoteColor(value)) clean[field] = value;
    }
    if (Object.keys(clean).length) out[themeKey] = clean;
  }
  return out;
};

export const setNoteColor = (
  all: NoteColorsByTheme,
  themeKey: string,
  field: NoteColorField,
  value: string,
): NoteColorsByTheme => {
  if (!isNoteColor(value)) return all;
  return { ...all, [themeKey]: { ...all[themeKey], [field]: value } };
};

/** Back to the theme's colour for one field; a theme left with nothing set is dropped. */
export const clearNoteColor = (
  all: NoteColorsByTheme,
  themeKey: string,
  field: NoteColorField,
): NoteColorsByTheme => {
  const current = all[themeKey];
  if (!current?.[field]) return all;
  const rest: NoteColors = { ...current };
  delete rest[field];
  return Object.keys(rest).length
    ? { ...all, [themeKey]: rest }
    : resetNoteColors(all, themeKey);
};

export const resetNoteColors = (
  all: NoteColorsByTheme,
  themeKey: string,
): NoteColorsByTheme => {
  if (!all[themeKey]) return all;
  return Object.fromEntries(Object.entries(all).filter(([key]) => key !== themeKey));
};

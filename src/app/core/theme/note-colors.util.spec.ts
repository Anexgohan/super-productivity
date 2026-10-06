import {
  clearNoteColor,
  noteColorsThemeKey,
  parseNoteColors,
  resetNoteColors,
  setNoteColor,
} from './note-colors.util';

const ZEN_DARK = 'builtin:zen:dark';
const ZEN_LIGHT = 'builtin:zen:light';
const NORD_DARK = 'builtin:nord:dark';
const PLAIN_DARK = 'builtin:plainspace:dark';

describe('note-colors.util', () => {
  describe('noteColorsThemeKey', () => {
    it('separates the light and dark variant of one theme', () => {
      expect(noteColorsThemeKey('builtin:plainspace', true)).toBe(PLAIN_DARK);
      expect(noteColorsThemeKey('builtin:plainspace', false)).toBe(
        'builtin:plainspace:light',
      );
    });
  });

  describe('parseNoteColors', () => {
    it('returns an empty map for missing or broken storage', () => {
      expect(parseNoteColors(null)).toEqual({});
      expect(parseNoteColors('')).toEqual({});
      expect(parseNoteColors('{not json')).toEqual({});
      expect(parseNoteColors('[]')).toEqual({});
      expect(parseNoteColors('"#ffffff"')).toEqual({});
    });

    it('keeps #rrggbb colours and drops anything else', () => {
      const raw = JSON.stringify({
        [PLAIN_DARK]: {
          bg: '#1e1e2e',
          fg: 'red; position: fixed',
          codeBg: '#ABCDEF',
          extra: '#000000',
        },
        [ZEN_LIGHT]: { bg: 'url(x)' },
        [NORD_DARK]: null,
      });
      expect(parseNoteColors(raw)).toEqual({
        [PLAIN_DARK]: { bg: '#1e1e2e', codeBg: '#ABCDEF' },
      });
    });
  });

  describe('setNoteColor', () => {
    it('sets one field for one theme without touching the others', () => {
      const all = { [ZEN_DARK]: { bg: '#000000' } };
      const next = setNoteColor(all, PLAIN_DARK, 'fg', '#ffffff');
      expect(next).toEqual({
        [ZEN_DARK]: { bg: '#000000' },
        [PLAIN_DARK]: { fg: '#ffffff' },
      });
      expect(all).toEqual({ [ZEN_DARK]: { bg: '#000000' } });
    });

    it('ignores a value that is not #rrggbb', () => {
      const all = {};
      expect(setNoteColor(all, ZEN_DARK, 'bg', 'blue')).toBe(all);
    });
  });

  describe('resetNoteColors', () => {
    it('removes only the given theme', () => {
      const all = {
        [ZEN_DARK]: { bg: '#000000' },
        [PLAIN_DARK]: { fg: '#ffffff' },
      };
      expect(resetNoteColors(all, PLAIN_DARK)).toEqual({
        [ZEN_DARK]: { bg: '#000000' },
      });
    });

    it('returns the same map when the theme has nothing set', () => {
      const all = { [ZEN_DARK]: { bg: '#000000' } };
      expect(resetNoteColors(all, PLAIN_DARK)).toBe(all);
    });
  });

  describe('clearNoteColor', () => {
    it('clears one field and keeps the others', () => {
      const all = { [PLAIN_DARK]: { bg: '#000000', fg: '#ffffff' } };
      expect(clearNoteColor(all, PLAIN_DARK, 'bg')).toEqual({
        [PLAIN_DARK]: { fg: '#ffffff' },
      });
    });

    it('drops the theme once nothing is left', () => {
      const all = { [PLAIN_DARK]: { bg: '#000000' }, [ZEN_DARK]: { fg: '#ffffff' } };
      expect(clearNoteColor(all, PLAIN_DARK, 'bg')).toEqual({
        [ZEN_DARK]: { fg: '#ffffff' },
      });
    });

    it('returns the same map when that field is not set', () => {
      const all = { [PLAIN_DARK]: { fg: '#ffffff' } };
      expect(clearNoteColor(all, PLAIN_DARK, 'bg')).toBe(all);
    });
  });
});

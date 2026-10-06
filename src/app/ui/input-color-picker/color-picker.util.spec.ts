import { hexToHsv, hsvToHex, normalizeHex, pushRecentColor } from './color-picker.util';

describe('color-picker.util', () => {
  describe('normalizeHex', () => {
    it('accepts short and long forms, with or without #, in any case', () => {
      expect(normalizeHex('#ABC')).toBe('#aabbcc');
      expect(normalizeHex('abc')).toBe('#aabbcc');
      expect(normalizeHex(' #1E1E2E ')).toBe('#1e1e2e');
      expect(normalizeHex('1e1e2e')).toBe('#1e1e2e');
    });

    it('refuses anything that is not a hex colour', () => {
      for (const bad of ['', '#12', '#12345', '#1234567', 'red', '#ggg', 'rgb(1,2,3)']) {
        expect(normalizeHex(bad)).toBeNull();
      }
    });
  });

  describe('hexToHsv / hsvToHex', () => {
    it('maps the primaries and greys', () => {
      expect(hexToHsv('#ff0000')).toEqual({ h: 0, s: 1, v: 1 });
      expect(hexToHsv('#00ff00')).toEqual({ h: 120, s: 1, v: 1 });
      expect(hexToHsv('#0000ff')).toEqual({ h: 240, s: 1, v: 1 });
      expect(hexToHsv('#000000')).toEqual({ h: 0, s: 0, v: 0 });
      expect(hexToHsv('#ffffff')).toEqual({ h: 0, s: 0, v: 1 });
    });

    it('round-trips any colour exactly', () => {
      for (const hex of [
        '#1e1e2e',
        '#faf6ef',
        '#29a1aa',
        '#bf4040',
        '#808080',
        '#123456',
      ]) {
        expect(hsvToHex(hexToHsv(hex))).toBe(hex);
      }
    });
  });

  describe('pushRecentColor', () => {
    it('puts the newest first, drops duplicates and caps the list', () => {
      expect(pushRecentColor(['#111111', '#222222'], '#222222')).toEqual([
        '#222222',
        '#111111',
      ]);
      const many = ['#000001', '#000002', '#000003'];
      expect(pushRecentColor(many, '#ffffff', 3)).toEqual([
        '#ffffff',
        '#000001',
        '#000002',
      ]);
    });
  });
});

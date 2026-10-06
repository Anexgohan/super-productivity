/**
 * Colour maths for the in-app picker.
 * Hue/saturation/value for the shade square and hue strip, `#rrggbb` (or `#rrggbbaa` with opacity) everywhere else.
 */

export interface Hsv {
  /** 0-360 */
  h: number;
  /** 0-1 */
  s: number;
  /** 0-1 */
  v: number;
}

const expandShort = (raw: string): string =>
  raw
    .split('')
    .map((c) => c + c)
    .join('');

/**
 * Accepts `#rgb`, `rgb`, `#rrggbb` or `rrggbb` in any case; returns lowercase `#rrggbb`, or null for anything else.
 * With `allowAlpha`, `#rgba` and `#rrggbbaa` are accepted too and kept as `#rrggbbaa`; a fully opaque one comes back as `#rrggbb`.
 */
export const normalizeHex = (input: string, allowAlpha = false): string | null => {
  let raw = input.trim().replace(/^#/, '').toLowerCase();
  if (raw.length === 3 || (allowAlpha && raw.length === 4)) raw = expandShort(raw);
  const isValid =
    /^[0-9a-f]+$/.test(raw) && (raw.length === 6 || (allowAlpha && raw.length === 8));
  if (!isValid) return null;
  return raw.endsWith('ff') && raw.length === 8 ? `#${raw.slice(0, 6)}` : `#${raw}`;
};

/** Splits `#rrggbb` or `#rrggbbaa` into the solid colour and its opacity, 0-1. */
export const splitAlpha = (hex: string): { rgb: string; alpha: number } => ({
  rgb: hex.slice(0, 7),
  alpha: hex.length === 9 ? parseInt(hex.slice(7, 9), 16) / 255 : 1,
});

/** `#rrggbb` plus an opacity of 0-1; fully opaque stays `#rrggbb`. */
export const withAlpha = (rgb: string, alpha: number): string => {
  const byte = Math.round(Math.min(1, Math.max(0, alpha)) * 255);
  return byte === 255
    ? rgb.slice(0, 7)
    : `${rgb.slice(0, 7)}${byte.toString(16).padStart(2, '0')}`;
};

/** Only the solid colour counts; any opacity is ignored. */
export const hexToHsv = (hex: string): Hsv => {
  const norm = normalizeHex(hex, true)?.slice(0, 7) ?? '#000000';
  const r = parseInt(norm.slice(1, 3), 16) / 255;
  const g = parseInt(norm.slice(3, 5), 16) / 255;
  const b = parseInt(norm.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  // Which sixth of the colour wheel, before scaling to degrees.
  let sector = 0;
  if (delta !== 0) {
    const offset = max === r ? 0 : max === g ? 2 : 4;
    const spread = max === r ? g - b : max === g ? b - r : r - g;
    const position = spread / delta;
    sector = max === r ? position % 6 : offset + position;
  }
  const degrees = sector * 60;
  return { h: (360 + degrees) % 360, s: max === 0 ? 0 : delta / max, v: max };
};

export const hsvToHex = ({ h, s, v }: Hsv): string => {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  const toHex = (n: number): string =>
    Math.round((n + m) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
};

/** Most recent first, no duplicates, at most `max`. */
export const pushRecentColor = (recent: string[], hex: string, max = 8): string[] => [
  hex,
  ...recent.filter((c) => c !== hex).slice(0, max - 1),
];

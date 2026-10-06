/** Colour maths for the in-app picker: hue/saturation/value for the shade square and hue strip, `#rrggbb` everywhere else. */

export interface Hsv {
  /** 0-360 */
  h: number;
  /** 0-1 */
  s: number;
  /** 0-1 */
  v: number;
}

/** Accepts `#rgb`, `rgb`, `#rrggbb` or `rrggbb` in any case; returns lowercase `#rrggbb`, or null for anything else. */
export const normalizeHex = (input: string): string | null => {
  const raw = input.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(raw)) {
    return `#${raw
      .split('')
      .map((c) => c + c)
      .join('')
      .toLowerCase()}`;
  }
  return /^[0-9a-f]{6}$/i.test(raw) ? `#${raw.toLowerCase()}` : null;
};

export const hexToHsv = (hex: string): Hsv => {
  const norm = normalizeHex(hex) ?? '#000000';
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

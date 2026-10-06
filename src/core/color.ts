/** Non-premultiplied 8-bit RGBA color. All channels are integers 0..255. */
export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface HSV {
  /** Hue in degrees 0..360 */
  h: number;
  /** Saturation 0..1 */
  s: number;
  /** Value 0..1 */
  v: number;
}

export const BLACK: RGBA = { r: 0, g: 0, b: 0, a: 255 };
export const WHITE: RGBA = { r: 255, g: 255, b: 255, a: 255 };
export const TRANSPARENT: RGBA = { r: 0, g: 0, b: 0, a: 0 };

export function rgba(r: number, g: number, b: number, a = 255): RGBA {
  return { r: clamp8(r), g: clamp8(g), b: clamp8(b), a: clamp8(a) };
}

export function clamp8(v: number): number {
  return v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v);
}

export function colorsEqual(a: RGBA, b: RGBA): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;
}

function hex2(n: number): string {
  return n.toString(16).padStart(2, '0');
}

/** Formats as #rrggbb, or #rrggbbaa when alpha is not 255 (or always when includeAlpha). */
export function toHex(c: RGBA, includeAlpha = c.a !== 255): string {
  return '#' + hex2(c.r) + hex2(c.g) + hex2(c.b) + (includeAlpha ? hex2(c.a) : '');
}

/** Parses #rgb, #rgba, #rrggbb, #rrggbbaa (leading # optional). Returns null when invalid. */
export function parseHex(input: string): RGBA | null {
  let s = input.trim();
  if (s.startsWith('#')) s = s.slice(1);
  if (!/^[0-9a-fA-F]+$/.test(s)) return null;
  if (s.length === 3 || s.length === 4) {
    s = [...s].map((ch) => ch + ch).join('');
  }
  if (s.length !== 6 && s.length !== 8) return null;
  const n = (i: number) => parseInt(s.slice(i, i + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: s.length === 8 ? n(6) : 255 };
}

export function toCss(c: RGBA): string {
  return c.a === 255 ? `rgb(${c.r} ${c.g} ${c.b})` : `rgb(${c.r} ${c.g} ${c.b} / ${(c.a / 255).toFixed(3)})`;
}

export function rgbToHsv(c: RGBA): HSV {
  const r = c.r / 255;
  const g = c.g / 255;
  const b = c.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

export function hsvToRgb(hsv: HSV, a = 255): RGBA {
  const h = (((hsv.h % 360) + 360) % 360) / 60;
  const s = Math.min(1, Math.max(0, hsv.s));
  const v = Math.min(1, Math.max(0, hsv.v));
  const c = v * s;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const m = v - c;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 1) [r, g, b] = [c, x, 0];
  else if (h < 2) [r, g, b] = [x, c, 0];
  else if (h < 3) [r, g, b] = [0, c, x];
  else if (h < 4) [r, g, b] = [0, x, c];
  else if (h < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return { r: clamp8((r + m) * 255), g: clamp8((g + m) * 255), b: clamp8((b + m) * 255), a: clamp8(a) };
}

/** Packs RGBA into an unsigned 32-bit integer (r in the high byte). */
export function packRGBA(r: number, g: number, b: number, a: number): number {
  return ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
}

export function unpackRGBA(n: number): RGBA {
  return { r: (n >>> 24) & 255, g: (n >>> 16) & 255, b: (n >>> 8) & 255, a: n & 255 };
}

/** Perceived luminance 0..1, used to pick contrasting overlay colors. */
export function luminance(c: RGBA): number {
  return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
}

import { type RGBA, parseHex, toHex } from './color';

export interface PalettePreset {
  name: string;
  colors: string[];
}

/** Built-in palettes. All are freely usable, widely published color sets. */
export const PALETTE_PRESETS: PalettePreset[] = [
  {
    name: 'DawnBringer 32',
    colors: [
      '000000', '222034', '45283c', '663931', '8f563b', 'df7126', 'd9a066', 'eec39a', 'fbf236', '99e550', '6abe30', '37946e', '4b692f', '524b24', '323c39', '3f3f74',
      '306082', '5b6ee1', '639bff', '5fcde4', 'cbdbfc', 'ffffff', '9badb7', '847e87', '696a6a', '595652', '76428a', 'ac3232', 'd95763', 'd77bba', '8f974a', '8a6f30',
    ],
  },
  {
    name: 'PICO-8',
    colors: ['000000', '1d2b53', '7e2553', '008751', 'ab5236', '5f574f', 'c2c3c7', 'fff1e8', 'ff004d', 'ffa300', 'ffec27', '00e436', '29adff', '83769c', 'ff77a8', 'ffccaa'],
  },
  { name: 'Game Boy', colors: ['0f380f', '306230', '8bac0f', '9bbc0f'] },
  { name: 'Grayscale', colors: ['000000', '242424', '494949', '6d6d6d', '929292', 'b6b6b6', 'dbdbdb', 'ffffff'] },
];

export function presetColors(name: string): RGBA[] {
  const p = PALETTE_PRESETS.find((x) => x.name === name) ?? PALETTE_PRESETS[0];
  return p.colors.map((c) => parseHex(c)!);
}

/**
 * Parses palette files: GIMP .gpl, Lospec/Paint.NET .hex/.txt (one hex color
 * per line; ';' comments) and JASC .pal. Returns null if nothing was found.
 */
export function parsePalette(text: string): RGBA[] | null {
  const lines = text.split(/\r?\n/);
  const colors: RGBA[] = [];
  if (lines[0]?.trim() === 'GIMP Palette') {
    for (const line of lines.slice(1)) {
      const m = /^\s*(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})/.exec(line);
      if (m) colors.push({ r: +m[1] & 255, g: +m[2] & 255, b: +m[3] & 255, a: 255 });
    }
  } else if (lines[0]?.trim() === 'JASC-PAL') {
    for (const line of lines.slice(3)) {
      const m = /^\s*(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})\s*$/.exec(line);
      if (m) colors.push({ r: +m[1] & 255, g: +m[2] & 255, b: +m[3] & 255, a: 255 });
    }
  } else {
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith(';') || line.startsWith('//')) continue;
      // Paint.NET writes AARRGGBB; plain .hex files use RRGGBB.
      if (/^[0-9a-fA-F]{8}$/.test(line)) {
        const c = parseHex(line.slice(2) + line.slice(0, 2));
        if (c) colors.push(c);
        continue;
      }
      const c = parseHex(line);
      if (c) colors.push(c);
    }
  }
  return colors.length ? colors.slice(0, 1024) : null;
}

export function toGpl(colors: RGBA[], name = 'Art palette'): string {
  const rows = colors.map((c) => `${String(c.r).padStart(3)} ${String(c.g).padStart(3)} ${String(c.b).padStart(3)}\t${toHex(c, false).slice(1)}`);
  return `GIMP Palette\nName: ${name}\nColumns: 8\n#\n${rows.join('\n')}\n`;
}

export function toHexList(colors: RGBA[]): string {
  return colors.map((c) => toHex(c, false).slice(1)).join('\n') + '\n';
}

/** Unique colors of an RGBA buffer (ignores fully transparent pixels), up to `limit`. */
export function extractColors(data: Uint8ClampedArray, limit = 256): RGBA[] | null {
  const seen = new Set<number>();
  const out: RGBA[] = [];
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const key = ((data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3]) >>> 0;
    if (seen.has(key)) continue;
    seen.add(key);
    if (out.length >= limit) return null;
    out.push({ r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] });
  }
  return out;
}

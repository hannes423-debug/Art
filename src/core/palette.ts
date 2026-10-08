import { type RGBA, parseHex, toHex } from './color';

export type PaletteCategory = 'Consoles' | 'Computers' | 'Artist palettes' | 'Basic';

export interface PalettePreset {
  /** Stable id (used to remember the selected palette). */
  id: string;
  name: string;
  category: PaletteCategory;
  colors: string[];
  /** Where the colors come from (shown in the palette browser). */
  note?: string;
}

/**
 * Rounds 8-bit colors to the 15-bit RGB555 color space of the Game Boy
 * Advance and SNES (5 bits per channel), so a palette only holds colors
 * that hardware can actually show.
 */
export function quantizeRGB555(hex: string): string {
  const c = parseHex(hex)!;
  const q = (v: number) => Math.round((Math.round((v * 31) / 255) * 255) / 31);
  return toHex({ r: q(c.r), g: q(c.g), b: q(c.b), a: 255 }, false).slice(1);
}

/**
 * Built-in palettes. Palette colors are plain data; these are widely
 * published sets whose authors allow free use, or palettes made for Art.
 * The GBA and SNES have no fixed palette (games pick colors from 32 768),
 * so their entries are original starter palettes limited to RGB555.
 */
export const PALETTE_PRESETS: PalettePreset[] = [
  {
    id: 'db32',
    name: 'DawnBringer 32',
    category: 'Artist palettes',
    note: 'By DawnBringer, free to use',
    colors: [
      '000000',
      '222034',
      '45283c',
      '663931',
      '8f563b',
      'df7126',
      'd9a066',
      'eec39a',
      'fbf236',
      '99e550',
      '6abe30',
      '37946e',
      '4b692f',
      '524b24',
      '323c39',
      '3f3f74',
      '306082',
      '5b6ee1',
      '639bff',
      '5fcde4',
      'cbdbfc',
      'ffffff',
      '9badb7',
      '847e87',
      '696a6a',
      '595652',
      '76428a',
      'ac3232',
      'd95763',
      'd77bba',
      '8f974a',
      '8a6f30',
    ],
  },
  {
    id: 'db16',
    name: 'DawnBringer 16',
    category: 'Artist palettes',
    note: 'By DawnBringer, free to use',
    colors: [
      '140c1c',
      '442434',
      '30346d',
      '4e4a4e',
      '854c30',
      '346524',
      'd04648',
      '757161',
      '597dce',
      'd27d2c',
      '8595a1',
      '6daa2c',
      'd2aa99',
      '6dc2ca',
      'dad45e',
      'deeed6',
    ],
  },
  {
    id: 'pico8',
    name: 'PICO-8',
    category: 'Consoles',
    note: 'Fantasy console by Lexaloffle; the 16 standard colors',
    colors: [
      '000000',
      '1d2b53',
      '7e2553',
      '008751',
      'ab5236',
      '5f574f',
      'c2c3c7',
      'fff1e8',
      'ff004d',
      'ffa300',
      'ffec27',
      '00e436',
      '29adff',
      '83769c',
      'ff77a8',
      'ffccaa',
    ],
  },
  {
    id: 'gameboy',
    name: 'Game Boy',
    category: 'Consoles',
    note: 'The four shades of the original green screen',
    colors: ['0f380f', '306230', '8bac0f', '9bbc0f'],
  },
  {
    id: 'gameboy-gray',
    name: 'Game Boy Pocket',
    category: 'Consoles',
    note: 'Four gray shades',
    colors: ['000000', '555555', 'aaaaaa', 'ffffff'],
  },
  {
    id: 'gba32',
    name: 'GBA-style 32',
    category: 'Consoles',
    note: 'Original starter palette for Art in GBA 15-bit color (RGB555)',
    colors: [
      '000000',
      '2d1b2e',
      '4a2c40',
      '6b3a4a',
      '9c4a4a',
      'd6603a',
      'f2a65a',
      'fbe08a',
      'f7f7f7',
      'b8c4d0',
      '7b8a9e',
      '4a566b',
      '262c3b',
      '1e3a5f',
      '2c6fb5',
      '4fa4f7',
      '9ad7ff',
      '1d4d2b',
      '2f8a3e',
      '68c24a',
      'bfe86b',
      '5a2a7a',
      '9a4bc2',
      'e07ad6',
      '7a1e2a',
      'c22c3a',
      'ff6b6b',
      '6e4a2a',
      'a8743a',
      'd9b07a',
      '2a8a8a',
      '7ae0d0',
    ].map(quantizeRGB555),
  },
  {
    id: 'nes',
    name: 'NES',
    category: 'Consoles',
    note: 'A commonly used approximation of the NES (2C02) colors; real output varies by TV',
    colors: [
      '000000',
      'fcfcfc',
      'f8f8f8',
      'bcbcbc',
      '7c7c7c',
      'a4e4fc',
      '3cbcfc',
      '0078f8',
      '0000fc',
      'b8b8f8',
      '6888fc',
      '0058f8',
      '0000bc',
      'd8b8f8',
      '9878f8',
      '6844fc',
      '4428bc',
      'f8b8f8',
      'f878f8',
      'd800cc',
      '940084',
      'f8a4c0',
      'f85898',
      'e40058',
      'a80020',
      'f0d0b0',
      'f87858',
      'f83800',
      'a81000',
      'fce0a8',
      'fca044',
      'e45c10',
      '881400',
      'f8d878',
      'f8b800',
      'ac7c00',
      '503000',
      'd8f878',
      'b8f818',
      '00b800',
      '007800',
      'b8f8b8',
      '58d854',
      '00a800',
      '006800',
      'b8f8d8',
      '58f898',
      '00a844',
      '005800',
      '00fcfc',
      '00e8d8',
      '008888',
      '004058',
      'f8d8f8',
      '787878',
    ],
  },
  {
    id: 'snes16',
    name: 'SNES-style 16',
    category: 'Consoles',
    note: 'Original starter palette for Art in SNES 15-bit color (RGB555)',
    colors: [
      '000000',
      'f8f8f8',
      'a0a0b0',
      '505068',
      '203060',
      '3070c0',
      '70b8f8',
      '206030',
      '48a048',
      'a8e070',
      '783018',
      'c86030',
      'f8b060',
      'f8e8a0',
      'a03070',
      'f070b0',
    ].map(quantizeRGB555),
  },
  {
    id: 'c64',
    name: 'Commodore 64',
    category: 'Computers',
    note: 'Colors measured by Philip “Pepto” Timmermann',
    colors: [
      '000000',
      'ffffff',
      '68372b',
      '70a4b2',
      '6f3d86',
      '588d43',
      '352879',
      'b8c76f',
      '6f4f25',
      '433900',
      '9a6759',
      '444444',
      '6c6c6c',
      '9ad284',
      '6c5eb5',
      '959595',
    ],
  },
  {
    id: 'sweetie16',
    name: 'Sweetie 16',
    category: 'Artist palettes',
    note: 'By GrafxKid, free to use',
    colors: [
      '1a1c2c',
      '5d275d',
      'b13e53',
      'ef7d57',
      'ffcd75',
      'a7f070',
      '38b764',
      '257179',
      '29366f',
      '3b5dc9',
      '41a6f6',
      '73eff7',
      'f4f4f4',
      '94b0c2',
      '566c86',
      '333c57',
    ],
  },
  {
    id: 'endesga32',
    name: 'Endesga 32',
    category: 'Artist palettes',
    note: 'By Endesga, free to use',
    colors: [
      'be4a2f',
      'd77643',
      'ead4aa',
      'e4a672',
      'b86f50',
      '733e39',
      '3e2731',
      'a22633',
      'e43b44',
      'f77622',
      'feae34',
      'fee761',
      '63c74d',
      '3e8948',
      '265c42',
      '193c3e',
      '124e89',
      '0099db',
      '2ce8f5',
      'ffffff',
      'c0cbdc',
      '8b9bb4',
      '5a6988',
      '3a4466',
      '262b44',
      '181425',
      'ff0044',
      '68386c',
      'b55088',
      'f6757a',
      'e8b796',
      'c28569',
    ],
  },
  { id: 'gray8', name: 'Grayscale', category: 'Basic', colors: ['000000', '242424', '494949', '6d6d6d', '929292', 'b6b6b6', 'dbdbdb', 'ffffff'] },
  { id: '1bit', name: '1-bit', category: 'Basic', note: 'Black and white', colors: ['000000', 'ffffff'] },
];

export function findPreset(idOrName: string): PalettePreset | undefined {
  return PALETTE_PRESETS.find((x) => x.id === idOrName || x.name === idOrName);
}

export function presetColors(idOrName: string): RGBA[] {
  const p = findPreset(idOrName) ?? PALETTE_PRESETS[0];
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

/** The palette's own name, if the file has one (GIMP "Name:" line). */
export function paletteNameFromFile(text: string): string | null {
  const m = /^Name:\s*(.+)$/m.exec(text);
  return m ? m[1].trim().slice(0, 64) || null : null;
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

/** Packed 0xRRGGBB. */
export type PackedRGB = number;

/**
 * Returns a function mapping any RGB color to the nearest palette color
 * (packed 0xRRGGBB), using a perceptually weighted distance. Results are
 * cached, so mapping a whole image costs one search per distinct color.
 */
export function nearestColorFinder(palette: RGBA[]): (r: number, g: number, b: number) => PackedRGB {
  const pal = palette.map((c) => (c.r << 16) | (c.g << 8) | c.b);
  const cache = new Map<number, number>();
  for (const p of pal) cache.set(p, p);
  return (r, g, b) => {
    const key = (r << 16) | (g << 8) | b;
    let hit = cache.get(key);
    if (hit !== undefined) return hit;
    let best = Infinity;
    hit = key;
    for (const c of pal) {
      const dr = ((c >> 16) & 255) - r;
      const dg = ((c >> 8) & 255) - g;
      const db = (c & 255) - b;
      // Redmean-like weights: green matters most, then blue/red depending on redness.
      const rm = (((c >> 16) & 255) + r) / 2;
      const d = (2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db;
      if (d < best) {
        best = d;
        hit = c;
      }
    }
    if (cache.size > 65536) cache.clear();
    cache.set(key, hit);
    return hit;
  };
}

/** Marks a palette bundle file (all of a user's saved palettes in one JSON file). */
export const PALETTE_BUNDLE_FORMAT = 'art-palettes';

export interface NamedPalette {
  name: string;
  colors: RGBA[];
}

/** Several palettes as one JSON file, for moving "My palettes" to another device. */
export function toPaletteBundle(list: NamedPalette[]): string {
  const palettes = list.map((p) => ({ name: p.name, colors: p.colors.map((c) => toHex(c, c.a < 255)) }));
  return JSON.stringify({ format: PALETTE_BUNDLE_FORMAT, version: 1, palettes }, null, 2) + '\n';
}

/** Reads a palette bundle; null when the text is not one. Bad entries are skipped. */
export function parsePaletteBundle(text: string): NamedPalette[] | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || (data as { format?: unknown }).format !== PALETTE_BUNDLE_FORMAT) return null;
  const raw = (data as { palettes?: unknown }).palettes;
  if (!Array.isArray(raw)) return [];
  const out: NamedPalette[] = [];
  for (const p of raw as { name?: unknown; colors?: unknown }[]) {
    if (!p || !Array.isArray(p.colors)) continue;
    const colors = (p.colors as unknown[]).map((c) => (typeof c === 'string' ? parseHex(c) : null)).filter((c): c is RGBA => !!c);
    if (!colors.length) continue;
    const name = typeof p.name === 'string' && p.name.trim() ? p.name.trim().slice(0, 64) : 'Imported palette';
    out.push({ name, colors });
  }
  return out;
}

import { type RGBA, parseHex, toHex } from '../core/color';
import { ArtDocument, type Frame, type LayerGroup, MAX_DIMENSION, type Tag } from '../core/document';
import { BLEND_MODES, type BlendMode, Layer } from '../core/layer';
import { Surface } from '../core/surface';
import type { GridSettings } from '../render/renderer';
import { decodePNG, encodePNG } from './png';

/**
 * The Art project format (".artproj") — plain JSON, documented in
 * docs/file-format.md. Each cel is stored as a PNG; in files it is a base64
 * data URL, in the browser library (IndexedDB) it is a Blob.
 */
export const PROJECT_FORMAT = 'art-project';
/**
 * Newest version this build reads. Files are written with the lowest
 * version that can hold them: 3 with layer groups, 2 with linked cels, else 1.
 */
export const PROJECT_VERSION = 3;
export const PROJECT_EXT = 'artproj';
export const PROJECT_MIME = 'application/vnd.art-project+json';

export interface ProjectLayer<C> {
  name: string;
  visible: boolean;
  opacity: number;
  blendMode: BlendMode;
  alphaLocked: boolean;
  /** Group id (version 3); members of a group are adjacent. */
  group?: number;
  /** One entry per frame; null = fully transparent cel; { link: i } = same cel as frame i (version 2). */
  cels: (C | null | { link: number })[];
}

export interface ProjectData<C> {
  format: typeof PROJECT_FORMAT;
  version: number;
  generator: string;
  name: string;
  width: number;
  height: number;
  frames: Frame[];
  tags?: Tag[];
  groups?: LayerGroup[];
  /** Bottom-to-top. */
  layers: ProjectLayer<C>[];
  activeLayer: number;
  activeFrame: number;
  palette: string[];
  /** Name of the palette (optional; readers may ignore it). */
  paletteName?: string;
  grid: GridSettings;
  created: string;
  modified: string;
}

export interface ProjectExtras {
  palette: RGBA[];
  paletteName?: string;
  grid: GridSettings;
  created?: string;
}

/** Cache of encoded cels so autosave only re-encodes cels that changed. */
const pngCache = new WeakMap<Surface, { version: number; bytes: Uint8Array }>();

export async function encodeCel(cel: Surface): Promise<Uint8Array | null> {
  if (!cel.data || cel.isBlank()) return null;
  const hit = pngCache.get(cel);
  if (hit && hit.version === cel.version) return hit.bytes;
  const bytes = await encodePNG(cel.width, cel.height, cel.data);
  pngCache.set(cel, { version: cel.version, bytes });
  return bytes;
}

export async function serializeProject<C>(doc: ArtDocument, extras: ProjectExtras, wrap: (png: Uint8Array) => C | Promise<C>): Promise<ProjectData<C>> {
  const layers: ProjectLayer<C>[] = [];
  let linked = false;
  for (const l of doc.layers) {
    const cels: (C | null | { link: number })[] = [];
    for (const [f, c] of l.cels.entries()) {
      const first = l.cels.indexOf(c);
      if (first < f) {
        cels.push({ link: first });
        linked = true;
        continue;
      }
      const png = await encodeCel(c);
      cels.push(png ? await wrap(png) : null);
    }
    const group = doc.groupOf(l);
    layers.push({
      name: l.name,
      visible: l.visible,
      opacity: l.opacity,
      blendMode: l.blendMode,
      alphaLocked: l.alphaLocked,
      ...(group ? { group: group.id } : {}),
      cels,
    });
  }
  const usedGroups = doc.groups.filter((g) => doc.layers.some((l) => l.group === g.id)).map((g) => ({ ...g }));
  const now = new Date().toISOString();
  return {
    format: PROJECT_FORMAT,
    version: usedGroups.length ? 3 : linked ? 2 : 1,
    generator: `Art ${__APP_VERSION__}`,
    name: doc.name,
    width: doc.width,
    height: doc.height,
    frames: doc.frames.map((f) => ({ duration: f.duration })),
    tags: doc.tags.map((t) => ({ ...t })),
    ...(usedGroups.length ? { groups: usedGroups } : {}),
    layers,
    activeLayer: doc.activeLayerIndex,
    activeFrame: doc.activeFrame,
    palette: extras.palette.map((c) => toHex(c)),
    ...(extras.paletteName ? { paletteName: extras.paletteName } : {}),
    grid: { ...extras.grid },
    created: extras.created ?? now,
    modified: now,
  };
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Serializes to the portable JSON file format (cels as PNG data URLs). */
export async function projectToJSON(doc: ArtDocument, extras: ProjectExtras): Promise<string> {
  const data = await serializeProject(doc, extras, (png) => 'data:image/png;base64,' + bytesToBase64(png));
  return JSON.stringify(data);
}

export class ProjectFormatError extends Error {}

async function celBytes(c: unknown): Promise<Uint8Array> {
  if (typeof c === 'string') {
    const m = /^data:image\/png;base64,(.*)$/s.exec(c);
    if (!m) throw new ProjectFormatError('Cel image must be a PNG data URL');
    return base64ToBytes(m[1]);
  }
  if (c instanceof Blob) return new Uint8Array(await c.arrayBuffer());
  if (c instanceof Uint8Array) return c;
  throw new ProjectFormatError('Unsupported cel data');
}

/** Reads a project (from JSON text or an already-parsed object). */
export async function deserializeProject(input: string | ProjectData<unknown>): Promise<{ doc: ArtDocument; extras: ProjectExtras }> {
  let data: ProjectData<unknown>;
  try {
    data = typeof input === 'string' ? JSON.parse(input) : input;
  } catch {
    throw new ProjectFormatError('The project file is not valid JSON.');
  }
  if (!data || data.format !== PROJECT_FORMAT) throw new ProjectFormatError('This is not an Art project file.');
  if (typeof data.version !== 'number' || data.version > PROJECT_VERSION) {
    throw new ProjectFormatError(`This project was saved by a newer version of Art (format v${data.version}).`);
  }
  const { width, height } = data;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new ProjectFormatError('Invalid canvas size in project.');
  }
  const frames: Frame[] =
    Array.isArray(data.frames) && data.frames.length ? data.frames.map((f) => ({ duration: Math.max(10, Number(f?.duration) || 100) })) : [{ duration: 100 }];
  if (!Array.isArray(data.layers) || !data.layers.length) throw new ProjectFormatError('Project has no layers.');
  const layers: Layer[] = [];
  for (const [i, pl] of data.layers.entries()) {
    const cels: Surface[] = [];
    for (let f = 0; f < frames.length; f++) {
      const c = pl.cels?.[f];
      if (c && typeof c === 'object' && 'link' in c && !(c instanceof Blob) && !(c instanceof Uint8Array)) {
        const target = Number((c as { link: unknown }).link);
        if (!Number.isInteger(target) || target < 0 || target >= f) throw new ProjectFormatError(`Layer ${i + 1} frame ${f + 1} links to an invalid frame.`);
        cels.push(cels[target]);
        continue;
      }
      if (c === null || c === undefined) {
        cels.push(new Surface(width, height));
        continue;
      }
      const img = await decodePNG(await celBytes(c));
      if (img.width !== width || img.height !== height) throw new ProjectFormatError(`Layer ${i + 1} frame ${f + 1} has the wrong size.`);
      cels.push(new Surface(width, height, img.data));
    }
    const layer = new Layer(typeof pl.name === 'string' ? pl.name : `Layer ${i + 1}`, cels);
    layer.visible = pl.visible !== false;
    layer.opacity = Math.max(0, Math.min(1, Number(pl.opacity ?? 1)));
    layer.blendMode = BLEND_MODES.some((m) => m.id === pl.blendMode) ? pl.blendMode : 'normal';
    layer.alphaLocked = pl.alphaLocked === true;
    layer.group = Number.isInteger(pl.group) ? (pl.group as number) : null;
    layers.push(layer);
  }
  const doc = ArtDocument.fromLayers(width, height, layers, frames, typeof data.name === 'string' ? data.name : 'Untitled');
  // Groups: keep those with members; a group's members must be adjacent.
  doc.groups = (Array.isArray(data.groups) ? data.groups : [])
    .filter((g) => Number.isInteger(g?.id))
    .map((g) => ({
      id: g.id,
      name: typeof g.name === 'string' ? g.name.slice(0, 64) : 'Group',
      visible: g.visible !== false,
      opacity: Math.max(0, Math.min(1, Number(g.opacity ?? 1))),
      collapsed: g.collapsed === true,
    }));
  const ended = new Set<number>();
  let prev: number | null = null;
  for (const l of layers) {
    if (l.group !== null && (!doc.groups.some((g) => g.id === l.group) || ended.has(l.group))) l.group = null;
    if (prev !== null && prev !== l.group) ended.add(prev);
    prev = l.group;
  }
  doc.groups = doc.groups.filter((g) => layers.some((l) => l.group === g.id));
  const colorRe = /^#[0-9a-f]{6}$/i;
  doc.tags = (Array.isArray(data.tags) ? data.tags : [])
    .map((t) => ({
      name: typeof t?.name === 'string' ? t.name.slice(0, 64) : 'Tag',
      from: Math.max(0, Math.min(frames.length - 1, Number(t?.from) | 0)),
      to: Math.max(0, Math.min(frames.length - 1, Number(t?.to) | 0)),
      color: typeof t?.color === 'string' && colorRe.test(t.color) ? t.color : '#5aa9ff',
      direction: (['forward', 'reverse', 'pingpong'] as const).includes(t?.direction) ? t.direction : 'forward',
    }))
    .filter((t) => t.to >= t.from);
  const al = layers[Math.max(0, Math.min(layers.length - 1, data.activeLayer | 0))];
  doc.setActiveLayer(al);
  doc.setActiveFrame(data.activeFrame | 0);
  const palette = Array.isArray(data.palette) ? data.palette.map((h) => parseHex(String(h))).filter((c): c is RGBA => !!c) : [];
  const g = data.grid;
  const grid: GridSettings = {
    enabled: g?.enabled === true,
    width: Math.max(1, Math.min(4096, Number(g?.width) || 16)),
    height: Math.max(1, Math.min(4096, Number(g?.height) || 16)),
  };
  const paletteName = typeof data.paletteName === 'string' && data.paletteName.trim() ? data.paletteName.trim().slice(0, 64) : undefined;
  return { doc, extras: { palette, paletteName, grid, created: typeof data.created === 'string' ? data.created : undefined } };
}

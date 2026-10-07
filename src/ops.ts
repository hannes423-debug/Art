import type { RGBA } from './core/color';
import { blendImage, compositeFrame } from './core/composite';
import { type ArtDocument, cloneTags, type Frame, type Tag } from './core/document';
import { type Rect, clipRect, unionRect } from './core/geometry';
import { type Command, CompoundCommand, FnCommand, type History } from './core/history';
import { cropPixels, flipHorizontal, flipVertical, type ResampleMode, resizePixels, rotate180, rotate90 } from './core/imageops';
import { type BlendMode, Layer } from './core/layer';
import { PaintSession } from './core/paint';
import type { SelectionState } from './core/selection';
import { type Pixels, Surface, allocPixels } from './core/surface';
import { TileRecorder } from './core/tiles';
import { nearestColorFinder } from './core/palette';
import { bayerThreshold } from './core/raster';

/**
 * Undoable document operations. Each function builds a Command and runs it
 * through History.execute(), so everything here can be undone.
 */

export class SelectionCommand implements Command {
  readonly label: string;
  private readonly doc: ArtDocument;
  private readonly before: SelectionState | null;
  private readonly after: SelectionState | null;

  constructor(doc: ArtDocument, before: SelectionState | null, after: SelectionState | null, label = 'Selection') {
    this.doc = doc;
    this.before = before;
    this.after = after;
    this.label = label;
  }

  get bytes(): number {
    return 64 + (this.before?.data.length ?? 0) + (this.after?.data.length ?? 0);
  }

  undo(): void {
    this.doc.selection.setState(this.before);
    this.doc.notifySelection();
  }

  redo(): void {
    this.doc.selection.setState(this.after);
    this.doc.notifySelection();
  }
}

/** Records a selection change made by `fn` as one undo step. */
export function changeSelection(doc: ArtDocument, history: History, label: string, fn: () => void): void {
  const before = doc.selection.getState();
  fn();
  const after = doc.selection.getState();
  doc.notifySelection();
  if (!before && !after) return;
  history.push(new SelectionCommand(doc, before, after, label));
}

// ------------------------------------------------------------------ Layers

export function addLayer(doc: ArtDocument, history: History, layer?: Layer, index?: number, label = 'New layer'): Layer {
  const l = layer ?? Layer.blank(doc.uniqueLayerName(), doc.width, doc.height, doc.frames.length);
  const at = index ?? doc.activeLayerIndex + 1;
  const prevActive = doc.activeLayer;
  history.execute(
    new FnCommand(
      label,
      () => doc.insertLayer(l, at),
      () => {
        doc.removeLayer(l);
        doc.setActiveLayer(prevActive);
      },
      bytesOfLayer(l),
    ),
  );
  return l;
}

export function duplicateLayer(doc: ArtDocument, history: History): Layer {
  const src = doc.activeLayer;
  const copy = src.clone(`${src.name} copy`);
  return addLayer(doc, history, copy, doc.activeLayerIndex + 1, 'Duplicate layer');
}

export function deleteLayer(doc: ArtDocument, history: History, layer = doc.activeLayer): boolean {
  if (doc.layers.length <= 1) return false;
  const index = doc.layers.indexOf(layer);
  const wasActive = doc.activeLayer === layer;
  history.execute(
    new FnCommand(
      'Delete layer',
      () => doc.removeLayer(layer),
      () => {
        doc.insertLayer(layer, index);
        if (!wasActive) doc.emit('active');
      },
      bytesOfLayer(layer),
    ),
  );
  return true;
}

export function moveLayer(doc: ArtDocument, history: History, layer: Layer, toIndex: number): void {
  const from = doc.layers.indexOf(layer);
  const to = Math.max(0, Math.min(doc.layers.length - 1, toIndex));
  if (from < 0 || from === to) return;
  history.execute(
    new FnCommand(
      'Move layer',
      () => doc.moveLayer(layer, to),
      () => doc.moveLayer(layer, from),
    ),
  );
}

export interface LayerProps {
  name?: string;
  opacity?: number;
  blendMode?: BlendMode;
  alphaLocked?: boolean;
}

export function setLayerProps(doc: ArtDocument, history: History, layer: Layer, props: LayerProps, label = 'Layer properties'): void {
  const before: LayerProps = { name: layer.name, opacity: layer.opacity, blendMode: layer.blendMode, alphaLocked: layer.alphaLocked };
  const after: LayerProps = { ...before, ...props };
  const apply = (p: LayerProps) => {
    Object.assign(layer, p);
    doc.notifyLayers();
  };
  history.execute(
    new FnCommand(
      label,
      () => apply(after),
      () => apply(before),
    ),
  );
}

/**
 * Merges the active layer into the layer below it (all frames). Returns an
 * explanation when the merge is not possible, or null on success.
 */
export function mergeDown(doc: ArtDocument, history: History): string | null {
  const upper = doc.activeLayer;
  const index = doc.layers.indexOf(upper);
  if (index <= 0) return 'There is no layer below to merge into';
  if (!upper.visible) return 'Show the layer before merging it down';
  const lower = doc.layers[index - 1];
  const oldData = lower.cels.map((c) => c.data);
  const merged = lower.cels.map((cel, f) => {
    const top = upper.cels[f].data;
    if (!top) return cel.data;
    const out = cel.data ? cel.data.slice() : allocPixels(doc.width, doc.height);
    blendImage(out, doc.width, doc.height, top, doc.width, doc.height, 0, 0, upper.opacity, upper.blendMode);
    return out;
  });
  const setData = (data: (Pixels | null)[]) =>
    lower.cels.forEach((c, i) => {
      c.replace(doc.width, doc.height, data[i]);
      doc.notifyPixels(c, { x: 0, y: 0, w: doc.width, h: doc.height });
    });
  history.execute(
    new FnCommand(
      'Merge down',
      () => {
        setData(merged);
        doc.removeLayer(upper);
        doc.setActiveLayer(lower);
      },
      () => {
        setData(oldData);
        doc.insertLayer(upper, index);
      },
      bytesOfLayer(upper) + bytesOfLayer(lower),
    ),
  );
  return null;
}

/** Flattens all visible layers into one (hidden layers are discarded). */
export function flattenImage(doc: ArtDocument, history: History): void {
  const oldLayers = [...doc.layers];
  const oldActive = doc.activeLayer;
  const flat = new Layer(
    'Flattened',
    doc.frames.map((_, f) => new Surface(doc.width, doc.height, compositeFrame(doc, f))),
  );
  const setLayers = (layers: Layer[], active: Layer) => {
    doc.layers = layers;
    doc.setActiveLayer(active);
    doc.emit('active');
    doc.notifyLayers();
  };
  history.execute(
    new FnCommand(
      'Flatten image',
      () => setLayers([flat], flat),
      () => setLayers(oldLayers, oldActive),
      oldLayers.reduce((s, l) => s + bytesOfLayer(l), bytesOfLayer(flat)),
    ),
  );
}

function bytesOfLayer(l: Layer): number {
  return l.cels.reduce((s, c) => s + (c.data?.length ?? 0), 256);
}

// ---------------------------------------------------------- Pixel edits

/** Erases the selection (or the whole cel) on the active layer. */
export function clearPixels(doc: ArtDocument, history: History): void {
  const cel = doc.activeCel;
  if (!cel.data) return;
  const session = new PaintSession(doc, cel, { color: { r: 0, g: 0, b: 0, a: 255 }, opacity: 1, mode: 'erase', alphaLock: false });
  const area = doc.selection.bounds ?? { x: 0, y: 0, w: doc.width, h: doc.height };
  for (let y = area.y; y < area.y + area.h; y++) session.span(y, area.x, area.x + area.w - 1);
  const patch = session.commit('Clear');
  if (patch) history.push(patch);
}

/** Fills the selection (or the whole cel) with a color. */
export function fillPixels(doc: ArtDocument, history: History, color: RGBA, alphaLock: boolean): void {
  const session = new PaintSession(doc, doc.activeCel, { color, opacity: 1, mode: 'paint', alphaLock });
  const area = doc.selection.bounds ?? { x: 0, y: 0, w: doc.width, h: doc.height };
  for (let y = area.y; y < area.y + area.h; y++) session.span(y, area.x, area.x + area.w - 1);
  const patch = session.commit('Fill');
  if (patch) history.push(patch);
}

/** Flips the active cel (only the selection bounds when a selection exists). */
export function flipLayer(doc: ArtDocument, history: History, horizontal: boolean): void {
  const cel = doc.activeCel;
  if (!cel.data) return;
  const area = doc.selection.bounds ?? { x: 0, y: 0, w: doc.width, h: doc.height };
  const rec = new TileRecorder(cel);
  rec.record(area);
  const block = cel.readRect(area);
  const flipped = horizontal ? flipHorizontal(block, area.w, area.h) : flipVertical(block, area.w, area.h);
  const data = cel.data;
  for (let y = 0; y < area.h; y++) data.set(flipped.subarray(y * area.w * 4, (y + 1) * area.w * 4), ((area.y + y) * doc.width + area.x) * 4);
  cel.touch(area);
  doc.notifyPixels(cel, area);
  const patch = rec.finish(horizontal ? 'Flip horizontal' : 'Flip vertical', (s, r) => doc.notifyPixels(s, r));
  if (patch) history.push(patch);
}

// ---------------------------------------------------------- Replace color

export interface ReplaceColorOptions {
  from: RGBA;
  to: RGBA;
  /** 0 = exact match; otherwise the largest allowed difference per channel (0..255). */
  tolerance: number;
  /** Every visible layer instead of only the active one. */
  allLayers: boolean;
  /** Every frame instead of only the current one. */
  allFrames: boolean;
}

/** True when pixel (r, g, b, a) counts as `c` (any fully transparent pixel matches a transparent color). */
export function colorMatches(r: number, g: number, b: number, a: number, c: RGBA, tolerance: number): boolean {
  if (c.a === 0 && a === 0) return true;
  return Math.abs(r - c.r) <= tolerance && Math.abs(g - c.g) <= tolerance && Math.abs(b - c.b) <= tolerance && Math.abs(a - c.a) <= tolerance;
}

/**
 * Replaces one color with another inside the selection (or everywhere), on
 * the active layer or all visible layers, in one frame or all of them.
 * Returns the number of pixels changed; the whole change is one undo step.
 */
export function replaceColor(doc: ArtDocument, history: History, o: ReplaceColorOptions): number {
  const layers = o.allLayers ? doc.layers.filter((l) => l.visible) : [doc.activeLayer];
  const frames = o.allFrames ? doc.frames.map((_, i) => i) : [doc.activeFrame];
  const sel = doc.selection.mask;
  const area = doc.selection.bounds ?? { x: 0, y: 0, w: doc.width, h: doc.height };
  const w = doc.width;
  const t = Math.max(0, Math.min(255, Math.round(o.tolerance)));
  const patches: Command[] = [];
  let changed = 0;
  const seen = new Set<Surface>();
  for (const layer of layers) {
    for (const f of frames) {
      const cel = layer.cels[f];
      if (seen.has(cel)) continue;
      seen.add(cel);
      // Blank cels only hold transparent pixels.
      const d = cel.data;
      if (!d) {
        if (o.from.a !== 0 || o.to.a === 0) continue;
      }
      const data = cel.ensureData();
      // Find what changes first so only the touched tiles are recorded.
      let bounds: Rect | null = null;
      const hits: number[] = [];
      for (let y = area.y; y < area.y + area.h; y++) {
        for (let x = area.x; x < area.x + area.w; x++) {
          const i = y * w + x;
          if (sel && sel[i] < 128) continue;
          const p = i * 4;
          if (!colorMatches(data[p], data[p + 1], data[p + 2], data[p + 3], o.from, t)) continue;
          if (data[p] === o.to.r && data[p + 1] === o.to.g && data[p + 2] === o.to.b && data[p + 3] === o.to.a) continue;
          hits.push(i);
          bounds = unionRect(bounds, { x, y, w: 1, h: 1 });
        }
      }
      if (!bounds) {
        if (!d) cel.data = null;
        continue;
      }
      const rec = new TileRecorder(cel);
      rec.record(bounds);
      const transparent = o.to.a === 0;
      for (const i of hits) {
        const p = i * 4;
        data[p] = transparent ? 0 : o.to.r;
        data[p + 1] = transparent ? 0 : o.to.g;
        data[p + 2] = transparent ? 0 : o.to.b;
        data[p + 3] = o.to.a;
      }
      changed += hits.length;
      cel.touch(bounds);
      doc.notifyPixels(cel, bounds);
      const patch = rec.finish('Replace color', (s, r) => doc.notifyPixels(s, r));
      if (patch) patches.push(patch);
    }
  }
  if (patches.length) history.push(patches.length === 1 ? patches[0] : new CompoundCommand('Replace color', patches));
  return changed;
}

// ---------------------------------------------------------- Palette

/**
 * Maps every pixel's color to the nearest palette color (alpha is kept),
 * on the active layer or all visible layers, in one frame or all of them.
 * Optional ordered dithering mixes the two nearest palette colors.
 * Returns the number of pixels changed; one undo step.
 */
export function mapToPalette(doc: ArtDocument, history: History, palette: RGBA[], o: { allLayers: boolean; allFrames: boolean; dither: boolean }): number {
  if (!palette.length) return 0;
  const near = nearestColorFinder(palette);
  const layers = o.allLayers ? doc.layers.filter((l) => l.visible) : [doc.activeLayer];
  const frames = o.allFrames ? doc.frames.map((_, i) => i) : [doc.activeFrame];
  const sel = doc.selection.mask;
  const area = doc.selection.bounds ?? { x: 0, y: 0, w: doc.width, h: doc.height };
  const w = doc.width;
  const patches: Command[] = [];
  let changed = 0;
  const seen = new Set<Surface>();
  for (const layer of layers) {
    for (const f of frames) {
      const cel = layer.cels[f];
      if (seen.has(cel) || !cel.data) continue;
      seen.add(cel);
      const data = cel.data;
      const rec = new TileRecorder(cel);
      rec.record(area);
      let n = 0;
      for (let y = area.y; y < area.y + area.h; y++) {
        for (let x = area.x; x < area.x + area.w; x++) {
          const i = y * w + x;
          if (sel && sel[i] < 128) continue;
          const p = i * 4;
          if (data[p + 3] === 0) continue;
          const r = data[p];
          const g = data[p + 1];
          const b = data[p + 2];
          let c = near(r, g, b);
          if (o.dither) {
            // Ordered dither: offset the color along its error by a Bayer
            // threshold, so pixels halfway between two palette colors split
            // 50/50 and exact palette colors stay unchanged.
            const k = 4 * (bayerThreshold(x, y) - 0.5);
            const er = r - (c >> 16);
            const eg = g - ((c >> 8) & 255);
            const eb = b - (c & 255);
            c = near(clamp255(r + er * k), clamp255(g + eg * k), clamp255(b + eb * k));
          }
          const nr = c >> 16;
          const ng = (c >> 8) & 255;
          const nb = c & 255;
          if (nr === r && ng === g && nb === b) continue;
          data[p] = nr;
          data[p + 1] = ng;
          data[p + 2] = nb;
          n++;
        }
      }
      changed += n;
      if (n) {
        cel.touch(area);
        doc.notifyPixels(cel, area);
      }
      const patch = rec.finish('Map to palette', (s, r) => doc.notifyPixels(s, r));
      if (patch) patches.push(patch);
    }
  }
  if (patches.length) history.push(patches.length === 1 ? patches[0] : new CompoundCommand('Map to palette', patches));
  return changed;
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

// ---------------------------------------------------------- Image geometry

/**
 * Replaces the document size and every cel through one undo step. `transform`
 * maps old cel data to new data (null stays null for blank cels).
 */
function geometryChange(
  doc: ArtDocument,
  history: History,
  label: string,
  newW: number,
  newH: number,
  transform: (data: Pixels) => Pixels,
  selDx = 0,
  selDy = 0,
  keepSelection = true,
): void {
  const oldW = doc.width;
  const oldH = doc.height;
  const cels = doc.layers.flatMap((l) => l.cels);
  const before = new Map<Surface, Pixels | null>(cels.map((c) => [c, c.data]));
  const after = new Map<Surface, Pixels | null>(cels.map((c) => [c, c.data ? transform(c.data) : null]));
  const selBefore = doc.selection.getState();
  let selAfter: SelectionState | null = null;
  if (keepSelection && selBefore) {
    selAfter = { bounds: { ...selBefore.bounds, x: selBefore.bounds.x + selDx, y: selBefore.bounds.y + selDy }, data: selBefore.data };
  }
  const bytes = [...before.values(), ...after.values()].reduce((s, d) => s + (d?.length ?? 0), 256);
  history.execute(
    new FnCommand(
      label,
      () => {
        doc.applyGeometry(newW, newH, after);
        doc.selection.setState(selAfter);
        doc.notifySelection();
      },
      () => {
        doc.applyGeometry(oldW, oldH, before);
        doc.selection.setState(selBefore);
        doc.notifySelection();
      },
      bytes,
    ),
  );
}

/** Canvas size: anchor (0..1, 0..1) decides where the old image sits in the new canvas. */
export function resizeCanvas(doc: ArtDocument, history: History, w: number, h: number, anchorX: number, anchorY: number): void {
  if (w === doc.width && h === doc.height) return;
  const ox = Math.round((w - doc.width) * anchorX);
  const oy = Math.round((h - doc.height) * anchorY);
  const oldW = doc.width;
  const oldH = doc.height;
  geometryChange(doc, history, 'Canvas size', w, h, (d) => cropPixels(d, oldW, oldH, { x: -ox, y: -oy, w, h }), ox, oy);
}

export function scaleImage(doc: ArtDocument, history: History, w: number, h: number, mode: ResampleMode): void {
  if (w === doc.width && h === doc.height) return;
  const oldW = doc.width;
  const oldH = doc.height;
  geometryChange(doc, history, 'Scale image', w, h, (d) => resizePixels(d, oldW, oldH, w, h, mode), 0, 0, false);
}

export function cropTo(doc: ArtDocument, history: History, rect: Rect, label = 'Crop'): void {
  const r = clipRect(rect, doc.width, doc.height);
  if (!r || (r.x === 0 && r.y === 0 && r.w === doc.width && r.h === doc.height)) return;
  const oldW = doc.width;
  const oldH = doc.height;
  geometryChange(doc, history, label, r.w, r.h, (d) => cropPixels(d, oldW, oldH, r), -r.x, -r.y);
}

/** Crops away fully transparent borders (considering all layers and frames). */
export function trimImage(doc: ArtDocument, history: History): boolean {
  let bounds: Rect | null = null;
  for (const l of doc.layers) for (const c of l.cels) bounds = unionRect(bounds, c.contentBounds());
  if (!bounds) return false;
  cropTo(doc, history, bounds, 'Trim');
  return true;
}

export function flipImage(doc: ArtDocument, history: History, horizontal: boolean): void {
  const w = doc.width;
  const h = doc.height;
  geometryChange(
    doc,
    history,
    horizontal ? 'Flip image horizontally' : 'Flip image vertically',
    w,
    h,
    (d) => (horizontal ? flipHorizontal(d, w, h) : flipVertical(d, w, h)),
    0,
    0,
    false,
  );
}

export function rotateImage(doc: ArtDocument, history: History, turn: 'cw' | 'ccw' | '180'): void {
  const w = doc.width;
  const h = doc.height;
  const label = turn === '180' ? 'Rotate 180°' : turn === 'cw' ? 'Rotate 90° clockwise' : 'Rotate 90° counter-clockwise';
  if (turn === '180') geometryChange(doc, history, label, w, h, (d) => rotate180(d, w, h), 0, 0, false);
  else geometryChange(doc, history, label, h, w, (d) => rotate90(d, w, h, turn === 'cw'), 0, 0, false);
}

// ------------------------------------------------------------------ Frames

/**
 * Inserts a frame after the active one: empty, a copy of the active frame,
 * or "linked" (every layer shares the active frame's cels, so editing one
 * edits both). Adding after a tag's last frame extends the tag.
 */
export function addFrame(doc: ArtDocument, history: History, mode: boolean | 'empty' | 'duplicate' | 'linked'): void {
  const kind = mode === true ? 'duplicate' : mode === false ? 'empty' : mode;
  const at = doc.activeFrame + 1;
  const prev = doc.activeFrame;
  const frame: Frame = { duration: doc.frames[prev].duration };
  const cels = doc.layers.map((l) => (kind === 'linked' ? l.cels[prev] : kind === 'duplicate' ? l.cels[prev].clone() : new Surface(doc.width, doc.height)));
  const tagsBefore = cloneTags(doc.tags);
  history.execute(
    new FnCommand(
      kind === 'linked' ? 'Linked frame' : kind === 'duplicate' ? 'Duplicate frame' : 'New frame',
      () => {
        doc.insertFrame(at, frame, cels);
        for (const t of doc.tags) if (t.to === prev && tagsBefore.some((b) => b.name === t.name && b.to === prev)) t.to = at;
        doc.emit('frames');
      },
      () => {
        doc.removeFrame(at);
        doc.setTags(tagsBefore);
        doc.setActiveFrame(prev);
      },
      kind === 'linked' ? 128 : cels.reduce((s, c) => s + (c.data?.length ?? 0), 128),
    ),
  );
}

export function deleteFrame(doc: ArtDocument, history: History): boolean {
  if (doc.frames.length <= 1) return false;
  const index = doc.activeFrame;
  const frame = doc.frames[index];
  const cels = doc.layers.map((l) => l.cels[index]);
  const tagsBefore = cloneTags(doc.tags);
  history.execute(
    new FnCommand(
      'Delete frame',
      () => doc.removeFrame(index),
      () => {
        doc.insertFrame(index, frame, cels);
        doc.setTags(tagsBefore);
      },
      cels.reduce((s, c) => s + (c.data?.length ?? 0), 128),
    ),
  );
  return true;
}

export function moveFrame(doc: ArtDocument, history: History, delta: number): void {
  const from = doc.activeFrame;
  const to = from + delta;
  if (to < 0 || to >= doc.frames.length) return;
  history.execute(
    new FnCommand(
      'Move frame',
      () => doc.moveFrame(from, to),
      () => doc.moveFrame(to, from),
    ),
  );
}

/** Replaces one layer's cel at a frame (used to link and unlink cels). */
function swapCel(doc: ArtDocument, history: History, label: string, layer: Layer, frame: number, next: Surface): void {
  const before = layer.cels[frame];
  const set = (s: Surface) => {
    layer.cels[frame] = s;
    doc.emit('frames');
    doc.emit('layers');
  };
  history.execute(
    new FnCommand(
      label,
      () => set(next),
      () => set(before),
      next.data?.length ?? 64,
    ),
  );
}

/** Makes the active layer's cel share the previous frame's cel. Returns an error message or null. */
export function linkWithPrevious(doc: ArtDocument, history: History): string | null {
  const f = doc.activeFrame;
  if (f === 0) return 'The first frame has no previous frame to link to';
  const layer = doc.activeLayer;
  if (layer.cels[f] === layer.cels[f - 1]) return 'This cel is already linked to the previous frame';
  swapCel(doc, history, 'Link cel', layer, f, layer.cels[f - 1]);
  return null;
}

/** Gives the active layer's cel its own copy of the pixels. Returns false if it was not linked. */
export function unlinkCel(doc: ArtDocument, history: History): boolean {
  const f = doc.activeFrame;
  const layer = doc.activeLayer;
  if (!doc.isLinked(layer, f)) return false;
  swapCel(doc, history, 'Unlink cel', layer, f, layer.cels[f].clone());
  return true;
}

/** Replaces all tags as one undo step. */
export function setTags(doc: ArtDocument, history: History, tags: Tag[], label = 'Edit tags'): void {
  const before = cloneTags(doc.tags);
  const after = cloneTags(tags);
  history.execute(
    new FnCommand(
      label,
      () => doc.setTags(after),
      () => doc.setTags(before),
    ),
  );
}

export function setAllFrameDurations(doc: ArtDocument, history: History, ms: number): void {
  const before = doc.frames.map((f) => f.duration);
  const apply = (d: number[]) => {
    doc.frames.forEach((f, i) => (f.duration = d[i]));
    doc.emit('frames');
  };
  history.execute(
    new FnCommand(
      'Frame timing',
      () => apply(before.map(() => ms)),
      () => apply(before),
    ),
  );
}

// ------------------------------------------------------------- Selection

/** Selection mask of every pixel matching `color` on the active layer (or the visible image). */
export function colorMask(doc: ArtDocument, color: RGBA, tolerance: number, merged: boolean): { mask: Uint8Array; bounds: Rect | null } {
  const src = merged ? compositeFrame(doc, doc.activeFrame) : doc.activeCel.data;
  const mask = new Uint8Array(doc.width * doc.height);
  let bounds: Rect | null = null;
  const w = doc.width;
  const t = Math.max(0, Math.min(255, Math.round(tolerance)));
  for (let y = 0; y < doc.height; y++) {
    let x0 = -1;
    for (let x = 0; x <= w; x++) {
      const i = y * w + x;
      const hit = x < w && (src ? colorMatches(src[i * 4], src[i * 4 + 1], src[i * 4 + 2], src[i * 4 + 3], color, t) : color.a === 0 || t >= color.a);
      if (hit) {
        mask[i] = 255;
        if (x0 < 0) x0 = x;
      } else if (x0 >= 0) {
        bounds = unionRect(bounds, { x: x0, y, w: x - x0, h: 1 });
        x0 = -1;
      }
    }
  }
  return { mask, bounds };
}

export function selectionFromAlpha(doc: ArtDocument, history: History): void {
  const cel = doc.activeCel;
  changeSelection(doc, history, 'Select layer content', () => {
    const d = cel.data;
    if (!d) {
      doc.selection.clear();
      return;
    }
    const mask = new Uint8Array(doc.width * doc.height);
    for (let i = 0; i < mask.length; i++) mask[i] = d[i * 4 + 3];
    doc.selection.combine(mask, cel.contentBounds(), 'replace');
  });
}

// ------------------------------------------------------------- Clipboard

export interface ClipImage {
  width: number;
  height: number;
  data: Pixels;
  /** Where the pixels came from, so pasting puts them back in place. */
  x: number;
  y: number;
}

/** Copies the selection (or everything) from the active cel, or from the merged image. */
export function copyPixels(doc: ArtDocument, merged: boolean): ClipImage | null {
  const sel = doc.selection.getState();
  const rect = sel?.bounds ?? { x: 0, y: 0, w: doc.width, h: doc.height };
  const data = merged ? compositeFrame(doc, doc.activeFrame, { rect }) : doc.activeCel.readRect(rect);
  if (sel) {
    for (let i = 0; i < sel.data.length; i++) {
      const m = sel.data[i];
      if (m === 255) continue;
      const a = (data[i * 4 + 3] * m) / 255;
      if (a < 0.5) data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = data[i * 4 + 3] = 0;
      else data[i * 4 + 3] = a;
    }
  }
  return { width: rect.w, height: rect.h, data, x: rect.x, y: rect.y };
}

export function combine(label: string, cmds: Command[]): Command {
  return new CompoundCommand(label, cmds);
}

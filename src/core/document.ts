import type { RGBA } from './color';
import { Emitter } from './emitter';
import type { Rect } from './geometry';
import { Layer } from './layer';
import { Selection } from './selection';
import { type Pixels, Surface, allocPixels } from './surface';

/** Animation frame metadata. Pixel data lives in each layer's cels. */
export interface Frame {
  /** Display duration in milliseconds. */
  duration: number;
}

export type TagDirection = 'forward' | 'reverse' | 'pingpong';

/** A named range of frames (an animation such as "walk" or "idle"). Indices are inclusive. */
export interface Tag {
  name: string;
  from: number;
  to: number;
  color: string;
  direction: TagDirection;
}

/**
 * A layer group (one level deep). Its member layers are adjacent in the
 * layer list; the group is composited on its own and then blended with
 * its opacity, and hiding it hides every member.
 */
export interface LayerGroup {
  id: number;
  name: string;
  visible: boolean;
  /** 0..1 */
  opacity: number;
  /** Members are folded away in the layers panel. */
  collapsed: boolean;
}

export function cloneTags(tags: Tag[]): Tag[] {
  return tags.map((t) => ({ ...t }));
}

export interface DocEvents {
  /** Pixels of a surface changed inside rect. */
  pixels: { surface: Surface; rect: Rect };
  /** Layer list, order, or layer properties changed. */
  layers: void;
  /** Frame list changed. */
  frames: void;
  /** Active layer or active frame changed. */
  active: void;
  selection: void;
  /** Document dimensions changed. */
  resize: void;
}

export const MAX_DIMENSION = 8192;

/**
 * The image being edited. Layers are stored bottom-to-top. Every layer has
 * exactly `frames.length` cels. Mutating methods here do not record history;
 * undoable operations live in ops.ts and call these.
 */
export class ArtDocument extends Emitter<DocEvents> {
  width: number;
  height: number;
  layers: Layer[] = [];
  frames: Frame[] = [{ duration: 100 }];
  /** Animation tags (frame ranges), in no particular order. */
  tags: Tag[] = [];
  groups: LayerGroup[] = [];
  /** Name of the tag whose animation the project thumbnail shows (null: the animation around the current frame). */
  thumbnailTag: string | null = null;
  selection: Selection;
  name: string;
  private _activeLayer!: Layer;
  private _activeFrame = 0;

  constructor(width: number, height: number, name = 'Untitled') {
    super();
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      throw new Error(`Invalid document size ${width}x${height}`);
    }
    if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
      throw new Error(`Maximum document size is ${MAX_DIMENSION}x${MAX_DIMENSION}`);
    }
    this.width = width;
    this.height = height;
    this.name = name;
    this.selection = new Selection(width, height);
  }

  /** Creates a document with one layer, optionally filled with a background color. */
  static createBlank(width: number, height: number, name = 'Untitled', background: RGBA | null = null): ArtDocument {
    const doc = new ArtDocument(width, height, name);
    const layer = Layer.blank(background ? 'Background' : 'Layer 1', width, height, 1);
    if (background && background.a > 0) {
      const d = allocPixels(width, height);
      for (let i = 0; i < d.length; i += 4) {
        d[i] = background.r;
        d[i + 1] = background.g;
        d[i + 2] = background.b;
        d[i + 3] = background.a;
      }
      layer.cels[0].replace(width, height, d);
    }
    doc.layers.push(layer);
    doc._activeLayer = layer;
    return doc;
  }

  /** Builds a document from layers (bottom-to-top). Used by importers. */
  static fromLayers(width: number, height: number, layers: Layer[], frames: Frame[], name = 'Untitled'): ArtDocument {
    const doc = new ArtDocument(width, height, name);
    if (!layers.length) throw new Error('A document needs at least one layer');
    for (const l of layers) {
      if (l.cels.length !== frames.length) throw new Error('Layer cel count does not match frame count');
    }
    doc.layers = layers;
    doc.frames = frames;
    doc._activeLayer = layers[layers.length - 1];
    return doc;
  }

  get activeLayer(): Layer {
    return this._activeLayer;
  }

  get activeLayerIndex(): number {
    return this.layers.indexOf(this._activeLayer);
  }

  get activeFrame(): number {
    return this._activeFrame;
  }

  get activeCel(): Surface {
    return this._activeLayer.cels[this._activeFrame];
  }

  get frameCount(): number {
    return this.frames.length;
  }

  setActiveLayer(layer: Layer): void {
    if (layer === this._activeLayer || !this.layers.includes(layer)) return;
    this._activeLayer = layer;
    this.emit('active');
  }

  setActiveFrame(index: number): void {
    const i = Math.max(0, Math.min(this.frames.length - 1, index));
    if (i === this._activeFrame) return;
    this._activeFrame = i;
    this.emit('active');
  }

  notifyPixels(surface: Surface, rect: Rect): void {
    this.emit('pixels', { surface, rect });
  }

  notifyLayers(): void {
    this.emit('layers');
  }

  notifySelection(): void {
    this.emit('selection');
  }

  groupOf(layer: Layer): LayerGroup | undefined {
    return layer.group === null ? undefined : this.groups.find((g) => g.id === layer.group);
  }

  /** The layer and its group (if any) are both visible. */
  isShown(layer: Layer): boolean {
    return layer.visible && (this.groupOf(layer)?.visible ?? true);
  }

  /** Layer opacity times its group's opacity (for previews). */
  effectiveOpacity(layer: Layer): number {
    return layer.opacity * (this.groupOf(layer)?.opacity ?? 1);
  }

  /** Member layers of a group, bottom to top. */
  groupMembers(id: number): Layer[] {
    return this.layers.filter((l) => l.group === id);
  }

  newGroupId(): number {
    return this.groups.reduce((m, g) => Math.max(m, g.id), 0) + 1;
  }

  uniqueGroupName(): string {
    const names = new Set(this.groups.map((g) => g.name));
    for (let i = 1; ; i++) if (!names.has(`Group ${i}`)) return `Group ${i}`;
  }

  /** True when the layer's cel at `frame` is shared with another frame (a linked cel). */
  isLinked(layer: Layer, frame: number): boolean {
    const c = layer.cels[frame];
    return layer.cels.some((o, i) => i !== frame && o === c);
  }

  /** Frames whose cels include `surface` (several when the cel is linked). */
  framesOf(surface: Surface): number[] {
    const out: number[] = [];
    for (const l of this.layers) l.cels.forEach((c, i) => c === surface && !out.includes(i) && out.push(i));
    return out;
  }

  /** The first tag containing `frame`, if any. */
  tagAt(frame: number): Tag | undefined {
    return this.tags.find((t) => frame >= t.from && frame <= t.to);
  }

  /**
   * Frame order of the animation around `frame`: the tag containing it
   * (in the tag's direction) or every frame. Used by playback and previews.
   */
  animationOrder(frame: number): number[] {
    const tag = this.tagAt(frame);
    const from = tag ? tag.from : 0;
    const to = tag ? tag.to : this.frames.length - 1;
    const fwd: number[] = [];
    for (let i = from; i <= to; i++) fwd.push(i);
    if (!tag || tag.direction === 'forward') return fwd;
    if (tag.direction === 'reverse') return fwd.reverse();
    // Ping-pong: there and back without repeating the ends.
    return [...fwd, ...fwd.slice(1, -1).reverse()];
  }

  /** Frame order for the project thumbnail: the chosen tag if it still exists, else the animation around `frame`. */
  thumbnailOrder(frame: number): number[] {
    const tag = this.thumbnailTag !== null ? this.tags.find((t) => t.name === this.thumbnailTag) : undefined;
    return tag ? this.animationOrder(tag.from) : this.animationOrder(frame);
  }

  setTags(tags: Tag[]): void {
    this.tags = cloneTags(tags);
    this.emit('frames');
  }

  /** Finds which layer/frame a surface belongs to. */
  locate(surface: Surface): { layer: Layer; frame: number } | null {
    for (const layer of this.layers) {
      const frame = layer.cels.indexOf(surface);
      if (frame >= 0) return { layer, frame };
    }
    return null;
  }

  uniqueLayerName(base = 'Layer'): string {
    const names = new Set(this.layers.map((l) => l.name));
    for (let i = this.layers.length + 1; ; i++) {
      const n = `${base} ${i}`;
      if (!names.has(n)) return n;
    }
  }

  // ---- Structural mutations (no history) ----

  insertLayer(layer: Layer, index: number): void {
    if (layer.cels.length !== this.frames.length) throw new Error('Layer frame count mismatch');
    const i = Math.max(0, Math.min(this.layers.length, index));
    this.layers.splice(i, 0, layer);
    this._activeLayer = layer;
    this.emit('layers');
    this.emit('active');
  }

  /** Removes a layer, returning its former index. The document always keeps one layer. */
  removeLayer(layer: Layer): number {
    const i = this.layers.indexOf(layer);
    if (i < 0) return -1;
    if (this.layers.length === 1) throw new Error('Cannot remove the last layer');
    this.layers.splice(i, 1);
    for (const c of layer.cels) c.releaseCanvas();
    if (this._activeLayer === layer) {
      this._activeLayer = this.layers[Math.min(i, this.layers.length - 1)];
      this.emit('active');
    }
    this.emit('layers');
    return i;
  }

  moveLayer(layer: Layer, toIndex: number): void {
    const from = this.layers.indexOf(layer);
    if (from < 0) return;
    const to = Math.max(0, Math.min(this.layers.length - 1, toIndex));
    if (from === to) return;
    this.layers.splice(from, 1);
    this.layers.splice(to, 0, layer);
    this.emit('layers');
  }

  /** Inserts a frame; `cels[i]` is the new cel for `layers[i]`. */
  insertFrame(index: number, frame: Frame, cels: Surface[]): void {
    if (cels.length !== this.layers.length) throw new Error('insertFrame: cel count mismatch');
    const i = Math.max(0, Math.min(this.frames.length, index));
    this.frames.splice(i, 0, frame);
    this.layers.forEach((l, li) => l.cels.splice(i, 0, cels[li]));
    // Tags after the new frame move; a tag the frame lands inside grows.
    for (const t of this.tags) {
      if (t.from >= i) t.from++;
      if (t.to >= i) t.to++;
    }
    this._activeFrame = i;
    this.emit('frames');
    this.emit('active');
  }

  removeFrame(index: number): { frame: Frame; cels: Surface[] } {
    if (this.frames.length <= 1) throw new Error('Cannot remove the last frame');
    const [frame] = this.frames.splice(index, 1);
    const cels = this.layers.map((l) => l.cels.splice(index, 1)[0]);
    for (const c of cels) c.releaseCanvas();
    // Tags shrink around the removed frame; a tag left without frames is dropped.
    this.tags = this.tags.filter((t) => {
      if (t.from > index) t.from--;
      if (t.to >= index) t.to--;
      return t.to >= t.from;
    });
    if (this._activeFrame >= this.frames.length) this._activeFrame = this.frames.length - 1;
    else if (this._activeFrame > index) this._activeFrame--;
    this.emit('frames');
    this.emit('active');
    return { frame, cels };
  }

  moveFrame(from: number, to: number): void {
    if (from === to || from < 0 || to < 0 || from >= this.frames.length || to >= this.frames.length) return;
    const [f] = this.frames.splice(from, 1);
    this.frames.splice(to, 0, f);
    for (const l of this.layers) {
      const [c] = l.cels.splice(from, 1);
      l.cels.splice(to, 0, c);
    }
    this._activeFrame = to;
    this.emit('frames');
    this.emit('active');
  }

  /**
   * Changes the document size and replaces cel pixels in one step (resize,
   * crop, rotate). `celData` must contain an entry for every cel.
   */
  applyGeometry(width: number, height: number, celData: Map<Surface, Pixels | null>, selDx = 0, selDy = 0): void {
    this.width = width;
    this.height = height;
    for (const layer of this.layers) {
      for (const cel of layer.cels) {
        const data = celData.get(cel);
        if (data === undefined) throw new Error('applyGeometry: missing cel data');
        cel.replace(width, height, data);
      }
    }
    if (this.selection.width !== width || this.selection.height !== height || selDx || selDy) {
      this.selection.resize(width, height, selDx, selDy);
    }
    this.emit('resize');
    this.emit('layers');
    this.emit('selection');
  }

  /** Releases display canvases of all cels (call when closing a document). */
  dispose(): void {
    for (const l of this.layers) for (const c of l.cels) c.releaseCanvas();
  }
}

import type { ArtDocument } from '../core/document';
import { type Rect, clipRect, unionRect } from '../core/geometry';
import { canvasOpFor } from '../core/layer';
import { type Segments, selectionOutline } from './outline';
import type { Viewport } from './viewport';

export interface GridSettings {
  enabled: boolean;
  width: number;
  height: number;
}

export interface RenderSettings {
  /** Show 1px grid between document pixels at high zoom. */
  pixelGrid: boolean;
  grid: GridSettings;
  /** Bilinear filtering when zoomed (off = crisp nearest-neighbour). */
  smooth: boolean;
  onionSkin: boolean;
  onionOpacity: number;
  /** Repeat the image around itself (tile preview). */
  tileMode?: 'off' | 'both' | 'x' | 'y';
}

/** At most this many copies are drawn in tile mode (when zoomed far out). */
const MAX_TILES = 400;

/** Something drawn above the canvas in screen space (brush cursor, marquee...). */
export interface Overlay {
  drawOverlay(ctx: CanvasRenderingContext2D, view: Viewport): void;
}

const WORKSPACE_BG = '#1b1d21';
const CHECKER_A = '#3a3d42';
const CHECKER_B = '#2c2f33';
const PIXEL_GRID_MIN_ZOOM = 8;
/** Pixels per check in the pattern canvas (the pattern is scaled into document space). */
const CHECKER_TILE = 8;

/** Check size in document pixels: the smallest power of two at least ~12 screen pixels wide. */
export function checkerCell(zoom: number): number {
  return Math.max(1, 2 ** Math.ceil(Math.log2(12 / zoom)));
}

/**
 * Draws the document into the on-screen canvas.
 *
 * Layers are composited into a document-sized cache canvas, and only the
 * dirty rectangles reported by the document are recomposited. Panning,
 * zooming and rotating therefore cost one drawImage plus overlays, no
 * matter how many layers there are. Rendering happens at most once per
 * animation frame and only when something changed.
 */
export class Renderer {
  readonly canvas: HTMLCanvasElement;
  readonly view: Viewport;
  settings: RenderSettings;
  overlays: Overlay[] = [];
  /** Frame shown instead of the active frame (animation playback), or null. */
  displayFrame: number | null = null;
  /** Called after each rendered frame. */
  onRender: (() => void) | null = null;

  private ctx: CanvasRenderingContext2D;
  private doc: ArtDocument | null = null;
  private unsub: (() => void)[] = [];
  private composite: HTMLCanvasElement;
  private cctx: CanvasRenderingContext2D;
  private compositeDirty: Rect | null = null;
  private compositeFrame = -1;
  private raf = 0;
  private dpr = 1;
  private checker: CanvasPattern | null = null;
  private outline: Segments | null = null;
  private outlineVersion = -1;
  private onion = new Map<number, { key: string; canvas: HTMLCanvasElement }>();

  constructor(canvas: HTMLCanvasElement, view: Viewport, settings: RenderSettings) {
    this.canvas = canvas;
    this.view = view;
    this.settings = settings;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D is not available');
    this.ctx = ctx;
    this.composite = document.createElement('canvas');
    const cctx = this.composite.getContext('2d');
    if (!cctx) throw new Error('Canvas 2D is not available');
    this.cctx = cctx;
  }

  /** The composited image (document size), e.g. for a magnifier. */
  get compositeImage(): HTMLCanvasElement {
    return this.composite;
  }

  get frame(): number {
    return this.displayFrame ?? this.doc?.activeFrame ?? 0;
  }

  setDocument(doc: ArtDocument): void {
    for (const u of this.unsub) u();
    this.doc = doc;
    this.onion.clear();
    this.outlineVersion = -1;
    this.resizeComposite();
    this.unsub = [
      doc.on('pixels', ({ surface, rect }) => {
        const f = this.frame;
        if (doc.layers.some((l) => l.cels[f] === surface)) this.invalidate(rect);
        else this.requestRender(); // onion skins may show other frames
      }),
      doc.on('layers', () => this.invalidateAll()),
      doc.on('frames', () => this.invalidateAll()),
      doc.on('active', () => {
        if (this.compositeFrame !== this.frame) this.invalidateAll();
        else this.requestRender();
      }),
      doc.on('resize', () => {
        this.resizeComposite();
        this.invalidateAll();
      }),
      doc.on('selection', () => this.requestRender()),
    ];
    this.invalidateAll();
  }

  private resizeComposite(): void {
    if (!this.doc) return;
    if (this.composite.width !== this.doc.width || this.composite.height !== this.doc.height) {
      this.composite.width = this.doc.width;
      this.composite.height = this.doc.height;
    }
  }

  /** Marks a document region for recompositing. */
  invalidate(rect: Rect): void {
    if (!this.doc) return;
    const r = clipRect(rect, this.doc.width, this.doc.height);
    if (r) this.compositeDirty = unionRect(this.compositeDirty, r);
    this.requestRender();
  }

  invalidateAll(): void {
    if (!this.doc) return;
    this.compositeDirty = { x: 0, y: 0, w: this.doc.width, h: this.doc.height };
    this.requestRender();
  }

  /** Resizes the backing store to the element's CSS size × devicePixelRatio. */
  resize(cssWidth: number, cssHeight: number, dpr = window.devicePixelRatio || 1): void {
    this.dpr = dpr;
    this.view.width = cssWidth;
    this.view.height = cssHeight;
    const w = Math.max(1, Math.round(cssWidth * dpr));
    const h = Math.max(1, Math.round(cssHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.requestRender();
  }

  requestRender(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.render();
    });
  }

  /** Renders synchronously (also used by tests). */
  render(): void {
    const doc = this.doc;
    if (!doc) return;
    this.updateComposite(doc);
    const ctx = this.ctx;
    const dpr = this.dpr;
    const W = this.canvas.width;
    const H = this.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = WORKSPACE_BG;
    ctx.fillRect(0, 0, W, H);

    const m = this.view.matrix();
    let e = m.e * dpr;
    let f = m.f * dpr;
    if (this.view.axisAligned) {
      // Snap to device pixels so pixel edges stay crisp.
      e = Math.round(e);
      f = Math.round(f);
    }
    const docTransform = () => ctx.setTransform(m.a * dpr, m.b * dpr, m.c * dpr, m.d * dpr, e, f);

    // Transparency checkerboard in document space. Each check covers a
    // power-of-two number of pixels, so it always lines up with pixel edges.
    docTransform();
    const cell = checkerCell(this.view.zoom);
    const pattern = this.checkerPattern();
    ctx.imageSmoothingEnabled = false;
    if (pattern) {
      pattern.setTransform(new DOMMatrix([cell / CHECKER_TILE, 0, 0, cell / CHECKER_TILE, 0, 0]));
      ctx.fillStyle = pattern;
    } else ctx.fillStyle = CHECKER_A;
    const tiles = this.tileOffsets(doc);
    if (tiles.length > 1) {
      // Tile preview: neighbouring copies, slightly dimmed so the real canvas stays obvious.
      const xs = tiles.map((t) => t[0]);
      const ys = tiles.map((t) => t[1]);
      const x0 = Math.min(...xs);
      const y0 = Math.min(...ys);
      ctx.fillRect(x0, y0, Math.max(...xs) - x0 + doc.width, Math.max(...ys) - y0 + doc.height);
    } else ctx.fillRect(0, 0, doc.width, doc.height);

    docTransform();
    ctx.imageSmoothingEnabled = this.settings.smooth;
    if (this.settings.smooth) ctx.imageSmoothingQuality = 'high';

    if (this.settings.onionSkin && doc.frames.length > 1 && this.displayFrame === null) {
      const cur = doc.activeFrame;
      for (const [fi, tint] of [
        [cur - 1, '#ff3b3b'],
        [cur + 1, '#3b9dff'],
      ] as [number, string][]) {
        if (fi < 0 || fi >= doc.frames.length) continue;
        ctx.globalAlpha = this.settings.onionOpacity;
        ctx.drawImage(this.onionCanvas(doc, fi, tint), 0, 0);
      }
      ctx.globalAlpha = 1;
    }

    for (const [tx, ty] of tiles) {
      if (tx === 0 && ty === 0) continue;
      ctx.drawImage(this.composite, tx, ty);
    }
    if (tiles.length > 1) {
      // Dim the copies.
      ctx.fillStyle = 'rgba(27,29,33,0.28)';
      for (const [tx, ty] of tiles) if (tx !== 0 || ty !== 0) ctx.fillRect(tx, ty, doc.width, doc.height);
    }
    ctx.drawImage(this.composite, 0, 0);

    // Overlays are drawn in device space so lines stay 1px wide.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.drawGrids(ctx, doc, dpr, e, f);
    this.drawSelection(ctx, doc, m, dpr, e, f);
    this.drawBorder(ctx, doc, m, dpr, e, f);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const o of this.overlays) {
      ctx.save();
      o.drawOverlay(ctx, this.view);
      ctx.restore();
    }
    this.onRender?.();
  }

  /** Document-space offsets of every copy to draw (just [0, 0] unless tile mode is on). */
  private tileOffsets(doc: ArtDocument): [number, number][] {
    const m = this.settings.tileMode;
    if (!m || m === 'off') return [[0, 0]];
    const vis = this.view.visibleDocRect();
    const W = doc.width;
    const H = doc.height;
    const rx = m === 'both' || m === 'x';
    const ry = m === 'both' || m === 'y';
    const kx0 = rx ? Math.floor(vis.x0 / W) : 0;
    const kx1 = rx ? Math.floor(vis.x1 / W) : 0;
    const ky0 = ry ? Math.floor(vis.y0 / H) : 0;
    const ky1 = ry ? Math.floor(vis.y1 / H) : 0;
    if ((kx1 - kx0 + 1) * (ky1 - ky0 + 1) > MAX_TILES) return [[0, 0]];
    const out: [number, number][] = [];
    for (let ky = ky0; ky <= ky1; ky++) for (let kx = kx0; kx <= kx1; kx++) out.push([kx * W, ky * H]);
    if (!out.some(([x, y]) => x === 0 && y === 0)) out.push([0, 0]);
    return out;
  }

  private updateComposite(doc: ArtDocument): void {
    const frame = this.frame;
    if (this.compositeFrame !== frame) {
      this.compositeFrame = frame;
      this.compositeDirty = { x: 0, y: 0, w: doc.width, h: doc.height };
      this.releaseHiddenCanvases(doc);
    }
    const r = this.compositeDirty;
    if (!r) return;
    this.compositeDirty = null;
    const c = this.cctx;
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
    c.clearRect(r.x, r.y, r.w, r.h);
    for (const layer of doc.layers) {
      if (!layer.visible || layer.opacity <= 0) continue;
      const cel = layer.cels[frame];
      if (!cel || !cel.data) continue;
      const src = cel.getCanvas();
      c.globalAlpha = layer.opacity;
      c.globalCompositeOperation = canvasOpFor(layer.blendMode);
      c.drawImage(src, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
    }
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
  }

  /** Frees display canvases of cels that are not currently shown (saves GPU/canvas memory). */
  private releaseHiddenCanvases(doc: ArtDocument): void {
    const keep = new Set<number>([this.frame]);
    if (this.settings.onionSkin) {
      keep.add(doc.activeFrame - 1);
      keep.add(doc.activeFrame + 1);
    }
    for (const l of doc.layers) {
      l.cels.forEach((c, i) => {
        if (!keep.has(i) && c.hasCanvas()) c.releaseCanvas();
      });
    }
    for (const k of [...this.onion.keys()]) if (!keep.has(k)) this.onion.delete(k);
  }

  private onionCanvas(doc: ArtDocument, frame: number, tint: string): HTMLCanvasElement {
    const key =
      `${doc.width}x${doc.height}|${tint}|` +
      doc.layers.map((l) => `${l.id}:${l.visible ? 1 : 0}:${l.opacity}:${l.blendMode}:${l.cels[frame].id}:${l.cels[frame].version}`).join(',');
    let entry = this.onion.get(frame);
    if (entry && entry.key === key) return entry.canvas;
    const canvas = entry?.canvas ?? document.createElement('canvas');
    canvas.width = doc.width;
    canvas.height = doc.height;
    const c = canvas.getContext('2d')!;
    c.clearRect(0, 0, doc.width, doc.height);
    for (const layer of doc.layers) {
      const cel = layer.cels[frame];
      if (!layer.visible || !cel.data) continue;
      c.globalAlpha = layer.opacity;
      c.globalCompositeOperation = canvasOpFor(layer.blendMode);
      c.drawImage(cel.getCanvas(), 0, 0);
    }
    c.globalAlpha = 0.6;
    c.globalCompositeOperation = 'source-atop';
    c.fillStyle = tint;
    c.fillRect(0, 0, doc.width, doc.height);
    entry = { key, canvas };
    this.onion.set(frame, entry);
    return canvas;
  }

  private checkerPattern(): CanvasPattern | null {
    if (this.checker) return this.checker;
    const s = CHECKER_TILE;
    const t = document.createElement('canvas');
    t.width = s * 2;
    t.height = s * 2;
    const c = t.getContext('2d')!;
    c.fillStyle = CHECKER_A;
    c.fillRect(0, 0, s * 2, s * 2);
    c.fillStyle = CHECKER_B;
    c.fillRect(0, 0, s, s);
    c.fillRect(s, s, s, s);
    this.checker = this.ctx.createPattern(t, 'repeat');
    return this.checker;
  }

  private drawGrids(ctx: CanvasRenderingContext2D, doc: ArtDocument, dpr: number, e: number, f: number): void {
    const view = this.view;
    const zoom = view.zoom;
    const vis = view.visibleDocRect();
    const x0 = Math.max(0, Math.floor(vis.x0));
    const y0 = Math.max(0, Math.floor(vis.y0));
    const x1 = Math.min(doc.width, Math.ceil(vis.x1));
    const y1 = Math.min(doc.height, Math.ceil(vis.y1));
    if (x1 <= x0 || y1 <= y0) return;
    const m = view.matrix();
    const aligned = view.axisAligned;
    const tx = (x: number, y: number) => {
      const sx = (m.a * x + m.c * y) * dpr + e;
      const sy = (m.b * x + m.d * y) * dpr + f;
      return aligned ? [Math.round(sx) + 0.5, Math.round(sy) + 0.5] : [sx, sy];
    };
    const lines = (stepX: number, stepY: number, color: string) => {
      ctx.beginPath();
      for (let x = Math.ceil(x0 / stepX) * stepX; x <= x1; x += stepX) {
        const [ax, ay] = tx(x, y0);
        const [bx, by] = tx(x, y1);
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
      }
      for (let y = Math.ceil(y0 / stepY) * stepY; y <= y1; y += stepY) {
        const [ax, ay] = tx(x0, y);
        const [bx, by] = tx(x1, y);
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.stroke();
    };
    if (this.settings.pixelGrid && zoom >= PIXEL_GRID_MIN_ZOOM) lines(1, 1, 'rgba(128,128,128,0.35)');
    const g = this.settings.grid;
    if (g.enabled && g.width > 0 && g.height > 0 && Math.min(g.width, g.height) * zoom >= 4) {
      lines(g.width, g.height, 'rgba(70,170,255,0.75)');
    }
  }

  private drawSelection(
    ctx: CanvasRenderingContext2D,
    doc: ArtDocument,
    m: { a: number; b: number; c: number; d: number },
    dpr: number,
    e: number,
    f: number,
  ): void {
    const sel = doc.selection;
    if (!sel.active) return;
    if (this.outlineVersion !== sel.version || !this.outline) {
      this.outline = selectionOutline(sel);
      this.outlineVersion = sel.version;
    }
    const seg = this.outline;
    if (!seg.length) return;
    const aligned = this.view.axisAligned;
    ctx.beginPath();
    for (let i = 0; i < seg.length; i += 4) {
      let ax = (m.a * seg[i] + m.c * seg[i + 1]) * dpr + e;
      let ay = (m.b * seg[i] + m.d * seg[i + 1]) * dpr + f;
      let bx = (m.a * seg[i + 2] + m.c * seg[i + 3]) * dpr + e;
      let by = (m.b * seg[i + 2] + m.d * seg[i + 3]) * dpr + f;
      if (aligned) {
        ax = Math.round(ax) + 0.5;
        ay = Math.round(ay) + 0.5;
        bx = Math.round(bx) + 0.5;
        by = Math.round(by) + 0.5;
      }
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
    }
    ctx.lineWidth = Math.max(1, Math.round(dpr));
    ctx.setLineDash([]);
    ctx.strokeStyle = '#000';
    ctx.stroke();
    ctx.setLineDash([4 * dpr, 4 * dpr]);
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private drawBorder(
    ctx: CanvasRenderingContext2D,
    doc: ArtDocument,
    m: { a: number; b: number; c: number; d: number },
    dpr: number,
    e: number,
    f: number,
  ): void {
    const corners = [
      [0, 0],
      [doc.width, 0],
      [doc.width, doc.height],
      [0, doc.height],
    ].map(([x, y]) => [(m.a * x + m.c * y) * dpr + e, (m.b * x + m.d * y) * dpr + f]);
    ctx.beginPath();
    corners.forEach(([x, y], i) => (i ? ctx.lineTo(x - 0.5, y - 0.5) : ctx.moveTo(x - 0.5, y - 0.5)));
    ctx.closePath();
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  dispose(): void {
    for (const u of this.unsub) u();
    if (this.raf) cancelAnimationFrame(this.raf);
  }
}

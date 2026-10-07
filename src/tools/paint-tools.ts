import type { PaintSession } from '../core/paint';
import { bresenham } from '../core/raster';
import type { Viewport } from '../render/viewport';
import { type OptionSpec, Tool, type ToolId, type ToolPointer } from './tool';

interface StrokePoint {
  x: number;
  y: number;
  pressure: number;
}

/** Symmetry axes in document coordinates (null = no mirroring on that axis). */
export interface SymmetryAxes {
  /** Vertical axis: mirrors left ↔ right. */
  x: number | null;
  /** Horizontal axis: mirrors top ↔ bottom. */
  y: number | null;
}

/** All mirror images of a point (the point itself first). */
function mirrorPoints(x: number, y: number, axes: SymmetryAxes | null, flipX: (v: number) => number, flipY: (v: number) => number): [number, number][] {
  const out: [number, number][] = [[x, y]];
  if (!axes) return out;
  if (axes.x !== null) out.push([flipX(x), y]);
  if (axes.y !== null) out.push([x, flipY(y)]);
  if (axes.x !== null && axes.y !== null) out.push([flipX(x), flipY(y)]);
  return out;
}

/** Map key for a pixel position (works for coordinates off the canvas too). */
function pixelKey(x: number, y: number): number {
  return (y + 32768) * 65536 + (x + 32768);
}

/** Draws a two-tone outline so the cursor is visible on any background. */
export function strokeTwoTone(ctx: CanvasRenderingContext2D): void {
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.stroke();
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.stroke();
}

/**
 * Hard-edged pixel stroke (pencil, pixel eraser). Interpolates with
 * Bresenham lines so fast strokes never leave gaps, and optionally applies
 * "pixel-perfect" cleanup that removes the L-shaped corner pixels in
 * 1px freehand lines.
 */
class PixelStroke {
  private readonly session: PaintSession;
  private readonly size: number;
  private readonly round: boolean;
  private readonly perfect: boolean;
  private readonly alpha: number;
  private readonly axes: SymmetryAxes | null;
  private points: { x: number; y: number }[] = [];
  private counts = new Map<number, number>();

  constructor(session: PaintSession, size: number, round: boolean, pixelPerfect: boolean, alpha: number, axes: SymmetryAxes | null = null) {
    this.session = session;
    this.size = Math.max(1, Math.round(size));
    this.round = round;
    this.perfect = pixelPerfect && this.size === 1;
    this.alpha = alpha;
    this.axes = axes;
  }

  /** Mirror images of the dab at pixel (x, y); a dab of n pixels covers [x - off, x - off + n). */
  private mirrored(x: number, y: number): [number, number][] {
    const n = this.size;
    const shift = 2 * Math.floor((n - 1) / 2) - n;
    const a = this.axes;
    return mirrorPoints(
      x,
      y,
      a,
      (v) => Math.round(2 * (a?.x ?? 0)) - v + shift,
      (v) => Math.round(2 * (a?.y ?? 0)) - v + shift,
    );
  }

  get last(): { x: number; y: number } | undefined {
    return this.points.at(-1);
  }

  begin(x: number, y: number): void {
    this.add(x, y);
  }

  lineTo(x: number, y: number): void {
    const last = this.last;
    if (!last) {
      this.add(x, y);
      return;
    }
    let first = true;
    bresenham(last.x, last.y, x, y, (px, py) => {
      if (first) {
        first = false;
        return;
      }
      this.add(px, py);
    });
  }

  private add(x: number, y: number): void {
    const last = this.last;
    if (last && last.x === x && last.y === y) return;
    this.points.push({ x, y });
    this.stamp(x, y);
    if (!this.perfect) {
      if (this.points.length > 3) this.points.shift();
      return;
    }
    const n = this.points.length;
    if (n >= 3) {
      const a = this.points[n - 3];
      const b = this.points[n - 2];
      const c = this.points[n - 1];
      if (Math.abs(a.x - c.x) === 1 && Math.abs(a.y - c.y) === 1 && (b.x === a.x || b.y === a.y) && (b.x === c.x || b.y === c.y)) {
        this.unstamp(b.x, b.y);
        this.points.splice(n - 2, 1);
      }
    }
    if (this.points.length > 3) this.points.shift();
  }

  private stamp(x: number, y: number): void {
    for (const [mx, my] of this.mirrored(x, y)) {
      this.session.dabPixel(mx, my, this.size, this.round, this.alpha);
      if (this.perfect) {
        const k = pixelKey(mx, my);
        this.counts.set(k, (this.counts.get(k) ?? 0) + 1);
      }
    }
  }

  private unstamp(x: number, y: number): void {
    for (const [mx, my] of this.mirrored(x, y)) {
      const k = pixelKey(mx, my);
      const c = (this.counts.get(k) ?? 1) - 1;
      this.counts.set(k, c);
      if (c <= 0) this.session.setCoverage(mx, my, 0);
    }
  }
}

/**
 * Anti-aliased round-dab stroke (brush, soft eraser). Places dabs at even
 * spacing along the path, carrying leftover distance between segments, and
 * interpolates pressure.
 */
class SoftStroke {
  private readonly session: PaintSession;
  private readonly size: number;
  private readonly hardness: number;
  private readonly pressureSize: boolean;
  private readonly pressureOpacity: boolean;
  private readonly axes: SymmetryAxes | null;
  last: StrokePoint | null = null;
  private remainder = 0;

  constructor(session: PaintSession, size: number, hardness: number, pressureSize: boolean, pressureOpacity: boolean, axes: SymmetryAxes | null = null) {
    this.session = session;
    this.size = size;
    this.hardness = hardness;
    this.pressureSize = pressureSize;
    this.pressureOpacity = pressureOpacity;
    this.axes = axes;
  }

  private diameter(pressure: number): number {
    return this.pressureSize ? Math.max(1, this.size * Math.max(0.05, pressure)) : this.size;
  }

  private dab(p: StrokePoint): void {
    const alpha = this.pressureOpacity ? Math.max(0.02, p.pressure) : 1;
    const r = this.diameter(p.pressure) / 2;
    const a = this.axes;
    for (const [x, y] of mirrorPoints(
      p.x,
      p.y,
      a,
      (v) => 2 * (a?.x ?? 0) - v,
      (v) => 2 * (a?.y ?? 0) - v,
    ))
      this.session.dabSoft(x, y, r, this.hardness, alpha);
  }

  begin(p: StrokePoint): void {
    this.dab(p);
    this.last = p;
    this.remainder = 0;
  }

  lineTo(p: StrokePoint): void {
    const a = this.last;
    if (!a) {
      this.begin(p);
      return;
    }
    const dx = p.x - a.x;
    const dy = p.y - a.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1e-6) return;
    const spacing = Math.max(0.35, this.diameter(Math.min(a.pressure, p.pressure)) * 0.1);
    let d = spacing - this.remainder;
    while (d <= dist) {
      const t = d / dist;
      this.dab({ x: a.x + dx * t, y: a.y + dy * t, pressure: a.pressure + (p.pressure - a.pressure) * t });
      d += spacing;
    }
    this.remainder = dist - (d - spacing);
    this.last = p;
  }
}

interface FreehandOptions {
  size: number;
  opacity: number;
  hardness?: number;
  pressureSize?: boolean;
  pressureOpacity?: boolean;
  smoothing?: number;
  pixelPerfect?: boolean;
  round?: boolean;
}

/** Base for brush, pencil and eraser: session handling, stabilizer, Shift+click lines, cursor. */
abstract class FreehandTool extends Tool {
  override readonly paints = true;
  override readonly altPicks = true;
  override readonly editsPixels = true;
  protected session: PaintSession | null = null;
  private soft: SoftStroke | null = null;
  private pixel: PixelStroke | null = null;
  private lazy: { x: number; y: number } | null = null;
  private lastRaw: StrokePoint | null = null;

  protected abstract get mode(): 'paint' | 'erase';
  protected abstract get pixelMode(): boolean;
  protected abstract opts(): FreehandOptions;

  override get busy(): boolean {
    return this.session !== null;
  }

  private pressureOf(p: ToolPointer): number {
    return p.pointerType === 'pen' ? p.pressure : 1;
  }

  override down(p: ToolPointer): void {
    const e = this.editor;
    if (!e.canEditPixels()) return;
    const o = this.opts();
    const color = p.button === 2 ? e.bg : e.fg;
    this.session = e.beginPaint({ color, opacity: o.opacity, mode: this.mode, alphaLock: e.doc.activeLayer.alphaLocked });
    const pt = { x: p.x, y: p.y, pressure: this.pressureOf(p) };
    const prev = p.shift ? e.lastStrokeEnd : null;
    if (this.pixelMode) {
      this.pixel = new PixelStroke(this.session, o.size, !!o.round, !!o.pixelPerfect, 1, e.symmetryAxes());
      if (prev) {
        this.pixel.begin(Math.floor(prev.x), Math.floor(prev.y));
        this.pixel.lineTo(Math.floor(pt.x), Math.floor(pt.y));
      } else this.pixel.begin(Math.floor(pt.x), Math.floor(pt.y));
    } else {
      this.soft = new SoftStroke(this.session, o.size, o.hardness ?? 1, !!o.pressureSize, !!o.pressureOpacity, e.symmetryAxes());
      if (prev) {
        this.soft.begin({ ...prev, pressure: pt.pressure });
        this.soft.lineTo(pt);
      } else this.soft.begin(pt);
    }
    this.lazy = { x: pt.x, y: pt.y };
    this.lastRaw = pt;
    this.session.apply();
    this.hoverPoint = p;
  }

  override move(p: ToolPointer): void {
    this.hoverPoint = p;
    if (!this.session) return;
    const raw = { x: p.x, y: p.y, pressure: this.pressureOf(p) };
    this.lastRaw = raw;
    let target = raw;
    const smoothing = this.opts().smoothing ?? 0;
    if (smoothing > 0 && this.lazy) {
      // "Pulled string" stabilizer: the brush trails the pointer by a fixed radius.
      const radius = (smoothing * 40) / this.editor.view.zoom;
      const dx = raw.x - this.lazy.x;
      const dy = raw.y - this.lazy.y;
      const d = Math.hypot(dx, dy);
      if (d <= radius) return;
      const k = (d - radius) / d;
      this.lazy = { x: this.lazy.x + dx * k, y: this.lazy.y + dy * k };
      target = { x: this.lazy.x, y: this.lazy.y, pressure: raw.pressure };
    }
    this.strokeTo(target);
    this.session.apply();
  }

  private strokeTo(t: StrokePoint): void {
    if (this.pixel) this.pixel.lineTo(Math.floor(t.x), Math.floor(t.y));
    else this.soft?.lineTo(t);
  }

  override up(p: ToolPointer): void {
    if (!this.session) return;
    if ((this.opts().smoothing ?? 0) > 0 && this.lastRaw) this.strokeTo(this.lastRaw);
    const end = this.pixel?.last
      ? { x: this.pixel.last.x + 0.5, y: this.pixel.last.y + 0.5 }
      : this.soft?.last
        ? { x: this.soft.last.x, y: this.soft.last.y }
        : { x: p.x, y: p.y };
    this.editor.commitPaint(this.session, this.label);
    this.editor.lastStrokeEnd = end;
    this.session = null;
    this.soft = null;
    this.pixel = null;
  }

  override cancel(): void {
    this.session?.cancel();
    this.session = null;
    this.soft = null;
    this.pixel = null;
  }

  protected override hasCursorOverlay(): boolean {
    return true;
  }

  override drawOverlay(ctx: CanvasRenderingContext2D, view: Viewport): void {
    const p = this.hoverPoint;
    if (!p || p.pointerType === 'touch') return;
    const o = this.opts();
    ctx.beginPath();
    if (this.pixelMode) {
      const n = Math.max(1, Math.round(o.size));
      const off = Math.floor((n - 1) / 2);
      const x0 = Math.floor(p.x) - off;
      const y0 = Math.floor(p.y) - off;
      const pts = [view.docToScreen(x0, y0), view.docToScreen(x0 + n, y0), view.docToScreen(x0 + n, y0 + n), view.docToScreen(x0, y0 + n)];
      if (n * view.zoom < 3) {
        // Too small to see: draw a crosshair instead.
        const c = view.docToScreen(x0 + n / 2, y0 + n / 2);
        ctx.moveTo(c.x - 6, c.y);
        ctx.lineTo(c.x + 6, c.y);
        ctx.moveTo(c.x, c.y - 6);
        ctx.lineTo(c.x, c.y + 6);
      } else {
        pts.forEach((q, i) => (i ? ctx.lineTo(Math.round(q.x) + 0.5, Math.round(q.y) + 0.5) : ctx.moveTo(Math.round(q.x) + 0.5, Math.round(q.y) + 0.5)));
        ctx.closePath();
      }
    } else {
      const c = view.docToScreen(p.x, p.y);
      const r = Math.max(1.5, (o.size / 2) * view.zoom);
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      if (r < 4) {
        ctx.moveTo(c.x - 6, c.y);
        ctx.lineTo(c.x + 6, c.y);
        ctx.moveTo(c.x, c.y - 6);
        ctx.lineTo(c.x, c.y + 6);
      }
    }
    strokeTwoTone(ctx);
  }
}

/** Shown with every freehand tool; stored in options.symmetry. */
export const SYMMETRY_SPEC: OptionSpec = {
  type: 'choice',
  group: 'symmetry',
  key: 'mode',
  label: 'Symmetry',
  choices: [
    { value: 'off', label: 'No mirror', title: 'Symmetry off' },
    { value: 'x', label: '⇆', title: 'Mirror left ↔ right' },
    { value: 'y', label: '⇅', title: 'Mirror top ↔ bottom' },
    { value: 'xy', label: '✣', title: 'Mirror both ways (4 copies)' },
  ],
};

const PRESSURE_SPECS: OptionSpec[] = [
  { type: 'toggle', key: 'pressureSize', label: 'Pressure → size', title: 'Pen pressure controls brush size' },
  { type: 'toggle', key: 'pressureOpacity', label: 'Pressure → opacity', title: 'Pen pressure controls opacity' },
];

export class BrushTool extends FreehandTool {
  readonly id: ToolId = 'brush';
  readonly label = 'Brush';
  override readonly shortcut = 'B';
  override readonly optionsKey = 'brush';
  override readonly optionSpecs: OptionSpec[] = [
    { type: 'slider', key: 'size', label: 'Size', min: 1, max: 500, unit: 'px', log: true },
    { type: 'slider', key: 'opacity', label: 'Opacity', min: 0.01, max: 1, step: 0.01, percent: true },
    { type: 'slider', key: 'hardness', label: 'Hardness', min: 0, max: 1, step: 0.01, percent: true },
    { type: 'slider', key: 'smoothing', label: 'Smoothing', min: 0, max: 1, step: 0.01, percent: true },
    ...PRESSURE_SPECS,
    SYMMETRY_SPEC,
  ];
  protected get mode() {
    return 'paint' as const;
  }
  protected get pixelMode() {
    return false;
  }
  protected opts() {
    return this.editor.options.brush;
  }
}

export class PencilTool extends FreehandTool {
  readonly id: ToolId = 'pencil';
  readonly label = 'Pencil';
  override readonly shortcut = 'P';
  override readonly optionsKey = 'pencil';
  override readonly optionSpecs: OptionSpec[] = [
    { type: 'slider', key: 'size', label: 'Size', min: 1, max: 64, unit: 'px' },
    { type: 'slider', key: 'opacity', label: 'Opacity', min: 0.01, max: 1, step: 0.01, percent: true },
    { type: 'toggle', key: 'pixelPerfect', label: 'Pixel perfect', title: 'Remove doubled corner pixels in 1px lines' },
    { type: 'toggle', key: 'round', label: 'Round tip', title: 'Round instead of square tip for sizes ≥ 3' },
    SYMMETRY_SPEC,
  ];
  protected get mode() {
    return 'paint' as const;
  }
  protected get pixelMode() {
    return true;
  }
  protected opts() {
    return this.editor.options.pencil;
  }
}

export class EraserTool extends FreehandTool {
  readonly id: ToolId = 'eraser';
  readonly label = 'Eraser';
  override readonly shortcut = 'E';
  override readonly optionsKey = 'eraser';
  override readonly optionSpecs: OptionSpec[] = [
    { type: 'slider', key: 'size', label: 'Size', min: 1, max: 500, unit: 'px', log: true },
    { type: 'slider', key: 'opacity', label: 'Opacity', min: 0.01, max: 1, step: 0.01, percent: true },
    { type: 'toggle', key: 'pixel', label: 'Hard pixels', title: 'Erase whole pixels (no anti-aliasing), like the pencil' },
    { type: 'slider', key: 'hardness', label: 'Hardness', min: 0, max: 1, step: 0.01, percent: true },
    ...PRESSURE_SPECS,
    SYMMETRY_SPEC,
  ];
  protected get mode() {
    return 'erase' as const;
  }
  protected get pixelMode() {
    return this.editor.options.eraser.pixel;
  }
  protected opts() {
    return this.editor.options.eraser;
  }
}

import type { PaintSession } from '../core/paint';
import { bresenham, ellipseOutline, ellipseSpans } from '../core/raster';
import type { Viewport } from '../render/viewport';
import { type OptionSpec, Tool, type ToolId, type ToolPointer } from './tool';

const SHAPE_SPECS: OptionSpec[] = [
  { type: 'slider', key: 'size', label: 'Width', min: 1, max: 64, unit: 'px' },
  { type: 'slider', key: 'opacity', label: 'Opacity', min: 0.01, max: 1, step: 0.01, percent: true },
  { type: 'toggle', key: 'antialias', label: 'Anti-alias', title: 'Smooth edges (off for crisp pixel art)' },
];

/** Pixel-art friendly line angles: horizontal, 2:1, 1:1, 1:2, vertical (and mirrors). */
const LINE_SNAP = [
  [1, 0],
  [2, 1],
  [1, 1],
  [1, 2],
  [0, 1],
].flatMap(([x, y]) => [
  [x, y],
  [-x, y],
  [x, -y],
  [-x, -y],
]);

/** Shared drag logic: the shape is re-rasterized from scratch on every move (live preview). */
abstract class ShapeTool extends Tool {
  override readonly paints = true;
  override readonly editsPixels = true;
  override readonly optionsKey = 'shape';
  protected session: PaintSession | null = null;

  override get busy(): boolean {
    return this.session !== null;
  }

  protected abstract rasterize(s: PaintSession, x0: number, y0: number, x1: number, y1: number, p: ToolPointer): void;
  /** Lines snap to grid intersections; boxes snap to whole grid cells. */
  protected readonly lineLike: boolean = false;
  private startRaw: { x: number; y: number } | null = null;

  /** Pixel endpoints of the current drag, honoring snap-to-grid. */
  private endpoints(p: ToolPointer): [number, number, number, number] {
    const s = this.startRaw!;
    const g = this.editor.gridSnap();
    if (!g) return [Math.floor(s.x), Math.floor(s.y), Math.floor(p.x), Math.floor(p.y)];
    const ax = Math.round(s.x / g.w) * g.w;
    const ay = Math.round(s.y / g.h) * g.h;
    const bx = Math.round(p.x / g.w) * g.w;
    const by = Math.round(p.y / g.h) * g.h;
    if (this.lineLike) return [ax, ay, bx, by];
    const x0 = Math.min(ax, bx);
    const y0 = Math.min(ay, by);
    let x1 = Math.max(ax, bx) - 1;
    let y1 = Math.max(ay, by) - 1;
    if (x1 < x0) x1 = x0 + g.w - 1;
    if (y1 < y0) y1 = y0 + g.h - 1;
    return [x0, y0, x1, y1];
  }

  override down(p: ToolPointer): void {
    const e = this.editor;
    if (!e.canEditPixels()) return;
    const o = e.options.shape;
    this.session = e.beginPaint({
      color: p.button === 2 ? e.bg : e.fg,
      opacity: o.opacity,
      mode: 'paint',
      alphaLock: e.doc.activeLayer.alphaLocked,
    });
    this.startRaw = { x: p.x, y: p.y };
    this.update(p);
  }

  override move(p: ToolPointer): void {
    this.hoverPoint = p;
    if (this.session) this.update(p);
  }

  private update(p: ToolPointer): void {
    const s = this.session!;
    const [x0, y0, x1, y1] = this.endpoints(p);
    s.resetCoverage();
    this.rasterize(s, x0, y0, x1, y1, p);
    s.apply();
    this.editor.setStatusHint(`${Math.abs(x1 - x0) + 1} × ${Math.abs(y1 - y0) + 1}`);
  }

  override up(): void {
    if (!this.session) return;
    this.editor.commitPaint(this.session, this.label);
    this.session = null;
    this.startRaw = null;
    this.editor.setStatusHint('');
  }

  override cancel(): void {
    this.session?.cancel();
    this.session = null;
    this.startRaw = null;
    this.editor.setStatusHint('');
  }

  /** Applies Shift (equal sides) and Alt (from center) to a rectangle drag. */
  protected constrainBox(x0: number, y0: number, x1: number, y1: number, p: ToolPointer): [number, number, number, number] {
    if (p.shift) {
      const d = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
      x1 = x0 + (x1 >= x0 ? d : -d);
      y1 = y0 + (y1 >= y0 ? d : -d);
    }
    if (p.alt) {
      x0 = 2 * x0 - x1;
      y0 = 2 * y0 - y1;
    }
    return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
  }
}

export class LineTool extends ShapeTool {
  readonly id: ToolId = 'line';
  readonly label = 'Line';
  override readonly shortcut = 'L';
  override readonly optionSpecs = SHAPE_SPECS;
  protected override readonly lineLike = true;

  protected rasterize(s: PaintSession, x0: number, y0: number, x1: number, y1: number, p: ToolPointer): void {
    if (p.shift) {
      // Snap the direction to pixel-art friendly angles.
      const dx = x1 - x0;
      const dy = y1 - y0;
      const len = Math.hypot(dx, dy);
      if (len > 0) {
        let best = LINE_SNAP[0];
        let bestDot = -Infinity;
        for (const v of LINE_SNAP) {
          const dot = (v[0] * dx + v[1] * dy) / Math.hypot(v[0], v[1]);
          if (dot > bestDot) {
            bestDot = dot;
            best = v;
          }
        }
        const steps = Math.round(bestDot / Math.hypot(best[0], best[1]));
        x1 = x0 + best[0] * steps;
        y1 = y0 + best[1] * steps;
      }
    }
    drawLine(s, x0, y0, x1, y1, this.editor.options.shape.size, this.editor.options.shape.antialias);
  }
}

export class RectTool extends ShapeTool {
  readonly id: ToolId = 'rect';
  readonly label = 'Rectangle';
  override readonly shortcut = 'U';
  override readonly optionSpecs: OptionSpec[] = [{ type: 'toggle', key: 'fill', label: 'Filled' }, ...SHAPE_SPECS.filter((o) => o.key !== 'antialias')];

  protected rasterize(s: PaintSession, ax: number, ay: number, bx: number, by: number, p: ToolPointer): void {
    const [x0, y0, x1, y1] = this.constrainBox(ax, ay, bx, by, p);
    const o = this.editor.options.shape;
    const n = Math.max(1, Math.round(o.size));
    for (let y = y0; y <= y1; y++) {
      if (o.fill || y < y0 + n || y > y1 - n) s.span(y, x0, x1);
      else {
        s.span(y, x0, Math.min(x1, x0 + n - 1));
        s.span(y, Math.max(x0, x1 - n + 1), x1);
      }
    }
  }
}

export class EllipseTool extends ShapeTool {
  readonly id: ToolId = 'ellipse';
  readonly label = 'Ellipse';
  override readonly shortcut = 'O';
  override readonly optionSpecs: OptionSpec[] = [{ type: 'toggle', key: 'fill', label: 'Filled' }, ...SHAPE_SPECS];

  protected rasterize(s: PaintSession, ax: number, ay: number, bx: number, by: number, p: ToolPointer): void {
    const [x0, y0, x1, y1] = this.constrainBox(ax, ay, bx, by, p);
    const o = this.editor.options.shape;
    const n = Math.max(1, Math.round(o.size));
    if (o.antialias) {
      drawEllipseAA(s, x0, y0, x1, y1, o.fill ? 0 : n);
      return;
    }
    if (o.fill) {
      ellipseSpans(x0, y0, x1, y1, (y, a, b) => s.span(y, a, b));
    } else if (n === 1 || x1 - x0 < 2 * n || y1 - y0 < 2 * n) {
      if (n === 1) ellipseOutline(x0, y0, x1, y1, (x, y) => s.span(y, x, x));
      else ellipseSpans(x0, y0, x1, y1, (y, a, b) => s.span(y, a, b));
    } else {
      // Thick outline: outer ellipse minus the inner ellipse inset by n.
      const inner = new Map<number, [number, number]>();
      ellipseSpans(x0 + n, y0 + n, x1 - n, y1 - n, (y, a, b) => inner.set(y, [a, b]));
      ellipseSpans(x0, y0, x1, y1, (y, a, b) => {
        const i = inner.get(y);
        if (!i) s.span(y, a, b);
        else {
          s.span(y, a, i[0] - 1);
          s.span(y, i[1] + 1, b);
        }
      });
    }
  }
}

/** Line of `size` pixels between pixel centers; hard pixels or anti-aliased. */
export function drawLine(s: PaintSession, x0: number, y0: number, x1: number, y1: number, size: number, aa: boolean): void {
  const n = Math.max(1, Math.round(size));
  if (!aa) {
    bresenham(x0, y0, x1, y1, (x, y) => s.dabPixel(x, y, n, n >= 3));
    return;
  }
  const ax = x0 + 0.5;
  const ay = y0 + 0.5;
  const dx = x1 + 0.5 - ax;
  const dy = y1 + 0.5 - ay;
  const len = Math.hypot(dx, dy);
  const steps = Math.max(1, Math.ceil(len / 0.4));
  for (let i = 0; i <= steps; i++) s.dabSoft(ax + (dx * i) / steps, ay + (dy * i) / steps, size / 2, 1, 1);
}

/** Anti-aliased ellipse using an approximate signed distance; width 0 = filled. */
function drawEllipseAA(s: PaintSession, x0: number, y0: number, x1: number, y1: number, width: number): void {
  const cx = (x0 + x1 + 1) / 2;
  const cy = (y0 + y1 + 1) / 2;
  const rx = (x1 - x0 + 1) / 2;
  const ry = (y1 - y0 + 1) / 2;
  const half = width / 2;
  const cov = new Uint8Array((x1 - x0 + 3) * (y1 - y0 + 3));
  const bw = x1 - x0 + 3;
  for (let y = y0 - 1; y <= y1 + 1; y++) {
    const py = y + 0.5 - cy;
    for (let x = x0 - 1; x <= x1 + 1; x++) {
      const px = x + 0.5 - cx;
      const f = (px * px) / (rx * rx) + (py * py) / (ry * ry) - 1;
      const g = 2 * Math.sqrt((px * px) / rx ** 4 + (py * py) / ry ** 4);
      const d = f / Math.max(g, 1e-6); // signed distance, negative inside
      let c: number;
      if (width <= 0) c = 0.5 - d;
      else c = half + 0.5 - Math.abs(d + half);
      if (c > 0) cov[(y - y0 + 1) * bw + (x - x0 + 1)] = Math.min(1, c) * 255;
    }
  }
  s.addCoverage(cov, { x: x0 - 1, y: y0 - 1, w: bw, h: y1 - y0 + 3 });
}

/** Overlay helper shared with selection tools: outline of a document rectangle. */
export function docRectPath(ctx: CanvasRenderingContext2D, view: Viewport, x0: number, y0: number, x1: number, y1: number): void {
  const pts = [view.docToScreen(x0, y0), view.docToScreen(x1, y0), view.docToScreen(x1, y1), view.docToScreen(x0, y1)];
  ctx.beginPath();
  pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
  ctx.closePath();
}

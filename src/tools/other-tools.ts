import { toCss } from '../core/color';
import { compositeFrame, sampleComposite } from '../core/composite';
import type { Point } from '../core/geometry';
import { ellipseSpans, fillPolygon, floodFill } from '../core/raster';
import type { SelectionMode } from '../core/selection';
import type { Viewport } from '../render/viewport';
import { MoveSession } from './move-session';
import { strokeTwoTone } from './paint-tools';
import { docRectPath } from './shape-tools';
import { type OptionSpec, SELECT_MODE_CHOICES, Tool, type ToolId, type ToolPointer } from './tool';

export class FillTool extends Tool {
  readonly id: ToolId = 'fill';
  readonly label = 'Fill';
  override readonly shortcut = 'G';
  override readonly optionsKey = 'fill';
  override readonly paints = true;
  override readonly altPicks = true;
  override readonly editsPixels = true;
  override readonly optionSpecs: OptionSpec[] = [
    { type: 'slider', key: 'tolerance', label: 'Tolerance', min: 0, max: 255, step: 1 },
    { type: 'slider', key: 'opacity', label: 'Opacity', min: 0.01, max: 1, step: 0.01, percent: true },
    { type: 'toggle', key: 'contiguous', label: 'Contiguous', title: 'Only fill connected pixels' },
    { type: 'toggle', key: 'sampleMerged', label: 'All layers', title: 'Detect regions using all visible layers' },
  ];

  override down(p: ToolPointer): void {
    const e = this.editor;
    const doc = e.doc;
    const x = Math.floor(p.x);
    const y = Math.floor(p.y);
    if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) return;
    if (!e.canEditPixels()) return;
    const o = e.options.fill;
    const src = o.sampleMerged ? compositeFrame(doc, doc.activeFrame) : doc.activeCel.data;
    const session = e.beginPaint({ color: p.button === 2 ? e.bg : e.fg, opacity: o.opacity, mode: 'paint', alphaLock: doc.activeLayer.alphaLocked });
    const r = floodFill(src, doc.width, doc.height, x, y, o.tolerance, o.contiguous, session.mask, doc.selection.mask);
    if (r) session.markDirty(r);
    e.commitPaint(session, 'Fill');
  }
}

export class PickerTool extends Tool {
  readonly id: ToolId = 'picker';
  readonly label = 'Color picker';
  override readonly shortcut = 'I';
  override readonly optionsKey = 'picker';
  override readonly optionSpecs: OptionSpec[] = [
    { type: 'toggle', key: 'sampleMerged', label: 'All layers', title: 'Pick the visible color instead of the active layer' },
  ];
  private dragging = false;
  private target: 'fg' | 'bg' = 'fg';

  override get busy(): boolean {
    return this.dragging;
  }

  override down(p: ToolPointer): void {
    this.dragging = true;
    this.target = p.button === 2 ? 'bg' : 'fg';
    this.pick(p);
  }

  override move(p: ToolPointer): void {
    this.hoverPoint = p;
    if (this.dragging) this.pick(p);
  }

  override up(): void {
    this.dragging = false;
    this.editor.renderer.requestRender();
  }

  override cancel(): void {
    this.dragging = false;
  }

  /** Picks a color; used by this tool and by Alt+click in paint tools. */
  pick(p: { x: number; y: number }, target: 'fg' | 'bg' = this.target, merged = this.editor.options.picker.sampleMerged): void {
    const e = this.editor;
    const doc = e.doc;
    const x = Math.floor(p.x);
    const y = Math.floor(p.y);
    if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) return;
    const [r, g, b, a] = merged ? sampleComposite(doc, doc.activeFrame, x, y) : doc.activeCel.getPixel(x, y);
    if (a === 0) return; // Transparent: keep the current color.
    e.setColor(target, { r, g, b, a });
  }

  protected override hasCursorOverlay(): boolean {
    return true;
  }

  override drawOverlay(ctx: CanvasRenderingContext2D, view: Viewport): void {
    const p = this.hoverPoint;
    if (!p || !this.dragging) return;
    // Color ring offset above the finger so it stays visible on touch screens.
    const c = view.docToScreen(Math.floor(p.x) + 0.5, Math.floor(p.y) + 0.5);
    const lift = p.pointerType === 'touch' ? 70 : 0;
    const color = this.target === 'bg' ? this.editor.bg : this.editor.fg;
    ctx.beginPath();
    ctx.arc(c.x, c.y - lift, 26, 0, Math.PI * 2);
    ctx.lineWidth = 12;
    ctx.strokeStyle = toCss({ ...color, a: 255 });
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(c.x, c.y - lift, 32, 0, Math.PI * 2);
    ctx.arc(c.x, c.y - lift, 20, 0, Math.PI * 2);
    strokeTwoTone(ctx);
  }
}

/** Selection mode from modifier keys (Shift add, Alt subtract, both intersect), else the option. */
function selectionModeFor(p: ToolPointer, fallback: SelectionMode): SelectionMode {
  if (p.shift && p.alt) return 'intersect';
  if (p.shift) return 'add';
  if (p.alt) return 'subtract';
  return fallback;
}

abstract class DragSelectTool extends Tool {
  override readonly optionsKey = 'select';
  override readonly optionSpecs: OptionSpec[] = [{ type: 'choice', key: 'mode', label: 'Mode', choices: SELECT_MODE_CHOICES }];
  protected startPt: Point | null = null;
  protected curPt: Point | null = null;
  protected mode: SelectionMode = 'replace';

  override get busy(): boolean {
    return this.startPt !== null;
  }

  protected snap(p: Point): Point {
    const g = this.editor.gridSnap();
    if (g) return { x: Math.round(p.x / g.w) * g.w, y: Math.round(p.y / g.h) * g.h };
    return { x: Math.round(p.x), y: Math.round(p.y) };
  }

  override down(p: ToolPointer): void {
    this.mode = selectionModeFor(p, this.editor.options.select.mode);
    this.startPt = this.snap(p);
    this.curPt = this.startPt;
  }

  override move(p: ToolPointer): void {
    this.hoverPoint = p;
    if (!this.startPt) return;
    this.curPt = this.snap(p);
    const r = this.box();
    this.editor.setStatusHint(`${r.w} × ${r.h}`);
    this.editor.renderer.requestRender();
  }

  protected box(): { x: number; y: number; w: number; h: number } {
    const a = this.startPt!;
    const b = this.curPt!;
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
  }

  protected abstract buildMask(r: { x: number; y: number; w: number; h: number }, out: Uint8Array): void;

  override up(): void {
    if (!this.startPt) return;
    const e = this.editor;
    const r = this.box();
    this.startPt = null;
    e.setStatusHint('');
    if (r.w < 1 || r.h < 1) {
      // A click without a drag deselects (in replace mode).
      if (this.mode === 'replace') e.deselect();
      e.renderer.requestRender();
      return;
    }
    const mask = new Uint8Array(e.doc.width * e.doc.height);
    this.buildMask(r, mask);
    e.applySelection(mask, r, this.mode, this.label);
  }

  override cancel(): void {
    this.startPt = null;
    this.editor.setStatusHint('');
    this.editor.renderer.requestRender();
  }

  override drawOverlay(ctx: CanvasRenderingContext2D, view: Viewport): void {
    if (!this.startPt || !this.curPt) return;
    const r = this.box();
    this.previewPath(ctx, view, r);
    ctx.setLineDash([]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#000';
    ctx.stroke();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#fff';
    ctx.stroke();
  }

  protected previewPath(ctx: CanvasRenderingContext2D, view: Viewport, r: { x: number; y: number; w: number; h: number }): void {
    docRectPath(ctx, view, r.x, r.y, r.x + r.w, r.y + r.h);
  }
}

export class RectSelectTool extends DragSelectTool {
  readonly id: ToolId = 'select-rect';
  readonly label = 'Rectangle select';
  override readonly shortcut = 'S';

  protected buildMask(r: { x: number; y: number; w: number; h: number }, out: Uint8Array): void {
    const W = this.editor.doc.width;
    const H = this.editor.doc.height;
    const x0 = Math.max(0, r.x);
    const x1 = Math.min(W, r.x + r.w);
    for (let y = Math.max(0, r.y); y < Math.min(H, r.y + r.h); y++) if (x1 > x0) out.fill(255, y * W + x0, y * W + x1);
  }
}

export class EllipseSelectTool extends DragSelectTool {
  readonly id: ToolId = 'select-ellipse';
  readonly label = 'Ellipse select';

  protected buildMask(r: { x: number; y: number; w: number; h: number }, out: Uint8Array): void {
    const W = this.editor.doc.width;
    const H = this.editor.doc.height;
    ellipseSpans(r.x, r.y, r.x + r.w - 1, r.y + r.h - 1, (y, a, b) => {
      if (y < 0 || y >= H) return;
      const xa = Math.max(0, a);
      const xb = Math.min(W - 1, b);
      if (xb >= xa) out.fill(255, y * W + xa, y * W + xb + 1);
    });
  }

  protected override previewPath(ctx: CanvasRenderingContext2D, view: Viewport, r: { x: number; y: number; w: number; h: number }): void {
    ctx.beginPath();
    const steps = 64;
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * Math.PI * 2;
      const q = view.docToScreen(r.x + r.w / 2 + (Math.cos(t) * r.w) / 2, r.y + r.h / 2 + (Math.sin(t) * r.h) / 2);
      if (i) ctx.lineTo(q.x, q.y);
      else ctx.moveTo(q.x, q.y);
    }
    ctx.closePath();
  }
}

export class LassoTool extends Tool {
  readonly id: ToolId = 'lasso';
  readonly label = 'Lasso select';
  override readonly optionsKey = 'select';
  override readonly optionSpecs: OptionSpec[] = [{ type: 'choice', key: 'mode', label: 'Mode', choices: SELECT_MODE_CHOICES }];
  private points: Point[] = [];
  private mode: SelectionMode = 'replace';
  private active = false;

  override get busy(): boolean {
    return this.active;
  }

  override down(p: ToolPointer): void {
    this.mode = selectionModeFor(p, this.editor.options.select.mode);
    this.points = [{ x: p.x, y: p.y }];
    this.active = true;
  }

  override move(p: ToolPointer): void {
    if (!this.active) return;
    const last = this.points[this.points.length - 1];
    if (Math.hypot(p.x - last.x, p.y - last.y) * this.editor.view.zoom >= 2) {
      this.points.push({ x: p.x, y: p.y });
      this.editor.renderer.requestRender();
    }
  }

  override up(): void {
    if (!this.active) return;
    this.active = false;
    const e = this.editor;
    const pts = this.points;
    this.points = [];
    const mask = new Uint8Array(e.doc.width * e.doc.height);
    const r = pts.length >= 3 ? fillPolygon(pts, e.doc.width, e.doc.height, mask) : null;
    if (!r) {
      if (this.mode === 'replace') e.deselect();
      e.renderer.requestRender();
      return;
    }
    e.applySelection(mask, r, this.mode, 'Lasso select');
  }

  override cancel(): void {
    this.active = false;
    this.points = [];
    this.editor.renderer.requestRender();
  }

  override drawOverlay(ctx: CanvasRenderingContext2D, view: Viewport): void {
    if (!this.active || this.points.length < 2) return;
    ctx.beginPath();
    this.points.forEach((pt, i) => {
      const q = view.docToScreen(pt.x, pt.y);
      if (i) ctx.lineTo(q.x, q.y);
      else ctx.moveTo(q.x, q.y);
    });
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#000';
    ctx.stroke();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#fff';
    ctx.stroke();
  }
}

export class WandTool extends Tool {
  readonly id: ToolId = 'wand';
  readonly label = 'Magic wand';
  override readonly shortcut = 'W';
  override readonly optionsKey = 'wand';
  override readonly optionSpecs: OptionSpec[] = [
    { type: 'slider', key: 'tolerance', label: 'Tolerance', min: 0, max: 255, step: 1 },
    { type: 'toggle', key: 'contiguous', label: 'Contiguous' },
    { type: 'toggle', key: 'sampleMerged', label: 'All layers' },
  ];

  override down(p: ToolPointer): void {
    const e = this.editor;
    const doc = e.doc;
    const x = Math.floor(p.x);
    const y = Math.floor(p.y);
    if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) return;
    const o = e.options.wand;
    const src = o.sampleMerged ? compositeFrame(doc, doc.activeFrame) : doc.activeCel.data;
    const mask = new Uint8Array(doc.width * doc.height);
    const r = floodFill(src, doc.width, doc.height, x, y, o.tolerance, o.contiguous, mask);
    if (r) e.applySelection(mask, r, selectionModeFor(p, e.options.select.mode), 'Magic wand');
  }
}

export class MoveTool extends Tool {
  readonly id: ToolId = 'move';
  readonly label = 'Move';
  override readonly shortcut = 'M';
  override readonly editsPixels = true;
  override cursor = 'move';
  private drag: { x: number; y: number; dx0: number; dy0: number } | null = null;

  override get busy(): boolean {
    return this.drag !== null;
  }

  /** The active floating session for the active cel, lifting pixels if needed. */
  private session(): MoveSession | null {
    const e = this.editor;
    const cel = e.doc.activeCel;
    if (e.floating && e.floating.surface === cel) return e.floating;
    e.commitFloating();
    if (!e.canEditPixels()) return null;
    const s = MoveSession.lift(e.doc, cel);
    if (!s) {
      e.toast('Nothing to move on this layer');
      return null;
    }
    e.floating = s;
    return s;
  }

  override down(p: ToolPointer): void {
    const s = this.session();
    if (!s) return;
    this.drag = { x: p.x, y: p.y, dx0: s.dx, dy0: s.dy };
  }

  override move(p: ToolPointer): void {
    const d = this.drag;
    const s = this.editor.floating;
    if (!d || !s) return;
    let dx = Math.round(p.x - d.x);
    let dy = Math.round(p.y - d.y);
    const g = this.editor.gridSnap();
    if (g) {
      dx = Math.round(dx / g.w) * g.w;
      dy = Math.round(dy / g.h) * g.h;
    }
    s.moveTo(d.dx0 + dx, d.dy0 + dy);
    this.editor.setStatusHint(`Δ ${s.dx}, ${s.dy}`);
  }

  override up(): void {
    this.drag = null;
  }

  override cancel(): void {
    const d = this.drag;
    if (d && this.editor.floating) this.editor.floating.moveTo(d.dx0, d.dy0);
    this.drag = null;
  }

  override keyDown(e: KeyboardEvent): boolean {
    const step = e.shiftKey ? 10 : 1;
    const dirs: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const d = dirs[e.key];
    if (!d) return false;
    const s = this.session();
    if (s) {
      s.moveTo(s.dx + d[0], s.dy + d[1]);
      this.editor.setStatusHint(`Δ ${s.dx}, ${s.dy}`);
    }
    return true;
  }

  override deactivate(): void {
    super.deactivate();
    this.editor.commitFloating();
  }
}

export class HandTool extends Tool {
  readonly id: ToolId = 'hand';
  readonly label = 'Pan';
  override readonly shortcut = 'H';
  override cursor = 'grab';
  private last: { sx: number; sy: number } | null = null;

  override get busy(): boolean {
    return this.last !== null;
  }

  override down(p: ToolPointer): void {
    this.last = { sx: p.sx, sy: p.sy };
  }

  override move(p: ToolPointer): void {
    if (!this.last) return;
    this.editor.view.panBy(p.sx - this.last.sx, p.sy - this.last.sy);
    this.last = { sx: p.sx, sy: p.sy };
    this.editor.viewChanged();
  }

  override up(): void {
    this.last = null;
  }

  override cancel(): void {
    this.last = null;
  }
}

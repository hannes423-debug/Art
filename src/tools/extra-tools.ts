import type { RGBA } from '../core/color';
import { type Rect, unionRect } from '../core/geometry';
import { bayerThreshold, bresenham } from '../core/raster';
import { TileRecorder } from '../core/tiles';
import type { Viewport } from '../render/viewport';
import { mirrorPoints, strokeTwoTone, SYMMETRY_SPEC } from './paint-tools';
import { type OptionSpec, Tool, type ToolId, type ToolPointer } from './tool';

/**
 * Shading ink: every pixel the stroke passes over moves one step along the
 * palette (to the next or previous swatch). Pixels whose color is not in
 * the palette are left alone, and each pixel changes at most once per
 * stroke, so scrubbing back and forth never over-shades.
 */
export class ShadeTool extends Tool {
  readonly id: ToolId = 'shade';
  readonly label = 'Shading';
  override readonly shortcut = 'K';
  override readonly optionsKey = 'shade';
  /** Receives right-clicks (they step the other way along the palette). */
  override readonly paints = true;
  override readonly altPicks = true;
  override readonly editsPixels = true;
  override readonly optionSpecs: OptionSpec[] = [
    { type: 'slider', key: 'size', label: 'Size', min: 1, max: 64, unit: 'px' },
    {
      type: 'choice',
      key: 'direction',
      label: 'Step',
      choices: [
        { value: 'next', label: 'Next →', title: 'Move each pixel to the next palette color (right-click: previous)' },
        { value: 'prev', label: '← Previous', title: 'Move each pixel to the previous palette color (right-click: next)' },
      ],
    },
    { type: 'toggle', key: 'round', label: 'Round tip', title: 'Round instead of square tip for sizes ≥ 3' },
    SYMMETRY_SPEC,
  ];

  private rec: TileRecorder | null = null;
  private done: Uint8Array | null = null;
  private dirty: Rect | null = null;
  private last: { x: number; y: number } | null = null;
  private step = 1;
  private index = new Map<number, number>();
  private ramp: number[] = [];

  override get busy(): boolean {
    return this.rec !== null;
  }

  override down(p: ToolPointer): void {
    const e = this.editor;
    if (!e.canEditPixels()) return;
    if (e.palette.length < 2) {
      e.toast('Shading steps through the palette: add at least two colors to it.');
      return;
    }
    e.commitFloating();
    e.stop();
    const o = e.options.shade;
    this.step = (o.direction === 'prev' ? -1 : 1) * (p.button === 2 ? -1 : 1);
    this.ramp = e.palette.map((c) => (c.r << 16) | (c.g << 8) | c.b);
    this.index.clear();
    // First occurrence wins when a color appears twice.
    this.ramp.forEach((c, i) => {
      if (!this.index.has(c)) this.index.set(c, i);
    });
    this.rec = new TileRecorder(e.doc.activeCel);
    this.done = new Uint8Array(e.doc.width * e.doc.height);
    const x = Math.floor(p.x);
    const y = Math.floor(p.y);
    this.dab(x, y);
    this.last = { x, y };
    this.flush();
  }

  override move(p: ToolPointer): void {
    this.hoverPoint = p;
    if (!this.rec || !this.last) return;
    const x = Math.floor(p.x);
    const y = Math.floor(p.y);
    if (x === this.last.x && y === this.last.y) return;
    let first = true;
    bresenham(this.last.x, this.last.y, x, y, (px, py) => {
      if (first) {
        first = false;
        return;
      }
      this.dab(px, py);
    });
    this.last = { x, y };
    this.flush();
  }

  override up(): void {
    const rec = this.rec;
    if (!rec) return;
    this.flush();
    const doc = this.editor.doc;
    const patch = rec.finish('Shade', (s, r) => doc.notifyPixels(s, r));
    if (patch) this.editor.history.push(patch);
    this.reset();
  }

  override cancel(): void {
    const rec = this.rec;
    if (rec) {
      const doc = this.editor.doc;
      const area = rec.bounds();
      if (area) {
        rec.restore(area);
        doc.activeCel.touch(area);
        doc.notifyPixels(doc.activeCel, area);
      }
      rec.finish('', () => {});
    }
    this.reset();
  }

  private reset(): void {
    this.rec = null;
    this.done = null;
    this.dirty = null;
    this.last = null;
  }

  /** Shades a dab of `size` pixels centered on (x, y) and its mirror images. */
  private dab(x: number, y: number): void {
    const e = this.editor;
    const o = e.options.shade;
    const n = Math.max(1, Math.round(o.size));
    const off = Math.floor((n - 1) / 2);
    const axes = e.symmetryAxes();
    const shift = 2 * off - n;
    const centers = mirrorPoints(
      x,
      y,
      axes,
      (v) => Math.round(2 * (axes?.x ?? 0)) - v + shift,
      (v) => Math.round(2 * (axes?.y ?? 0)) - v + shift,
    );
    const rr = n >= 3 && o.round ? (n / 2 - 0.25) ** 2 : Infinity;
    for (const [cx, cy] of centers) {
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          if ((i + 0.5 - n / 2) ** 2 + (j + 0.5 - n / 2) ** 2 > rr) continue;
          this.shadePixel(cx - off + i, cy - off + j);
        }
      }
    }
  }

  private shadePixel(px: number, py: number): void {
    const e = this.editor;
    const doc = e.doc;
    const w = e.wrapPoint(px, py);
    const x = w.x;
    const y = w.y;
    if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) return;
    const i = y * doc.width + x;
    if (this.done![i]) return;
    this.done![i] = 1;
    const sel = doc.selection.mask;
    if (sel && sel[i] < 128) return;
    const cel = doc.activeCel;
    const data = cel.data;
    if (!data) return;
    const o = i * 4;
    if (data[o + 3] === 0) return;
    const at = this.index.get((data[o] << 16) | (data[o + 1] << 8) | data[o + 2]);
    if (at === undefined) return;
    const next = Math.max(0, Math.min(this.ramp.length - 1, at + this.step));
    if (next === at) return;
    this.rec!.record({ x, y, w: 1, h: 1 });
    const c = this.ramp[next];
    data[o] = c >> 16;
    data[o + 1] = (c >> 8) & 255;
    data[o + 2] = c & 255;
    this.dirty = unionRect(this.dirty, { x, y, w: 1, h: 1 });
  }

  private flush(): void {
    const r = this.dirty;
    if (!r) return;
    this.dirty = null;
    const doc = this.editor.doc;
    doc.activeCel.touch(r);
    doc.notifyPixels(doc.activeCel, r);
  }

  protected override hasCursorOverlay(): boolean {
    return true;
  }

  override drawOverlay(ctx: CanvasRenderingContext2D, view: Viewport): void {
    const p = this.hoverPoint;
    if (!p || p.pointerType === 'touch') return;
    const n = Math.max(1, Math.round(this.editor.options.shade.size));
    const off = Math.floor((n - 1) / 2);
    const x0 = Math.floor(p.x) - off;
    const y0 = Math.floor(p.y) - off;
    const pts = [view.docToScreen(x0, y0), view.docToScreen(x0 + n, y0), view.docToScreen(x0 + n, y0 + n), view.docToScreen(x0, y0 + n)];
    ctx.beginPath();
    pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
    ctx.closePath();
    strokeTwoTone(ctx);
  }
}

/**
 * Gradient fill. Drag to set the direction; linear or radial; from the
 * foreground color to the background color or to transparent. "Dither"
 * uses an ordered (Bayer) pattern with only the two end colors, the classic
 * pixel-art look. Fills the selection, or the whole layer.
 */
export class GradientTool extends Tool {
  readonly id: ToolId = 'gradient';
  readonly label = 'Gradient';
  override readonly shortcut = 'Shift+G';
  override readonly optionsKey = 'gradient';
  override readonly paints = true;
  override readonly editsPixels = true;
  override readonly optionSpecs: OptionSpec[] = [
    {
      type: 'choice',
      key: 'shape',
      label: 'Shape',
      choices: [
        { value: 'linear', label: 'Linear' },
        { value: 'radial', label: 'Radial' },
      ],
    },
    {
      type: 'choice',
      key: 'to',
      label: 'To',
      choices: [
        { value: 'bg', label: 'FG → BG', title: 'From the foreground to the background color' },
        { value: 'transparent', label: 'FG → clear', title: 'From the foreground color to transparent' },
      ],
    },
    { type: 'toggle', key: 'dither', label: 'Dither', title: 'Ordered dithering with only the two end colors (pixel art)' },
    { type: 'slider', key: 'opacity', label: 'Opacity', min: 0.01, max: 1, step: 0.01, percent: true },
  ];

  private rec: TileRecorder | null = null;
  private area: Rect | null = null;
  private start: { x: number; y: number } | null = null;
  private end: { x: number; y: number } | null = null;
  private colors: [RGBA, RGBA] | null = null;

  override get busy(): boolean {
    return this.rec !== null;
  }

  override down(p: ToolPointer): void {
    const e = this.editor;
    if (!e.canEditPixels()) return;
    e.commitFloating();
    e.stop();
    const doc = e.doc;
    const cel = doc.activeCel;
    this.area = doc.selection.bounds ?? { x: 0, y: 0, w: doc.width, h: doc.height };
    this.rec = new TileRecorder(cel);
    this.rec.record(this.area);
    const o = e.options.gradient;
    const a = p.button === 2 ? e.bg : e.fg;
    const b = o.to === 'transparent' ? { ...a, a: 0 } : p.button === 2 ? e.fg : e.bg;
    this.colors = [a, b];
    this.start = { x: p.x, y: p.y };
    this.end = { x: p.x, y: p.y };
    this.hoverPoint = p;
  }

  override move(p: ToolPointer): void {
    this.hoverPoint = p;
    if (!this.rec || !this.start) return;
    let x = p.x;
    let y = p.y;
    if (p.shift) {
      // Snap the angle to 15° steps.
      const dx = x - this.start.x;
      const dy = y - this.start.y;
      const len = Math.hypot(dx, dy);
      const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 12)) * (Math.PI / 12);
      x = this.start.x + Math.cos(ang) * len;
      y = this.start.y + Math.sin(ang) * len;
    }
    this.end = { x, y };
    this.render();
    const len = Math.hypot(x - this.start.x, y - this.start.y);
    const deg = Math.round((Math.atan2(y - this.start.y, x - this.start.x) * 180) / Math.PI);
    this.editor.setStatusHint(`Length ${Math.round(len)} px · ${deg}° · Shift snaps the angle`);
  }

  override up(): void {
    const rec = this.rec;
    if (!rec) return;
    const e = this.editor;
    const doc = e.doc;
    const s = this.start!;
    const t = this.end!;
    if (Math.hypot(t.x - s.x, t.y - s.y) < 0.5) {
      // A click without dragging does nothing.
      this.cancel();
      return;
    }
    this.render();
    const patch = rec.finish('Gradient', (sf, r) => doc.notifyPixels(sf, r));
    if (patch) e.history.push(patch);
    if (this.colors && this.colors[0].a > 0) e.addRecent(this.colors[0]);
    this.reset();
  }

  override cancel(): void {
    const rec = this.rec;
    if (rec && this.area) {
      const doc = this.editor.doc;
      rec.restore(this.area);
      doc.activeCel.touch(this.area);
      doc.notifyPixels(doc.activeCel, this.area);
      rec.finish('', () => {});
    }
    this.reset();
  }

  private reset(): void {
    this.rec = null;
    this.area = null;
    this.start = null;
    this.end = null;
    this.colors = null;
    this.editor.setStatusHint('');
    this.editor.renderer.requestRender();
  }

  /** Recomputes the gradient over the original pixels of the fill area. */
  private render(): void {
    const e = this.editor;
    const doc = e.doc;
    const rec = this.rec!;
    const area = this.area!;
    const cel = doc.activeCel;
    const data = cel.ensureData();
    const o = e.options.gradient;
    const sel = doc.selection.mask;
    const alphaLock = doc.activeLayer.alphaLocked;
    const snap = e.paletteSnap();
    const [c0, c1] = this.colors!;
    const s = this.start!;
    const t = this.end!;
    const dx = t.x - s.x;
    const dy = t.y - s.y;
    const len2 = dx * dx + dy * dy || 1;
    const len = Math.sqrt(len2);
    const radial = o.shape === 'radial';
    const w = doc.width;
    // Premultiplied end colors, so fading to transparent keeps the hue.
    const a0 = c0.a / 255;
    const a1 = c1.a / 255;
    rec.forEachTileIn(area, (tile, r) => {
      const td = tile.data;
      for (let y = r.y; y < r.y + r.h; y++) {
        let p = y * w + r.x;
        let q = p * 4;
        let k = ((y - tile.y) * tile.w + (r.x - tile.x)) * 4;
        for (let x = r.x; x < r.x + r.w; x++, p++, q += 4, k += 4) {
          const or = td[k];
          const og = td[k + 1];
          const ob = td[k + 2];
          const oa8 = td[k + 3];
          const cov = sel ? sel[p] / 255 : 1;
          const px = x + 0.5 - s.x;
          const py = y + 0.5 - s.y;
          let f = radial ? Math.sqrt(px * px + py * py) / len : (px * dx + py * dy) / len2;
          f = f < 0 ? 0 : f > 1 ? 1 : f;
          let cr: number;
          let cg: number;
          let cb: number;
          let ca: number;
          if (o.dither) {
            const c = f < bayerThreshold(x, y) ? c0 : c1;
            cr = c.r;
            cg = c.g;
            cb = c.b;
            ca = c.a / 255;
          } else {
            ca = a0 + (a1 - a0) * f;
            if (ca > 0) {
              cr = (c0.r * a0 + (c1.r * a1 - c0.r * a0) * f) / ca;
              cg = (c0.g * a0 + (c1.g * a1 - c0.g * a0) * f) / ca;
              cb = (c0.b * a0 + (c1.b * a1 - c0.b * a0) * f) / ca;
            } else {
              cr = c0.r;
              cg = c0.g;
              cb = c0.b;
            }
            if (snap) {
              const c = snap(Math.round(cr), Math.round(cg), Math.round(cb));
              cr = c >> 16;
              cg = (c >> 8) & 255;
              cb = c & 255;
            }
          }
          const sa = ca * o.opacity * cov;
          if (sa * 255 < 0.5 || (alphaLock && oa8 === 0)) {
            data[q] = or;
            data[q + 1] = og;
            data[q + 2] = ob;
            data[q + 3] = oa8;
            continue;
          }
          if (alphaLock) {
            data[q] = or + (cr - or) * sa;
            data[q + 1] = og + (cg - og) * sa;
            data[q + 2] = ob + (cb - ob) * sa;
            data[q + 3] = oa8;
            continue;
          }
          const da = oa8 / 255;
          const kk = da * (1 - sa);
          const oa = sa + kk;
          data[q] = (cr * sa + or * kk) / oa;
          data[q + 1] = (cg * sa + og * kk) / oa;
          data[q + 2] = (cb * sa + ob * kk) / oa;
          data[q + 3] = oa * 255;
        }
      }
    });
    cel.touch(area);
    doc.notifyPixels(cel, area);
  }

  protected override hasCursorOverlay(): boolean {
    return true;
  }

  override drawOverlay(ctx: CanvasRenderingContext2D, view: Viewport): void {
    if (!this.start || !this.end) return;
    const a = view.docToScreen(this.start.x, this.start.y);
    const b = view.docToScreen(this.end.x, this.end.y);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    if (this.editor.options.gradient.shape === 'radial') {
      ctx.moveTo(a.x + Math.hypot(b.x - a.x, b.y - a.y), a.y);
      ctx.arc(a.x, a.y, Math.hypot(b.x - a.x, b.y - a.y), 0, Math.PI * 2);
    }
    strokeTwoTone(ctx);
    for (const pt of [a, b]) {
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      strokeTwoTone(ctx);
    }
  }
}

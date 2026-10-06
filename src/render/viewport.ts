import type { Point } from '../core/geometry';

export const MIN_ZOOM = 1 / 32;
export const MAX_ZOOM = 256;

/** Zoom levels used by zoom in/out buttons, keys and mouse wheel notches. */
export const ZOOM_STEPS = [
  1 / 32,
  1 / 24,
  1 / 16,
  1 / 12,
  1 / 8,
  1 / 6,
  1 / 4,
  1 / 3,
  1 / 2,
  2 / 3,
  1,
  1.5,
  2,
  3,
  4,
  5,
  6,
  8,
  10,
  12,
  16,
  20,
  24,
  32,
  40,
  48,
  64,
  80,
  96,
  128,
  160,
  192,
  256,
];

export interface Matrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

/**
 * Maps document pixels to screen (CSS) pixels:
 *   screen = translate(tx, ty) · rotate(rotation) · scale(zoom · (flipX ? -1 : 1), zoom) · doc
 * Zooming, rotating and flipping about any screen point keep this form, so
 * gestures compose without accumulating matrix error.
 */
export class Viewport {
  zoom = 1;
  /** Radians. */
  rotation = 0;
  flipX = false;
  tx = 0;
  ty = 0;
  /** Screen size in CSS pixels. */
  width = 1;
  height = 1;

  matrix(): Matrix {
    const fx = this.flipX ? -1 : 1;
    const cos = Math.cos(this.rotation) * this.zoom;
    const sin = Math.sin(this.rotation) * this.zoom;
    return { a: cos * fx, b: sin * fx, c: -sin, d: cos, e: this.tx, f: this.ty };
  }

  docToScreen(x: number, y: number): Point {
    const m = this.matrix();
    return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
  }

  screenToDoc(sx: number, sy: number): Point {
    const m = this.matrix();
    const det = m.a * m.d - m.b * m.c;
    const x = sx - m.e;
    const y = sy - m.f;
    return { x: (m.d * x - m.c * y) / det, y: (-m.b * x + m.a * y) / det };
  }

  /** True when the view is axis-aligned (rotation is a multiple of 90°). */
  get axisAligned(): boolean {
    const q = this.rotation / (Math.PI / 2);
    return Math.abs(q - Math.round(q)) < 1e-6;
  }

  zoomAt(sx: number, sy: number, newZoom: number): void {
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, newZoom));
    const k = z / this.zoom;
    this.tx = sx + k * (this.tx - sx);
    this.ty = sy + k * (this.ty - sy);
    this.zoom = z;
  }

  /** Zooms to the next/previous step from ZOOM_STEPS around a screen point. */
  stepZoom(sx: number, sy: number, direction: 1 | -1): void {
    const z = this.zoom;
    let target: number;
    if (direction > 0) target = ZOOM_STEPS.find((s) => s > z * 1.001) ?? MAX_ZOOM;
    else target = [...ZOOM_STEPS].reverse().find((s) => s < z / 1.001) ?? MIN_ZOOM;
    this.zoomAt(sx, sy, target);
  }

  panBy(dx: number, dy: number): void {
    this.tx += dx;
    this.ty += dy;
  }

  rotateAt(sx: number, sy: number, delta: number): void {
    const cos = Math.cos(delta);
    const sin = Math.sin(delta);
    const dx = this.tx - sx;
    const dy = this.ty - sy;
    this.tx = sx + cos * dx - sin * dy;
    this.ty = sy + sin * dx + cos * dy;
    this.rotation = normalizeAngle(this.rotation + delta);
  }

  setRotation(angle: number): void {
    this.rotateAt(this.width / 2, this.height / 2, normalizeAngle(angle) - this.rotation);
  }

  toggleFlip(): void {
    const cx = this.width / 2;
    this.tx = 2 * cx - this.tx;
    this.rotation = normalizeAngle(-this.rotation);
    this.flipX = !this.flipX;
  }

  /** Centers the document without changing zoom or rotation. */
  center(docW: number, docH: number): void {
    const p = this.docToScreen(docW / 2, docH / 2);
    this.tx += this.width / 2 - p.x;
    this.ty += this.height / 2 - p.y;
  }

  /** Zoom to fit the document (keeping rotation). Uses whole-number zoom ≥ 1 for crisp pixels. */
  fit(docW: number, docH: number, margin = 24): void {
    const cos = Math.abs(Math.cos(this.rotation));
    const sin = Math.abs(Math.sin(this.rotation));
    const bw = docW * cos + docH * sin;
    const bh = docW * sin + docH * cos;
    const availW = Math.max(16, this.width - margin * 2);
    const availH = Math.max(16, this.height - margin * 2);
    let z = Math.min(availW / bw, availH / bh);
    if (z >= 1) z = Math.floor(z);
    this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
    this.center(docW, docH);
  }

  /** 100%: one document pixel per CSS pixel, centered on the screen center. */
  actualPixels(docW: number, docH: number): void {
    this.zoomAt(this.width / 2, this.height / 2, 1);
    this.center(docW, docH);
  }

  /** Bounding box of the visible area in document coordinates. */
  visibleDocRect(): { x0: number; y0: number; x1: number; y1: number } {
    const pts = [this.screenToDoc(0, 0), this.screenToDoc(this.width, 0), this.screenToDoc(0, this.height), this.screenToDoc(this.width, this.height)];
    return {
      x0: Math.min(...pts.map((p) => p.x)),
      y0: Math.min(...pts.map((p) => p.y)),
      x1: Math.max(...pts.map((p) => p.x)),
      y1: Math.max(...pts.map((p) => p.y)),
    };
  }
}

export function normalizeAngle(a: number): number {
  const t = Math.PI * 2;
  let r = a % t;
  if (r > Math.PI) r -= t;
  if (r <= -Math.PI) r += t;
  return r;
}

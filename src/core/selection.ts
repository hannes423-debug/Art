import { type Rect, clipRect, unionRect } from './geometry';
import { type MorphShape, featherMask, growMask, shrinkMask, subtractMask } from './morphology';

export type SelectionMode = 'replace' | 'add' | 'subtract' | 'intersect';

/** Ways to change the shape of an existing selection. */
export type SelectionModify =
  | { kind: 'grow'; radius: number; shape: MorphShape }
  | { kind: 'shrink'; radius: number; shape: MorphShape; fromCanvasEdge: boolean }
  /** A ring of `radius` pixels just outside (or just inside) the selection edge. */
  | { kind: 'border'; radius: number; shape: MorphShape; side: 'outside' | 'inside' }
  /** Softens the edge over about `radius` pixels on each side. */
  | { kind: 'feather'; radius: number };

/** Serializable snapshot of a selection (mask cropped to its bounds). */
export interface SelectionState {
  bounds: Rect;
  data: Uint8Array;
}

/**
 * A selection is a per-pixel coverage mask (0..255). Every selection shape
 * (rectangle, ellipse, lasso, magic wand) produces a mask, so new selection
 * types only need a mask generator. `mask === null` means nothing is
 * selected, in which case the whole canvas is editable.
 */
export class Selection {
  width: number;
  height: number;
  mask: Uint8Array | null = null;
  bounds: Rect | null = null;
  /** Incremented on change; renderers cache outlines by version. */
  version = 0;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  get active(): boolean {
    return this.mask !== null;
  }

  clear(): void {
    if (!this.mask) return;
    this.mask = null;
    this.bounds = null;
    this.version++;
  }

  selectAll(): void {
    const m = new Uint8Array(this.width * this.height);
    m.fill(255);
    this.mask = m;
    this.bounds = { x: 0, y: 0, w: this.width, h: this.height };
    this.version++;
  }

  invert(): void {
    if (!this.mask) {
      this.selectAll();
      return;
    }
    const m = this.mask;
    for (let i = 0; i < m.length; i++) m[i] = 255 - m[i];
    this.bounds = computeMaskBounds(m, this.width, this.height, null);
    if (!this.bounds) this.mask = null;
    this.version++;
  }

  /** Grows, shrinks or borders the selection. Returns false when nothing is selected. */
  modify(m: SelectionModify): boolean {
    const mask = this.mask;
    const b = this.bounds;
    if (!mask || !b) return false;
    const r = Math.max(0, Math.round(m.radius));
    if (r === 0) return true;
    const { width: w, height: h } = this;
    let next: Uint8Array;
    let hint: Rect;
    if (m.kind === 'feather') {
      next = featherMask(mask, w, h, b, r);
      hint = { x: b.x - r, y: b.y - r, w: b.w + 2 * r, h: b.h + 2 * r };
    } else if (m.kind === 'grow') {
      next = growMask(mask, w, h, b, r, m.shape);
      hint = { x: b.x - r, y: b.y - r, w: b.w + 2 * r, h: b.h + 2 * r };
    } else if (m.kind === 'shrink') {
      next = shrinkMask(mask, w, h, b, r, m.shape, m.fromCanvasEdge);
      hint = b;
    } else if (m.side === 'outside') {
      next = subtractMask(growMask(mask, w, h, b, r, m.shape), mask);
      hint = { x: b.x - r, y: b.y - r, w: b.w + 2 * r, h: b.h + 2 * r };
    } else {
      next = subtractMask(mask, shrinkMask(mask, w, h, b, r, m.shape, true));
      hint = b;
    }
    this.mask = next;
    this.bounds = computeMaskBounds(next, w, h, hint);
    if (!this.bounds) this.mask = null;
    this.version++;
    return true;
  }

  /** Coverage 0..255 at a pixel; 255 everywhere when no selection is active. */
  valueAt(x: number, y: number): number {
    if (!this.mask) return 255;
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return 0;
    return this.mask[y * this.width + x];
  }

  /**
   * Combine a new full-size mask with the current selection.
   * `hint` is a bounding box of the non-zero area of `newMask` (speeds up bounds computation).
   */
  combine(newMask: Uint8Array, hint: Rect | null, mode: SelectionMode): void {
    const old = this.mask;
    if (!old && (mode === 'subtract' || mode === 'intersect')) {
      // Subtracting from / intersecting with an empty selection leaves it empty.
      return;
    }
    if (!old || mode === 'replace') {
      this.mask = newMask;
      this.bounds = computeMaskBounds(newMask, this.width, this.height, hint);
    } else {
      const n = old.length;
      if (mode === 'add') {
        for (let i = 0; i < n; i++) if (newMask[i] > old[i]) old[i] = newMask[i];
        this.bounds = computeMaskBounds(old, this.width, this.height, hint ? unionRect(this.bounds, hint) : null);
      } else if (mode === 'subtract') {
        for (let i = 0; i < n; i++) {
          const v = newMask[i];
          if (v) old[i] = (old[i] * (255 - v) + 127) / 255;
        }
        this.bounds = computeMaskBounds(old, this.width, this.height, this.bounds);
      } else {
        for (let i = 0; i < n; i++) if (newMask[i] < old[i]) old[i] = newMask[i];
        this.bounds = computeMaskBounds(old, this.width, this.height, this.bounds);
      }
    }
    if (!this.bounds) this.mask = null;
    this.version++;
  }

  getState(): SelectionState | null {
    if (!this.mask || !this.bounds) return null;
    const b = this.bounds;
    const data = new Uint8Array(b.w * b.h);
    for (let y = 0; y < b.h; y++) {
      const src = (b.y + y) * this.width + b.x;
      data.set(this.mask.subarray(src, src + b.w), y * b.w);
    }
    return { bounds: { ...b }, data };
  }

  /** Restore a snapshot. The snapshot may lie partly outside the canvas (it is clipped). */
  setState(state: SelectionState | null): void {
    if (!state) {
      this.mask = null;
      this.bounds = null;
      this.version++;
      return;
    }
    const m = new Uint8Array(this.width * this.height);
    const b = state.bounds;
    const clip = clipRect(b, this.width, this.height);
    if (clip) {
      for (let y = clip.y; y < clip.y + clip.h; y++) {
        const src = (y - b.y) * b.w + (clip.x - b.x);
        m.set(state.data.subarray(src, src + clip.w), y * this.width + clip.x);
      }
    }
    this.mask = m;
    this.bounds = computeMaskBounds(m, this.width, this.height, clip);
    if (!this.bounds) this.mask = null;
    this.version++;
  }

  /** Resize the selection canvas, shifting content by (dx, dy). */
  resize(width: number, height: number, dx = 0, dy = 0): void {
    const state = this.getState();
    this.width = width;
    this.height = height;
    if (state) {
      state.bounds.x += dx;
      state.bounds.y += dy;
    }
    this.mask = null;
    this.bounds = null;
    this.setState(state);
  }
}

/** Bounding box of non-zero mask values. `hint` limits the scan when known. */
export function computeMaskBounds(mask: Uint8Array, width: number, height: number, hint: Rect | null): Rect | null {
  const area = hint ? clipRect(hint, width, height) : { x: 0, y: 0, w: width, h: height };
  if (!area) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  for (let y = area.y; y < area.y + area.h; y++) {
    const row = y * width;
    for (let x = area.x; x < area.x + area.w; x++) {
      if (mask[row + x] !== 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

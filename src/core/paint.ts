import type { RGBA } from './color';
import type { ArtDocument } from './document';
import { type Rect, clipRect, unionRect } from './geometry';
import type { Selection } from './selection';
import type { Surface } from './surface';
import { type PixelPatch, TileRecorder } from './tiles';

export type PaintMode = 'paint' | 'erase';

export interface PaintParams {
  color: RGBA;
  /** Overall opacity of the edit, 0..1. */
  opacity: number;
  mode: PaintMode;
  /** Keep existing alpha; only recolor (paint) / do nothing (erase). */
  alphaLock: boolean;
}

let scratch: Uint8Array | null = null;
let scratchInUse = false;

/**
 * Coverage masks are document-sized, so one is reused between edits (and
 * cleared after each). If a session is somehow still open, a private mask
 * is used instead so painting can never get stuck.
 */
function acquireMask(size: number): { mask: Uint8Array; shared: boolean } {
  if (scratchInUse) return { mask: new Uint8Array(size), shared: false };
  if (!scratch || scratch.length !== size) scratch = new Uint8Array(size);
  scratchInUse = true;
  return { mask: scratch, shared: true };
}

/**
 * One editing operation on a surface (a stroke, a shape, a fill).
 *
 * Tools write coverage (0..255) into a document-sized mask with max()
 * blending, then call {@link apply}. Pixels are always recomputed from the
 * original tile data captured by the TileRecorder, which gives:
 *  - uniform opacity within a stroke (overlapping dabs never darken),
 *  - cheap live previews for shapes (reset the mask and rasterize again),
 *  - selection clipping and alpha lock in a single place,
 *  - a compact undo record of only the tiles that changed.
 */
export class PaintSession {
  readonly doc: ArtDocument;
  readonly surface: Surface;
  readonly width: number;
  readonly height: number;
  readonly mask: Uint8Array;
  params: PaintParams;
  private readonly recorder: TileRecorder;
  private readonly selMask: Uint8Array | null;
  private dirty: Rect | null = null;
  private touched: Rect | null = null;
  private closed = false;

  constructor(doc: ArtDocument, surface: Surface, params: PaintParams, selection: Selection | null = doc.selection) {
    this.doc = doc;
    this.surface = surface;
    this.width = surface.width;
    this.height = surface.height;
    this.params = params;
    this.recorder = new TileRecorder(surface);
    this.selMask = selection?.mask ?? null;
    const m = acquireMask(this.width * this.height);
    this.mask = m.mask;
    this.sharedMask = m.shared;
  }

  private readonly sharedMask: boolean;

  /** Marks mask changes inside r for the next apply(). */
  markDirty(r: Rect): void {
    const c = clipRect(r, this.width, this.height);
    if (!c) return;
    this.dirty = unionRect(this.dirty, c);
    this.touched = unionRect(this.touched, c);
  }

  /** Anti-aliased round dab. `hardness` 0..1, `alpha` 0..1. */
  dabSoft(cx: number, cy: number, radius: number, hardness: number, alpha: number): void {
    const r = Math.max(0.5, radius);
    const x0 = Math.max(0, Math.floor(cx - r - 1));
    const y0 = Math.max(0, Math.floor(cy - r - 1));
    const x1 = Math.min(this.width - 1, Math.ceil(cx + r + 1));
    const y1 = Math.min(this.height - 1, Math.ceil(cy + r + 1));
    if (x1 < x0 || y1 < y0 || alpha <= 0) return;
    const mask = this.mask;
    const w = this.width;
    const a255 = Math.min(1, alpha) * 255;
    const hard = hardness >= 0.999;
    const inner = Math.max(0, Math.min(0.999, hardness));
    const outer = r + 0.5;
    const outer2 = outer * outer;
    for (let y = y0; y <= y1; y++) {
      const dy = y + 0.5 - cy;
      const dy2 = dy * dy;
      let p = y * w + x0;
      for (let x = x0; x <= x1; x++, p++) {
        const dx = x + 0.5 - cx;
        const d2 = dx * dx + dy2;
        if (d2 >= outer2) continue;
        const d = Math.sqrt(d2);
        let cov = outer - d; // 1px anti-aliased edge
        if (cov > 1) cov = 1;
        if (!hard) {
          const t = d / r;
          if (t > inner) {
            if (t >= 1) cov = 0;
            else {
              const u = (t - inner) / (1 - inner);
              cov *= 1 - u * u * (3 - 2 * u);
            }
          }
        }
        const v = cov * a255;
        if (v > mask[p]) mask[p] = v;
      }
    }
    this.markDirty({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });
  }

  /** Hard-edged pixel dab of `size` pixels centered on pixel (px, py). */
  dabPixel(px: number, py: number, size: number, round: boolean, alpha = 1): void {
    const n = Math.max(1, Math.round(size));
    const off = Math.floor((n - 1) / 2);
    const x0 = px - off;
    const y0 = py - off;
    const v = Math.round(Math.min(1, alpha) * 255);
    const mask = this.mask;
    const w = this.width;
    const rr = n >= 3 ? (n / 2 - 0.25) ** 2 : Infinity;
    const c = n / 2;
    for (let j = 0; j < n; j++) {
      const y = y0 + j;
      if (y < 0 || y >= this.height) continue;
      for (let i = 0; i < n; i++) {
        const x = x0 + i;
        if (x < 0 || x >= w) continue;
        if (round && (i + 0.5 - c) ** 2 + (j + 0.5 - c) ** 2 > rr) continue;
        const p = y * w + x;
        if (v > mask[p]) mask[p] = v;
      }
    }
    this.markDirty({ x: x0, y: y0, w: n, h: n });
  }

  /** Sets coverage for a horizontal run of pixels. */
  span(y: number, xa: number, xb: number, alpha = 1): void {
    if (y < 0 || y >= this.height) return;
    const a = Math.max(0, xa);
    const b = Math.min(this.width - 1, xb);
    if (b < a) return;
    const v = Math.round(Math.min(1, alpha) * 255);
    const row = y * this.width;
    for (let x = a; x <= b; x++) if (v > this.mask[row + x]) this.mask[row + x] = v;
    this.markDirty({ x: a, y, w: b - a + 1, h: 1 });
  }

  /** Sets one pixel's coverage directly (used e.g. to undo a pixel-perfect corner). */
  setCoverage(x: number, y: number, value: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.mask[y * this.width + x] = value;
    this.markDirty({ x, y, w: 1, h: 1 });
  }

  /** Max-combines a coverage array covering `rect` (rect.w × rect.h, 0..255). */
  addCoverage(cov: Uint8Array | Uint8ClampedArray, rect: Rect, stride = rect.w, alphaChannel = false): void {
    const clip = clipRect(rect, this.width, this.height);
    if (!clip) return;
    const step = alphaChannel ? 4 : 1;
    for (let y = clip.y; y < clip.y + clip.h; y++) {
      let s = ((y - rect.y) * stride + (clip.x - rect.x)) * step + (alphaChannel ? 3 : 0);
      let p = y * this.width + clip.x;
      for (let x = 0; x < clip.w; x++, p++, s += step) {
        const v = cov[s];
        if (v > this.mask[p]) this.mask[p] = v;
      }
    }
    this.markDirty(clip);
  }

  /** Clears all coverage and restores original pixels (used for live shape previews). */
  resetCoverage(): void {
    if (!this.touched) return;
    const t = this.touched;
    for (let y = t.y; y < t.y + t.h; y++) this.mask.fill(0, y * this.width + t.x, y * this.width + t.x + t.w);
    this.dirty = unionRect(this.dirty, t);
    this.touched = null;
  }

  /** Recomputes surface pixels for everything changed since the last apply. */
  apply(): void {
    const r = this.dirty;
    if (!r) return;
    this.dirty = null;
    this.recorder.record(r);
    const data = this.surface.ensureData();
    const { color, opacity, mode, alphaLock } = this.params;
    const mask = this.mask;
    const sel = this.selMask;
    const w = this.width;
    const cr = color.r;
    const cg = color.g;
    const cb = color.b;
    const ca = color.a / 255;
    const k = opacity / (255 * 255);
    this.recorder.forEachTileIn(r, (tile, area) => {
      const td = tile.data;
      for (let y = area.y; y < area.y + area.h; y++) {
        let p = y * w + area.x;
        let o = p * 4;
        let t = ((y - tile.y) * tile.w + (area.x - tile.x)) * 4;
        for (let x = 0; x < area.w; x++, p++, o += 4, t += 4) {
          const m = mask[p];
          const eff = m === 0 ? 0 : m * (sel ? sel[p] : 255) * k;
          const or = td[t];
          const og = td[t + 1];
          const ob = td[t + 2];
          const oa8 = td[t + 3];
          if (eff <= 0) {
            data[o] = or;
            data[o + 1] = og;
            data[o + 2] = ob;
            data[o + 3] = oa8;
            continue;
          }
          if (mode === 'erase') {
            if (alphaLock) {
              data[o] = or;
              data[o + 1] = og;
              data[o + 2] = ob;
              data[o + 3] = oa8;
              continue;
            }
            const na = oa8 * (1 - eff);
            if (na < 0.5) {
              data[o] = data[o + 1] = data[o + 2] = data[o + 3] = 0;
            } else {
              data[o] = or;
              data[o + 1] = og;
              data[o + 2] = ob;
              data[o + 3] = na;
            }
            continue;
          }
          const sa = ca * eff;
          if (sa * 255 < 0.5) {
            data[o] = or;
            data[o + 1] = og;
            data[o + 2] = ob;
            data[o + 3] = oa8;
            continue;
          }
          if (alphaLock) {
            if (oa8 === 0) {
              // Locked alpha: fully transparent pixels stay exactly as they are.
              data[o] = or;
              data[o + 1] = og;
              data[o + 2] = ob;
              data[o + 3] = 0;
              continue;
            }
            data[o] = or + (cr - or) * sa;
            data[o + 1] = og + (cg - og) * sa;
            data[o + 2] = ob + (cb - ob) * sa;
            data[o + 3] = oa8;
            continue;
          }
          if (oa8 === 0) {
            data[o] = cr;
            data[o + 1] = cg;
            data[o + 2] = cb;
            data[o + 3] = sa * 255;
            continue;
          }
          const da = oa8 / 255;
          const kk = da * (1 - sa);
          const oa = sa + kk;
          data[o] = (cr * sa + or * kk) / oa;
          data[o + 1] = (cg * sa + og * kk) / oa;
          data[o + 2] = (cb * sa + ob * kk) / oa;
          data[o + 3] = oa * 255;
        }
      }
    });
    this.surface.touch(r);
    this.doc.notifyPixels(this.surface, r);
  }

  /** Bounding box of all coverage written so far. */
  get bounds(): Rect | null {
    return this.touched;
  }

  private release(): void {
    if (this.closed) return;
    this.closed = true;
    const t = this.recorder.bounds();
    const area = unionRect(t, this.touched);
    if (!this.sharedMask) return;
    if (area) {
      for (let y = area.y; y < area.y + area.h; y++) this.mask.fill(0, y * this.width + area.x, y * this.width + area.x + area.w);
    }
    scratchInUse = false;
  }

  /** Finishes the edit and returns its undo record (null if nothing changed). */
  commit(label: string): PixelPatch | null {
    this.apply();
    const patch = this.recorder.finish(label, (s, r) => this.doc.notifyPixels(s, r));
    this.release();
    return patch;
  }

  /** Abandons the edit, restoring the original pixels. */
  cancel(): void {
    const area = this.recorder.bounds();
    if (area) {
      this.recorder.restore(area);
      this.surface.touch(area);
      this.doc.notifyPixels(this.surface, area);
    }
    this.recorder.finish('', () => {});
    this.release();
  }
}

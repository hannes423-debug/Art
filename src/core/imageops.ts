import type { Rect } from './geometry';
import { type Pixels, allocPixels } from './surface';

/** Pure functions transforming RGBA buffers. Inputs are never modified. */

/** 32-bit-per-pixel view of an RGBA buffer (copies if the buffer is not 4-byte aligned). */
function u32(src: Uint8ClampedArray, pixels: number): Uint32Array {
  if (src.byteOffset % 4 === 0) return new Uint32Array(src.buffer, src.byteOffset, pixels);
  return new Uint32Array(src.slice(0, pixels * 4).buffer);
}

/** Copies `rect` out of the source; areas outside the source become transparent. */
export function cropPixels(src: Uint8ClampedArray, sw: number, sh: number, rect: Rect): Pixels {
  const out = allocPixels(rect.w, rect.h);
  const x0 = Math.max(0, rect.x);
  const y0 = Math.max(0, rect.y);
  const x1 = Math.min(sw, rect.x + rect.w);
  const y1 = Math.min(sh, rect.y + rect.h);
  if (x1 <= x0 || y1 <= y0) return out;
  const rowBytes = (x1 - x0) * 4;
  for (let y = y0; y < y1; y++) {
    const s = (y * sw + x0) * 4;
    out.set(src.subarray(s, s + rowBytes), ((y - rect.y) * rect.w + (x0 - rect.x)) * 4);
  }
  return out;
}

export function flipHorizontal(src: Uint8ClampedArray, w: number, h: number): Pixels {
  const out = allocPixels(w, h);
  const s32 = u32(src, w * h);
  const o32 = new Uint32Array(out.buffer);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) o32[row + x] = s32[row + w - 1 - x];
  }
  return out;
}

export function flipVertical(src: Uint8ClampedArray, w: number, h: number): Pixels {
  const out = allocPixels(w, h);
  const rowBytes = w * 4;
  for (let y = 0; y < h; y++) {
    const s = (h - 1 - y) * rowBytes;
    out.set(src.subarray(s, s + rowBytes), y * rowBytes);
  }
  return out;
}

/** Rotates 90° clockwise (cw=true) or counter-clockwise. Result is h×w. */
export function rotate90(src: Uint8ClampedArray, w: number, h: number, cw: boolean): Pixels {
  const out = allocPixels(h, w);
  const s32 = u32(src, w * h);
  const o32 = new Uint32Array(out.buffer);
  // Output dims: width = h, height = w.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = s32[y * w + x];
      if (cw) o32[x * h + (h - 1 - y)] = v;
      else o32[(w - 1 - x) * h + y] = v;
    }
  }
  return out;
}

export function rotate180(src: Uint8ClampedArray, w: number, h: number): Pixels {
  const out = allocPixels(w, h);
  const s32 = u32(src, w * h);
  const o32 = new Uint32Array(out.buffer);
  const n = w * h;
  for (let i = 0; i < n; i++) o32[i] = s32[n - 1 - i];
  return out;
}

export type ResampleMode = 'nearest' | 'smooth';

/** Scales an image. 'nearest' keeps hard pixel edges (pixel art); 'smooth' filters. */
export function resizePixels(src: Uint8ClampedArray, sw: number, sh: number, dw: number, dh: number, mode: ResampleMode): Pixels {
  if (dw === sw && dh === sh) return allocCopy(src);
  return mode === 'nearest' ? resizeNearest(src, sw, sh, dw, dh) : resizeSmooth(src, sw, sh, dw, dh);
}

function allocCopy(src: Uint8ClampedArray): Pixels {
  const out = new Uint8ClampedArray(src.length);
  out.set(src);
  return out;
}

function resizeNearest(src: Uint8ClampedArray, sw: number, sh: number, dw: number, dh: number): Pixels {
  const out = allocPixels(dw, dh);
  const s32 = u32(src, sw * sh);
  const o32 = new Uint32Array(out.buffer);
  const xmap = new Int32Array(dw);
  for (let x = 0; x < dw; x++) xmap[x] = Math.min(sw - 1, Math.floor(((x + 0.5) * sw) / dw));
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.floor(((y + 0.5) * sh) / dh));
    const srow = sy * sw;
    const orow = y * dw;
    for (let x = 0; x < dw; x++) o32[orow + x] = s32[srow + xmap[x]];
  }
  return out;
}

/**
 * Smooth resampling in premultiplied space (avoids dark fringes around
 * transparent edges): box filter per axis when shrinking, bilinear when growing.
 */
function resizeSmooth(src: Uint8ClampedArray, sw: number, sh: number, dw: number, dh: number): Pixels {
  // Premultiply into float buffer.
  const pre = new Float32Array(sw * sh * 4);
  for (let i = 0; i < pre.length; i += 4) {
    const a = src[i + 3] / 255;
    pre[i] = src[i] * a;
    pre[i + 1] = src[i + 1] * a;
    pre[i + 2] = src[i + 2] * a;
    pre[i + 3] = src[i + 3];
  }
  const horiz = resampleAxis(pre, sw, sh, dw, true);
  const both = resampleAxis(horiz, dw, sh, dh, false);
  const out = allocPixels(dw, dh);
  for (let i = 0; i < out.length; i += 4) {
    const a = both[i + 3];
    if (a <= 0.5) continue;
    const k = 255 / a;
    out[i] = both[i] * k;
    out[i + 1] = both[i + 1] * k;
    out[i + 2] = both[i + 2] * k;
    out[i + 3] = a;
  }
  return out;
}

/** Resamples one axis. horizontal: (w×h) → (n×h); vertical: (w×h) → (w×n). */
function resampleAxis(src: Float32Array, w: number, h: number, n: number, horizontal: boolean): Float32Array {
  const len = horizontal ? w : h;
  const lines = horizontal ? h : w;
  const out = new Float32Array((horizontal ? n * h : w * n) * 4);
  const scale = len / n;
  const idx = (line: number, pos: number) => (horizontal ? (line * w + pos) * 4 : (pos * w + line) * 4);
  const oidx = (line: number, pos: number) => (horizontal ? (line * n + pos) * 4 : (pos * w + line) * 4);
  for (let line = 0; line < lines; line++) {
    for (let p = 0; p < n; p++) {
      const o = oidx(line, p);
      if (scale > 1) {
        // Box filter over the source span [p*scale, (p+1)*scale).
        const start = p * scale;
        const end = start + scale;
        let acc0 = 0;
        let acc1 = 0;
        let acc2 = 0;
        let acc3 = 0;
        let wsum = 0;
        for (let s = Math.floor(start); s < Math.ceil(end) && s < len; s++) {
          const wgt = Math.min(end, s + 1) - Math.max(start, s);
          if (wgt <= 0) continue;
          const i = idx(line, s);
          acc0 += src[i] * wgt;
          acc1 += src[i + 1] * wgt;
          acc2 += src[i + 2] * wgt;
          acc3 += src[i + 3] * wgt;
          wsum += wgt;
        }
        out[o] = acc0 / wsum;
        out[o + 1] = acc1 / wsum;
        out[o + 2] = acc2 / wsum;
        out[o + 3] = acc3 / wsum;
      } else {
        const pos = Math.max(0, Math.min(len - 1, (p + 0.5) * scale - 0.5));
        const s0 = Math.floor(pos);
        const s1 = Math.min(len - 1, s0 + 1);
        const t = pos - s0;
        const i0 = idx(line, s0);
        const i1 = idx(line, s1);
        out[o] = src[i0] * (1 - t) + src[i1] * t;
        out[o + 1] = src[i0 + 1] * (1 - t) + src[i1 + 1] * t;
        out[o + 2] = src[i0 + 2] * (1 - t) + src[i1 + 2] * t;
        out[o + 3] = src[i0 + 3] * (1 - t) + src[i1 + 3] * t;
      }
    }
  }
  return out;
}

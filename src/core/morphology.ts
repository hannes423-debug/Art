import { type Rect, clipRect } from './geometry';

export type MorphShape = 'round' | 'square';

const INF = 1e20;

/**
 * Squared Euclidean distance from every pixel of `region` to the nearest
 * "feature" pixel (Felzenszwalb & Huttenlocher), in O(region area) for any
 * radius. `isFeature(x, y)` is queried for every pixel of the region.
 */
function distanceTransform(region: Rect, isFeature: (x: number, y: number) => boolean): Float64Array {
  const { w, h } = region;
  const d = new Float64Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d[y * w + x] = isFeature(region.x + x, region.y + y) ? 0 : INF;
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const out = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const pass1d = (len: number) => {
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < len; q++) {
      let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q++) {
      while (z[k + 1] < q) k++;
      const dq = q - v[k];
      out[q] = dq * dq + f[v[k]];
    }
  };
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = d[y * w + x];
    pass1d(h);
    for (let y = 0; y < h; y++) d[y * w + x] = out[y];
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) f[x] = d[row + x];
    pass1d(w);
    for (let x = 0; x < w; x++) d[row + x] = out[x];
  }
  return d;
}

/** Sliding max/min of half-width r over `len` values read through `get`, written through `set`. */
function slide1d(
  len: number,
  r: number,
  isMax: boolean,
  get: (i: number) => number,
  set: (i: number, v: number) => void,
  buf: Int32Array,
  vals: Uint8Array,
): void {
  // vals[k] = value at index k - r (padding reads come from `get` too).
  const n = len + 2 * r;
  for (let k = 0; k < n; k++) vals[k] = get(k - r);
  let head = 0;
  let tail = 0;
  const win = 2 * r + 1;
  for (let k = 0; k < n; k++) {
    const val = vals[k];
    if (isMax) while (tail > head && vals[buf[tail - 1]] <= val) tail--;
    else while (tail > head && vals[buf[tail - 1]] >= val) tail--;
    buf[tail++] = k;
    if (buf[head] <= k - win) head++;
    if (k >= win - 1) set(k - win + 1, vals[buf[head]]);
  }
}

/** Separable square (Chebyshev) dilation/erosion inside `region`; outside the canvas reads as `outside`. */
function squareMorph(src: Uint8Array, width: number, height: number, region: Rect, r: number, isMax: boolean, outside: number): Uint8Array {
  const out = new Uint8Array(width * height);
  const { x: rx, y: ry, w, h } = region;
  const tmp = new Uint8Array(w * (h + 2 * r));
  const n = Math.max(w, h) + 2 * r;
  const buf = new Int32Array(n);
  const vals = new Uint8Array(n);
  // Horizontal pass over the rows the vertical pass will read (region ± r).
  for (let ty = 0; ty < h + 2 * r; ty++) {
    const sy = ry - r + ty;
    if (sy < 0 || sy >= height) {
      tmp.fill(outside, ty * w, ty * w + w);
      continue;
    }
    const row = sy * width;
    slide1d(
      w,
      r,
      isMax,
      (i) => {
        const sx = rx + i;
        return sx < 0 || sx >= width ? outside : src[row + sx];
      },
      (i, v) => (tmp[ty * w + i] = v),
      buf,
      vals,
    );
  }
  for (let x = 0; x < w; x++) {
    slide1d(
      h,
      r,
      isMax,
      (i) => tmp[(i + r) * w + x],
      (i, v) => (out[(ry + i) * width + rx + x] = v),
      buf,
      vals,
    );
  }
  return out;
}

function expand(b: Rect, r: number): Rect {
  return { x: b.x - r, y: b.y - r, w: b.w + 2 * r, h: b.h + 2 * r };
}

/**
 * Expands the selection by `r` pixels: every pixel within distance `r` of a
 * selected pixel becomes selected (round = Euclidean, square = Chebyshev).
 */
export function growMask(mask: Uint8Array, width: number, height: number, bounds: Rect, r: number, shape: MorphShape): Uint8Array {
  const region = clipRect(expand(bounds, r), width, height);
  if (!region) return new Uint8Array(width * height);
  if (shape === 'square') return squareMorph(mask, width, height, region, r, true, 0);
  const out = mask.slice();
  const dist = distanceTransform(region, (x, y) => mask[y * width + x] >= 128);
  const r2 = r * r;
  for (let y = 0; y < region.h; y++) {
    for (let x = 0; x < region.w; x++) if (dist[y * region.w + x] <= r2) out[(region.y + y) * width + region.x + x] = 255;
  }
  return out;
}

/**
 * Contracts the selection by `r` pixels: a pixel stays selected only when
 * everything within distance `r` is selected. With `fromCanvasEdge`, the
 * area outside the canvas counts as unselected, so a selection touching the
 * edge shrinks away from it too.
 */
export function shrinkMask(mask: Uint8Array, width: number, height: number, bounds: Rect, r: number, shape: MorphShape, fromCanvasEdge: boolean): Uint8Array {
  if (shape === 'square') {
    const region = clipRect(bounds, width, height);
    if (!region) return new Uint8Array(width * height);
    return squareMorph(mask, width, height, region, r, false, fromCanvasEdge ? 0 : 255);
  }
  // A ring one pixel around the bounds holds the nearest unselected pixel for
  // everything inside, so the transform never needs to look further.
  const region = expand(bounds, 1);
  const out = new Uint8Array(width * height);
  const dist = distanceTransform(region, (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return fromCanvasEdge;
    return mask[y * width + x] < 128;
  });
  const r2 = r * r;
  for (let y = 1; y < region.h - 1; y++) {
    for (let x = 1; x < region.w - 1; x++) {
      if (dist[y * region.w + x] > r2) {
        const i = (region.y + y) * width + region.x + x;
        out[i] = mask[i];
      }
    }
  }
  return out;
}

/** `a` minus `b` (same soft subtraction as the selection tools). */
export function subtractMask(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) {
    const v = b[i];
    out[i] = v ? (a[i] * (255 - v) + 127) / 255 : a[i];
  }
  return out;
}

/**
 * Softens the selection edge: three box blurs approximate a Gaussian whose
 * transition spans about `r` pixels on each side of the original edge.
 */
export function featherMask(mask: Uint8Array, width: number, height: number, bounds: Rect, r: number): Uint8Array {
  const b = Math.max(1, Math.round(r / 3));
  const region = clipRect({ x: bounds.x - 3 * b, y: bounds.y - 3 * b, w: bounds.w + 6 * b, h: bounds.h + 6 * b }, width, height);
  if (!region) return mask.slice();
  const { x: rx, y: ry, w, h } = region;
  let cur = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) cur[y * w + x] = mask[(ry + y) * width + rx + x];
  let tmp = new Float32Array(w * h);
  // Where the region ends at the canvas edge, the edge pixels extend outward
  // (a selection reaching the edge stays solid there); elsewhere it is unselected.
  const clampLo = [rx === 0, ry === 0];
  const clampHi = [rx + w === width, ry + h === height];
  const pass = (src: Float32Array, dst: Float32Array, horizontal: boolean) => {
    const n = horizontal ? w : h;
    const lines = horizontal ? h : w;
    const axis = horizontal ? 0 : 1;
    const win = 2 * b + 1;
    for (let l = 0; l < lines; l++) {
      const get = (i: number) => (horizontal ? src[l * w + i] : src[i * w + l]);
      const at = (i: number) => (i < 0 ? (clampLo[axis] ? get(0) : 0) : i >= n ? (clampHi[axis] ? get(n - 1) : 0) : get(i));
      let sum = 0;
      for (let i = -b; i <= b; i++) sum += at(i);
      for (let i = 0; i < n; i++) {
        if (horizontal) dst[l * w + i] = sum / win;
        else dst[i * w + l] = sum / win;
        sum += at(i + b + 1) - at(i - b);
      }
    }
  };
  for (let k = 0; k < 3; k++) {
    pass(cur, tmp, true);
    pass(tmp, cur, false);
  }
  const out = mask.slice();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[(ry + y) * width + rx + x] = Math.round(cur[y * w + x]);
  return out;
}

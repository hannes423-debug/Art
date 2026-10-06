import type { Point, Rect } from './geometry';

/** Calls `plot` for every pixel on the Bresenham line from (x0,y0) to (x1,y1), inclusive. */
export function bresenham(x0: number, y0: number, x1: number, y1: number, plot: (x: number, y: number) => void): void {
  x0 |= 0;
  y0 |= 0;
  x1 |= 0;
  y1 |= 0;
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    plot(x0, y0);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
}

/**
 * Plots a 1px-thin ellipse inscribed in the pixel rectangle (x0,y0)-(x1,y1)
 * inclusive. Integer-only midpoint algorithm (after A. Zingl), producing the
 * clean ellipses pixel artists expect for both even and odd sizes.
 */
export function ellipseOutline(x0: number, y0: number, x1: number, y1: number, plot: (x: number, y: number) => void): void {
  if (x0 > x1) [x0, x1] = [x1, x0];
  if (y0 > y1) [y0, y1] = [y1, y0];
  let a = x1 - x0;
  const b = y1 - y0;
  if (a === 0 || b === 0) {
    // Degenerate: a straight line.
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) plot(x, y);
    return;
  }
  let b1 = b & 1;
  let dx = 4 * (1 - a) * b * b;
  let dy = 4 * (b1 + 1) * a * a;
  let err = dx + dy + b1 * a * a;
  y0 += (b + 1) >> 1;
  y1 = y0 - b1;
  a = 8 * a * a;
  b1 = 8 * b * b;
  do {
    plot(x1, y0);
    plot(x0, y0);
    plot(x0, y1);
    plot(x1, y1);
    const e2 = 2 * err;
    if (e2 <= dy) {
      y0++;
      y1--;
      dy += a;
      err += dy;
    }
    if (e2 >= dx || 2 * err > dy) {
      x0++;
      x1--;
      dx += b1;
      err += dx;
    }
  } while (x0 <= x1);
  while (y0 - y1 <= b) {
    // Finish the tips of very flat ellipses.
    plot(x0 - 1, y0);
    plot(x1 + 1, y0++);
    plot(x0 - 1, y1);
    plot(x1 + 1, y1--);
  }
}

/**
 * Horizontal spans of a filled ellipse inscribed in the pixel rect, derived
 * from the outline so filled and outlined ellipses match exactly.
 */
export function ellipseSpans(x0: number, y0: number, x1: number, y1: number, span: (y: number, xa: number, xb: number) => void): void {
  if (x0 > x1) [x0, x1] = [x1, x0];
  if (y0 > y1) [y0, y1] = [y1, y0];
  const h = y1 - y0 + 1;
  const minX = new Int32Array(h).fill(2147483647);
  const maxX = new Int32Array(h).fill(-2147483648);
  ellipseOutline(x0, y0, x1, y1, (x, y) => {
    const r = y - y0;
    if (r < 0 || r >= h) return;
    if (x < minX[r]) minX[r] = x;
    if (x > maxX[r]) maxX[r] = x;
  });
  for (let r = 0; r < h; r++) if (maxX[r] >= minX[r]) span(y0 + r, minX[r], maxX[r]);
}

/**
 * Rasterizes a closed polygon (even-odd rule, sampled at pixel centers) into
 * a full-size mask. Returns the bounding rect of filled pixels.
 */
export function fillPolygon(points: Point[], width: number, height: number, out: Uint8Array): Rect | null {
  if (points.length < 3) return null;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const y0 = Math.max(0, Math.floor(minY));
  const y1 = Math.min(height - 1, Math.ceil(maxY));
  let bx0 = Infinity;
  let bx1 = -Infinity;
  let by0 = Infinity;
  let by1 = -Infinity;
  const xs: number[] = [];
  for (let y = y0; y <= y1; y++) {
    const yc = y + 0.5;
    xs.length = 0;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const a = points[i];
      const b = points[j];
      if ((a.y <= yc && b.y > yc) || (b.y <= yc && a.y > yc)) {
        xs.push(a.x + ((yc - a.y) / (b.y - a.y)) * (b.x - a.x));
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.ceil(xs[k] - 0.5));
      const xb = Math.min(width - 1, Math.ceil(xs[k + 1] - 0.5) - 1);
      if (xb < xa) continue;
      out.fill(255, y * width + xa, y * width + xb + 1);
      bx0 = Math.min(bx0, xa);
      bx1 = Math.max(bx1, xb);
      by0 = Math.min(by0, y);
      by1 = Math.max(by1, y);
    }
  }
  return bx1 >= bx0 ? { x: bx0, y: by0, w: bx1 - bx0 + 1, h: by1 - by0 + 1 } : null;
}

/**
 * Flood fill into a mask. Pixels "match" the seed color when every RGBA
 * channel differs by at most `tolerance` (0..255); fully transparent pixels
 * match each other regardless of their RGB values.
 *
 * When `contiguous` is false every matching pixel in the image is selected.
 * `limit` (optional, full-size 0..255) restricts the fill, e.g. to a selection.
 * Returns the bounding rect of the filled area.
 */
export function floodFill(
  src: Uint8ClampedArray | null,
  width: number,
  height: number,
  sx: number,
  sy: number,
  tolerance: number,
  contiguous: boolean,
  out: Uint8Array,
  limit: Uint8Array | null = null,
): Rect | null {
  sx |= 0;
  sy |= 0;
  if (sx < 0 || sy < 0 || sx >= width || sy >= height) return null;
  if (limit && limit[sy * width + sx] === 0) return null;
  const pix = (i: number) => (src ? src[i] : 0);
  const si = (sy * width + sx) * 4;
  const tr = pix(si);
  const tg = pix(si + 1);
  const tb = pix(si + 2);
  const ta = pix(si + 3);
  const tol = Math.max(0, Math.min(255, tolerance));

  const matches = (p: number): boolean => {
    if (limit && limit[p] === 0) return false;
    const i = p * 4;
    const a = pix(i + 3);
    if (a === 0 && ta === 0) return true;
    if (Math.abs(a - ta) > tol) return false;
    if (a === 0 || ta === 0) return true;
    return Math.abs(pix(i) - tr) <= tol && Math.abs(pix(i + 1) - tg) <= tol && Math.abs(pix(i + 2) - tb) <= tol;
  };

  let minX = sx;
  let maxX = sx;
  let minY = sy;
  let maxY = sy;

  if (!contiguous) {
    let any = false;
    for (let p = 0, n = width * height; p < n; p++) {
      if (matches(p)) {
        out[p] = 255;
        const x = p % width;
        const y = (p - x) / width;
        if (!any) {
          minX = maxX = x;
          minY = maxY = y;
          any = true;
        } else {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    return any ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : null;
  }

  // Scanline fill. `out` doubles as the visited set (255 = filled).
  const stack: number[] = [sx, sy];
  while (stack.length) {
    const y = stack.pop()!;
    let x = stack.pop()!;
    const row = y * width;
    if (out[row + x] || !matches(row + x)) continue;
    let x0 = x;
    while (x0 > 0 && !out[row + x0 - 1] && matches(row + x0 - 1)) x0--;
    let x1 = x;
    while (x1 < width - 1 && !out[row + x1 + 1] && matches(row + x1 + 1)) x1++;
    out.fill(255, row + x0, row + x1 + 1);
    if (x0 < minX) minX = x0;
    if (x1 > maxX) maxX = x1;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    for (const ny of [y - 1, y + 1]) {
      if (ny < 0 || ny >= height) continue;
      const nrow = ny * width;
      let inRun = false;
      for (x = x0; x <= x1; x++) {
        const ok = !out[nrow + x] && matches(nrow + x);
        if (ok && !inRun) {
          stack.push(x, ny);
          inRun = true;
        } else if (!ok) {
          inRun = false;
        }
      }
    }
  }
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

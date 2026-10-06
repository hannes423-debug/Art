/** Integer-friendly axis-aligned rectangle in document pixel space. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

export function makeRect(x: number, y: number, w: number, h: number): Rect {
  return { x, y, w, h };
}

/** Rectangle covering the pixels from (x0,y0) to (x1,y1) inclusive, in any order. */
export function rectFromPixels(x0: number, y0: number, x1: number, y1: number): Rect {
  const minX = Math.min(x0, x1);
  const minY = Math.min(y0, y1);
  return { x: minX, y: minY, w: Math.abs(x1 - x0) + 1, h: Math.abs(y1 - y0) + 1 };
}

export function isEmptyRect(r: Rect | null | undefined): boolean {
  return !r || r.w <= 0 || r.h <= 0;
}

export function unionRect(a: Rect | null, b: Rect | null): Rect | null {
  if (isEmptyRect(a)) return isEmptyRect(b) ? null : { ...b! };
  if (isEmptyRect(b)) return { ...a! };
  const x = Math.min(a!.x, b!.x);
  const y = Math.min(a!.y, b!.y);
  const r = Math.max(a!.x + a!.w, b!.x + b!.w);
  const btm = Math.max(a!.y + a!.h, b!.y + b!.h);
  return { x, y, w: r - x, h: btm - y };
}

export function intersectRect(a: Rect | null, b: Rect | null): Rect | null {
  if (isEmptyRect(a) || isEmptyRect(b)) return null;
  const x = Math.max(a!.x, b!.x);
  const y = Math.max(a!.y, b!.y);
  const r = Math.min(a!.x + a!.w, b!.x + b!.w);
  const btm = Math.min(a!.y + a!.h, b!.y + b!.h);
  if (r <= x || btm <= y) return null;
  return { x, y, w: r - x, h: btm - y };
}

/** Clip a rect to the bounds [0,0,w,h]; rounds outward to whole pixels. */
export function clipRect(r: Rect | null, w: number, h: number): Rect | null {
  if (!r) return null;
  const x0 = Math.max(0, Math.floor(r.x));
  const y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(w, Math.ceil(r.x + r.w));
  const y1 = Math.min(h, Math.ceil(r.y + r.h));
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function expandRect(r: Rect, n: number): Rect {
  return { x: r.x - n, y: r.y - n, w: r.w + n * 2, h: r.h + n * 2 };
}

export function translateRect(r: Rect, dx: number, dy: number): Rect {
  return { x: r.x + dx, y: r.y + dy, w: r.w, h: r.h };
}

export function rectContains(r: Rect, x: number, y: number): boolean {
  return x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
}

export function rectsEqual(a: Rect | null, b: Rect | null): boolean {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function distance(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(bx - ax, by - ay);
}

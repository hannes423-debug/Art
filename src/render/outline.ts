import type { Selection } from '../core/selection';

/** Line segments (in document pixel coordinates) along the boundary of a selection mask. */
export type Segments = Float32Array;

/**
 * Traces the boundary between selected and unselected pixels as merged
 * horizontal and vertical runs. Returns a flat [x0,y0,x1,y1,...] array.
 */
export function selectionOutline(sel: Selection): Segments {
  const mask = sel.mask;
  const b = sel.bounds;
  if (!mask || !b) return new Float32Array(0);
  const w = sel.width;
  const h = sel.height;
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] >= 128;
  const out: number[] = [];
  // Horizontal edges: between row y-1 and y.
  for (let y = b.y; y <= b.y + b.h; y++) {
    let runStart = -1;
    for (let x = b.x; x <= b.x + b.w; x++) {
      const edge = x < b.x + b.w && inside(x, y) !== inside(x, y - 1);
      if (edge && runStart < 0) runStart = x;
      else if (!edge && runStart >= 0) {
        out.push(runStart, y, x, y);
        runStart = -1;
      }
    }
  }
  // Vertical edges: between column x-1 and x.
  for (let x = b.x; x <= b.x + b.w; x++) {
    let runStart = -1;
    for (let y = b.y; y <= b.y + b.h; y++) {
      const edge = y < b.y + b.h && inside(x, y) !== inside(x - 1, y);
      if (edge && runStart < 0) runStart = y;
      else if (!edge && runStart >= 0) {
        out.push(x, runStart, x, y);
        runStart = -1;
      }
    }
  }
  return new Float32Array(out);
}

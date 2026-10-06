import type { Command } from './history';
import { type Rect, clipRect } from './geometry';
import type { Surface } from './surface';

/** Edge length of undo tiles in pixels. */
export const TILE = 64;

export interface Tile {
  tx: number;
  ty: number;
  /** Pixel rect covered by this tile (edge tiles may be smaller than TILE). */
  x: number;
  y: number;
  w: number;
  h: number;
  data: Uint8ClampedArray;
}

function tileKey(tx: number, ty: number): number {
  return ty * 65536 + tx;
}

/**
 * Captures the original contents of every tile an edit touches, the first
 * time it is touched. The captured tiles serve two purposes:
 *  - tools re-render from the original pixels while an edit is in progress
 *    (e.g. a stroke with uniform opacity, or a live shape preview);
 *  - when the edit ends they become the undo record.
 */
export class TileRecorder {
  readonly surface: Surface;
  private readonly tiles = new Map<number, Tile>();

  constructor(surface: Surface) {
    this.surface = surface;
  }

  get size(): number {
    return this.tiles.size;
  }

  /** Ensures original pixels for all tiles intersecting `r` are captured. */
  record(r: Rect): void {
    const s = this.surface;
    const clip = clipRect(r, s.width, s.height);
    if (!clip) return;
    const data = s.ensureData();
    const tx0 = Math.floor(clip.x / TILE);
    const ty0 = Math.floor(clip.y / TILE);
    const tx1 = Math.floor((clip.x + clip.w - 1) / TILE);
    const ty1 = Math.floor((clip.y + clip.h - 1) / TILE);
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const key = tileKey(tx, ty);
        if (this.tiles.has(key)) continue;
        const x = tx * TILE;
        const y = ty * TILE;
        const w = Math.min(TILE, s.width - x);
        const h = Math.min(TILE, s.height - y);
        const t = new Uint8ClampedArray(w * h * 4);
        for (let row = 0; row < h; row++) {
          const src = ((y + row) * s.width + x) * 4;
          t.set(data.subarray(src, src + w * 4), row * w * 4);
        }
        this.tiles.set(key, { tx, ty, x, y, w, h, data: t });
      }
    }
  }

  /** The recorded tile containing pixel (x, y), if any. */
  tileAt(x: number, y: number): Tile | undefined {
    return this.tiles.get(tileKey(Math.floor(x / TILE), Math.floor(y / TILE)));
  }

  /** Visits recorded tiles intersecting `r` with the intersection rectangle. */
  forEachTileIn(r: Rect, fn: (tile: Tile, area: Rect) => void): void {
    const s = this.surface;
    const clip = clipRect(r, s.width, s.height);
    if (!clip) return;
    const tx0 = Math.floor(clip.x / TILE);
    const ty0 = Math.floor(clip.y / TILE);
    const tx1 = Math.floor((clip.x + clip.w - 1) / TILE);
    const ty1 = Math.floor((clip.y + clip.h - 1) / TILE);
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const t = this.tiles.get(tileKey(tx, ty));
        if (!t) continue;
        const x0 = Math.max(clip.x, t.x);
        const y0 = Math.max(clip.y, t.y);
        const x1 = Math.min(clip.x + clip.w, t.x + t.w);
        const y1 = Math.min(clip.y + clip.h, t.y + t.h);
        if (x1 > x0 && y1 > y0) fn(t, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
      }
    }
  }

  /** Copies original pixels back into the surface for area `r`. */
  restore(r: Rect): void {
    const s = this.surface;
    if (!s.data) return;
    const data = s.data;
    this.forEachTileIn(r, (t, a) => {
      for (let y = a.y; y < a.y + a.h; y++) {
        const src = ((y - t.y) * t.w + (a.x - t.x)) * 4;
        const dst = (y * s.width + a.x) * 4;
        data.set(t.data.subarray(src, src + a.w * 4), dst);
      }
    });
  }

  /** Bounding rect of all recorded tiles. */
  bounds(): Rect | null {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const t of this.tiles.values()) {
      x0 = Math.min(x0, t.x);
      y0 = Math.min(y0, t.y);
      x1 = Math.max(x1, t.x + t.w);
      y1 = Math.max(y1, t.y + t.h);
    }
    return x1 > x0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
  }

  /**
   * Produces an undo command from the recorded tiles, dropping tiles whose
   * pixels did not actually change. Returns null when nothing changed.
   */
  finish(label: string, onChange: (surface: Surface, rect: Rect) => void): PixelPatch | null {
    const s = this.surface;
    const changed: Tile[] = [];
    if (s.data) {
      const data = s.data;
      for (const t of this.tiles.values()) {
        let same = true;
        for (let row = 0; row < t.h && same; row++) {
          const src = ((t.y + row) * s.width + t.x) * 4;
          const off = row * t.w * 4;
          for (let i = 0; i < t.w * 4; i++) {
            if (data[src + i] !== t.data[off + i]) {
              same = false;
              break;
            }
          }
        }
        if (!same) changed.push(t);
      }
    }
    this.tiles.clear();
    return changed.length ? new PixelPatch(label, s, changed, onChange) : null;
  }
}

/**
 * Undo record for a pixel edit. Holds one copy of each changed tile and
 * swaps it with the surface on undo/redo, so the same buffer alternates
 * between "before" and "after" and memory is never doubled.
 */
export class PixelPatch implements Command {
  readonly label: string;
  readonly surface: Surface;
  readonly tiles: Tile[];
  private readonly onChange: (surface: Surface, rect: Rect) => void;

  constructor(label: string, surface: Surface, tiles: Tile[], onChange: (surface: Surface, rect: Rect) => void) {
    this.label = label;
    this.surface = surface;
    this.tiles = tiles;
    this.onChange = onChange;
  }

  get bytes(): number {
    let n = 128;
    for (const t of this.tiles) n += t.data.length + 64;
    return n;
  }

  undo(): void {
    this.swap();
  }

  redo(): void {
    this.swap();
  }

  /** Union of the tile rects. */
  get rect(): Rect | null {
    let r: Rect | null = null;
    for (const t of this.tiles) {
      if (!r) r = { x: t.x, y: t.y, w: t.w, h: t.h };
      else {
        const x0 = Math.min(r.x, t.x);
        const y0 = Math.min(r.y, t.y);
        const x1 = Math.max(r.x + r.w, t.x + t.w);
        const y1 = Math.max(r.y + r.h, t.y + t.h);
        r = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      }
    }
    return r;
  }

  private swap(): void {
    const s = this.surface;
    const data = s.ensureData();
    for (const t of this.tiles) {
      const rowBytes = t.w * 4;
      const tmp = new Uint8ClampedArray(rowBytes);
      for (let row = 0; row < t.h; row++) {
        const src = ((t.y + row) * s.width + t.x) * 4;
        const off = row * rowBytes;
        tmp.set(data.subarray(src, src + rowBytes));
        data.set(t.data.subarray(off, off + rowBytes), src);
        t.data.set(tmp, off);
      }
    }
    const r = this.rect;
    if (r) {
      s.touch(r);
      this.onChange(s, r);
    }
  }
}

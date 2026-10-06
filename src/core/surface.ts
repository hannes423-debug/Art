import { type Rect, clipRect, unionRect } from './geometry';

/** RGBA pixel storage backed by a plain ArrayBuffer (required by ImageData). */
export type Pixels = Uint8ClampedArray<ArrayBuffer>;

export function allocPixels(width: number, height: number): Pixels {
  return new Uint8ClampedArray(width * height * 4);
}

let nextSurfaceId = 1;

/**
 * A raster surface: the source of truth for a cel's pixels.
 *
 * Pixels are stored as non-premultiplied RGBA bytes so semi-transparent colors
 * survive editing, saving and exporting exactly. A display canvas is created
 * lazily (only for surfaces that are actually shown) and kept in sync through
 * dirty-rectangle uploads, so drawing never re-uploads the whole image.
 *
 * `data === null` means "fully transparent" and costs no memory; it is
 * allocated on first write via {@link ensureData}.
 */
export class Surface {
  readonly id = nextSurfaceId++;
  width: number;
  height: number;
  data: Pixels | null;
  /** Incremented on every modification. Used by caches (thumbnails, autosave). */
  version = 0;

  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private imageData: ImageData | null = null;
  private pending: Rect | null = null;

  constructor(width: number, height: number, data: Pixels | null = null) {
    if (data && data.length !== width * height * 4) {
      throw new Error(`Surface data length ${data.length} does not match ${width}x${height}`);
    }
    this.width = width;
    this.height = height;
    this.data = data;
  }

  ensureData(): Pixels {
    if (!this.data) {
      this.data = allocPixels(this.width, this.height);
      this.imageData = null;
    }
    return this.data;
  }

  /** Record that pixels inside `r` changed. */
  touch(r: Rect | null = null): void {
    this.version++;
    const area = r ? clipRect(r, this.width, this.height) : { x: 0, y: 0, w: this.width, h: this.height };
    if (area) this.pending = unionRect(this.pending, area);
  }

  /** Replace the full contents, optionally changing dimensions. */
  replace(width: number, height: number, data: Pixels | null): void {
    if (data && data.length !== width * height * 4) throw new Error('replace: bad data length');
    const sizeChanged = width !== this.width || height !== this.height;
    this.width = width;
    this.height = height;
    this.data = data;
    this.imageData = null;
    if (sizeChanged && this.canvas) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.touch();
  }

  hasCanvas(): boolean {
    return this.canvas !== null;
  }

  /** Returns an up-to-date display canvas (created on demand). */
  getCanvas(): HTMLCanvasElement {
    if (!this.canvas) {
      const c = document.createElement('canvas');
      c.width = this.width;
      c.height = this.height;
      this.canvas = c;
      this.ctx = c.getContext('2d');
      this.pending = { x: 0, y: 0, w: this.width, h: this.height };
    }
    this.flush();
    return this.canvas;
  }

  /** Uploads any pending changes into the display canvas. */
  flush(): void {
    if (!this.canvas || !this.ctx || !this.pending) return;
    const r = clipRect(this.pending, this.width, this.height);
    this.pending = null;
    if (!r) return;
    if (!this.data) {
      this.ctx.clearRect(r.x, r.y, r.w, r.h);
      return;
    }
    if (!this.imageData || this.imageData.data !== this.data) {
      this.imageData = new ImageData(this.data, this.width, this.height);
    }
    this.ctx.putImageData(this.imageData, 0, 0, r.x, r.y, r.w, r.h);
  }

  /** Frees the display canvas memory (important on iOS where canvas memory is capped). */
  releaseCanvas(): void {
    if (this.canvas) {
      this.canvas.width = 0;
      this.canvas.height = 0;
    }
    this.canvas = null;
    this.ctx = null;
    this.imageData = null;
    this.pending = null;
  }

  /** True when every pixel is fully transparent. */
  isBlank(): boolean {
    const d = this.data;
    if (!d) return true;
    for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) return false;
    return true;
  }

  /** Bounding box of non-transparent pixels, or null when blank. */
  contentBounds(): Rect | null {
    const d = this.data;
    if (!d) return null;
    const w = this.width;
    const h = this.height;
    let minX = w;
    let minY = h;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < h; y++) {
      let row = y * w * 4 + 3;
      for (let x = 0; x < w; x++, row += 4) {
        if (d[row] !== 0) {
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

  clone(): Surface {
    return new Surface(this.width, this.height, this.data ? this.data.slice() : null);
  }

  getPixel(x: number, y: number): [number, number, number, number] {
    if (!this.data || x < 0 || y < 0 || x >= this.width || y >= this.height) return [0, 0, 0, 0];
    const i = (y * this.width + x) * 4;
    const d = this.data;
    return [d[i], d[i + 1], d[i + 2], d[i + 3]];
  }

  /** Copies a rectangle of pixels into a new tightly-packed buffer (outside areas are transparent). */
  readRect(r: Rect): Pixels {
    const out = allocPixels(r.w, r.h);
    const d = this.data;
    if (!d) return out;
    const clip = clipRect(r, this.width, this.height);
    if (!clip) return out;
    for (let y = clip.y; y < clip.y + clip.h; y++) {
      const src = (y * this.width + clip.x) * 4;
      const dst = ((y - r.y) * r.w + (clip.x - r.x)) * 4;
      out.set(d.subarray(src, src + clip.w * 4), dst);
    }
    return out;
  }
}

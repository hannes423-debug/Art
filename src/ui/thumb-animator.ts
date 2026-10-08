/**
 * Plays every animated thumbnail with one shared scheduler.
 *
 * - One IntersectionObserver tracks which thumbnails are on screen; only
 *   those are drawn, and only those keep a decoded image (off-screen strips
 *   are released after a short delay, so 200 thumbnails in a list cost about
 *   as much as the dozen that are visible).
 * - One timer wakes up exactly when the next visible thumbnail changes
 *   frame (no 60 fps loop), then draws inside requestAnimationFrame.
 * - Everything pauses while the page is hidden, and thumbnails removed from
 *   the page are forgotten automatically.
 * - All thumbnails share one clock, frames are copied with nearest-neighbour
 *   drawImage (no smoothing) onto a canvas of the frame's exact size, and the
 *   canvas is scaled up by CSS with `image-rendering: pixelated`.
 */

export interface AnimatedThumb {
  /**
   * Frames side by side, each frameW × frameH: a stored PNG (decoded only
   * while visible) or a live canvas (e.g. the timeline preview).
   */
  strip: Blob | HTMLCanvasElement;
  frameW: number;
  frameH: number;
  durations: number[];
}

interface Item {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  thumb: AnimatedThumb;
  /** Cumulative end time of each frame within one loop. */
  ends: number[];
  total: number;
  frame: number;
  visible: boolean;
  bitmap: ImageBitmap | HTMLCanvasElement | null;
  loading: boolean;
  releaseTimer: number;
}

/** Off-screen thumbnails keep their decoded image this long (scrolling back is instant). */
const RELEASE_MS = 3000;

export class ThumbAnimator {
  private items = new Map<HTMLCanvasElement, Item>();
  private observer: IntersectionObserver | null = null;
  private timer = 0;
  private raf = 0;
  /** When false, thumbnails show their first frame and nothing runs. */
  private enabled = true;

  constructor() {
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => this.schedule());
  }

  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    for (const it of this.items.values()) {
      it.frame = -1;
      this.draw(it, 0);
    }
    this.schedule();
  }

  /** Number of thumbnails currently being tracked (for tests and diagnostics). */
  get size(): number {
    return this.items.size;
  }

  /** Number of thumbnails that currently hold a decoded image. */
  get decoded(): number {
    let n = 0;
    for (const it of this.items.values()) if (it.bitmap) n++;
    return n;
  }

  /** Starts animating `canvas` (sized to one frame). Returns a function that stops it. */
  attach(canvas: HTMLCanvasElement, thumb: AnimatedThumb): () => void {
    this.detach(canvas);
    canvas.width = thumb.frameW;
    canvas.height = thumb.frameH;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    const ends: number[] = [];
    let t = 0;
    for (const d of thumb.durations) ends.push((t += Math.max(16, d)));
    const it: Item = { canvas, ctx, thumb, ends, total: t, frame: -1, visible: false, bitmap: null, loading: false, releaseTimer: 0 };
    this.items.set(canvas, it);
    this.observe().observe(canvas);
    return () => this.detach(canvas);
  }

  /** Redraws a thumbnail whose strip canvas was repainted (same size and timing). */
  refresh(canvas: HTMLCanvasElement): void {
    const it = this.items.get(canvas);
    if (!it || !it.bitmap) return;
    it.frame = -1;
    this.draw(it, this.enabled ? this.frameAt(it, performance.now()) : 0);
  }

  detach(canvas: HTMLCanvasElement): void {
    const it = this.items.get(canvas);
    if (!it) return;
    this.items.delete(canvas);
    this.observer?.unobserve(canvas);
    clearTimeout(it.releaseTimer);
    release(it);
  }

  private observe(): IntersectionObserver {
    if (!this.observer) {
      this.observer = new IntersectionObserver(
        (entries) => {
          for (const en of entries) {
            const it = this.items.get(en.target as HTMLCanvasElement);
            if (!it) continue;
            it.visible = en.isIntersecting;
            clearTimeout(it.releaseTimer);
            if (it.visible) void this.load(it);
            else {
              it.releaseTimer = window.setTimeout(() => {
                if (it.visible) return;
                release(it);
                it.frame = -1;
              }, RELEASE_MS);
            }
          }
          this.schedule();
        },
        { rootMargin: '64px' },
      );
    }
    return this.observer;
  }

  private async load(it: Item): Promise<void> {
    if (it.bitmap || it.loading) return;
    const strip = it.thumb.strip;
    if (strip instanceof HTMLCanvasElement) {
      // A live strip needs no decoding.
      it.bitmap = strip;
      it.frame = -1;
      this.draw(it, this.enabled ? this.frameAt(it, performance.now()) : 0);
      this.schedule();
      return;
    }
    it.loading = true;
    try {
      const bmp = await createImageBitmap(strip);
      if (!this.items.has(it.canvas)) {
        bmp.close();
        return;
      }
      it.bitmap = bmp;
      it.frame = -1;
      this.draw(it, this.enabled ? this.frameAt(it, performance.now()) : 0);
      this.schedule();
    } catch {
      // A broken strip just stays blank; the static thumbnail is not affected.
    } finally {
      it.loading = false;
    }
  }

  private frameAt(it: Item, now: number): number {
    const t = now % it.total;
    let i = 0;
    while (i < it.ends.length - 1 && t >= it.ends[i]) i++;
    return i;
  }

  /** Milliseconds until `it` shows its next frame. */
  private untilNext(it: Item, now: number): number {
    const t = now % it.total;
    const i = this.frameAt(it, now);
    return it.ends[i] - t;
  }

  private draw(it: Item, frame: number): void {
    if (!it.bitmap || frame === it.frame) return;
    it.frame = frame;
    const { frameW: w, frameH: h } = it.thumb;
    it.ctx.clearRect(0, 0, w, h);
    it.ctx.imageSmoothingEnabled = false;
    it.ctx.drawImage(it.bitmap, frame * w, 0, w, h, 0, 0, w, h);
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = 0;
    if (!this.enabled || (typeof document !== 'undefined' && document.hidden)) return;
    const now = performance.now();
    let wait = Infinity;
    for (const [canvas, it] of this.items) {
      if (!canvas.isConnected) {
        this.detach(canvas);
        continue;
      }
      if (it.visible && it.bitmap) wait = Math.min(wait, this.untilNext(it, now));
    }
    if (wait === Infinity) return;
    this.timer = window.setTimeout(
      () => {
        if (this.raf) return;
        this.raf = requestAnimationFrame((t) => {
          this.raf = 0;
          this.tick(t);
        });
      },
      Math.max(0, wait),
    );
  }

  private tick(now: number): void {
    for (const it of this.items.values()) if (it.visible && it.bitmap) this.draw(it, this.frameAt(it, now));
    this.schedule();
  }
}

/** Frees a decoded strip (a live canvas strip belongs to its owner and is kept). */
function release(it: Item): void {
  if (it.bitmap instanceof ImageBitmap) it.bitmap.close();
  it.bitmap = null;
}

/** The one animator shared by every thumbnail in the app. */
export const thumbAnimator = new ThumbAnimator();

/**
 * Display size for a frame inside a square box: the largest whole-number
 * zoom that fits (so every pixel is the same size), or a fit when the
 * frame is bigger than the box.
 */
export function crispSize(w: number, h: number, box: number): { w: number; h: number } {
  const k = Math.max(w, h) <= box ? Math.floor(box / Math.max(w, h)) : box / Math.max(w, h);
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

import type { Editor } from './editor';
import { type TimelapseFrame, addTimelapseFrames, clearTimelapse, countTimelapseFrames, getTimelapseFrames } from './io/storage';

/** Longest side of a recorded snapshot. */
const MAX_SIDE = 480;
/** Wait this long after an edit before taking a snapshot (strokes in a row become one frame). */
const DEBOUNCE_MS = 700;

/**
 * Records a timelapse of the drawing: after each edit, a small snapshot of
 * the visible image is saved in the browser with the project (IndexedDB),
 * so a recording spans sessions. Snapshots taken before the project has
 * been saved for the first time wait in memory until it has an id.
 */
export class TimelapseRecorder {
  private readonly editor: Editor;
  private pending: { time: number; png: Blob }[] = [];
  private timer = 0;
  private last: Uint8ClampedArray | null = null;
  private stored = 0;
  private storedFor: string | null = null;
  private busy = false;

  constructor(editor: Editor) {
    this.editor = editor;
    editor.history.on('change', () => this.schedule());
    editor.on('document', () => {
      // A different document: start over (its stored frames stay with it).
      this.pending = [];
      this.last = null;
      this.storedFor = null;
      void this.refreshCount();
    });
  }

  get enabled(): boolean {
    return this.editor.settings.timelapse;
  }

  /** Frames recorded for the current document (stored + waiting). */
  async count(): Promise<number> {
    await this.refreshCount();
    return this.stored + this.pending.length;
  }

  private async refreshCount(): Promise<void> {
    const id = this.editor.info.projectId;
    if (!id) {
      this.stored = 0;
      return;
    }
    if (this.storedFor === id) return;
    try {
      this.stored = await countTimelapseFrames(id);
      this.storedFor = id;
    } catch {
      this.stored = 0;
    }
  }

  private schedule(): void {
    if (!this.enabled) return;
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.capture(), DEBOUNCE_MS);
  }

  /** Takes a snapshot now (skipped when nothing visible changed). */
  async capture(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const src = this.editor.renderer.compositeImage;
      if (!src.width || !src.height) return;
      const k = Math.min(1, MAX_SIDE / Math.max(src.width, src.height));
      // Small sprites are scaled up by a whole factor so they stay crisp.
      const up = k === 1 ? Math.max(1, Math.floor(MAX_SIDE / 2 / Math.max(src.width, src.height))) : 1;
      const w = Math.max(1, Math.round(src.width * k * up));
      const h = Math.max(1, Math.round(src.height * k * up));
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.imageSmoothingEnabled = k < 1;
      ctx.drawImage(src, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h).data;
      if (this.last && this.last.length === data.length && this.last.every((v, i) => v === data[i])) return;
      this.last = data;
      const png = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'));
      if (!png) return;
      this.pending.push({ time: Date.now(), png });
      await this.flush();
    } finally {
      this.busy = false;
    }
  }

  /** Writes waiting snapshots once the project has an id in the library. */
  async flush(): Promise<void> {
    const id = this.editor.info.projectId;
    if (!id || !this.pending.length) return;
    const frames: TimelapseFrame[] = this.pending.map((f) => ({ project: id, ...f }));
    this.pending = [];
    try {
      await addTimelapseFrames(frames);
      if (this.storedFor === id) this.stored += frames.length;
      else this.storedFor = null;
    } catch {
      // Storage full or unavailable: the timelapse is a nice-to-have.
    }
  }

  /** All snapshots of the current document, oldest first. */
  async frames(): Promise<Blob[]> {
    await this.flush();
    const id = this.editor.info.projectId;
    const stored = id ? await getTimelapseFrames(id) : [];
    return [...stored.map((f) => f.png), ...this.pending.map((f) => f.png)];
  }

  async clear(): Promise<void> {
    this.pending = [];
    this.last = null;
    const id = this.editor.info.projectId;
    if (id) await clearTimelapse(id);
    this.stored = 0;
    this.storedFor = id;
  }
}

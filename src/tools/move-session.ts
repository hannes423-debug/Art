import { blendImage } from '../core/composite';
import type { ArtDocument } from '../core/document';
import { type Rect, clipRect, intersectRect, unionRect } from '../core/geometry';
import { type Command, CompoundCommand } from '../core/history';
import type { SelectionState } from '../core/selection';
import type { Pixels, Surface } from '../core/surface';
import { TileRecorder } from '../core/tiles';
import { SelectionCommand } from '../ops';

/**
 * A floating selection: pixels lifted from a layer (or pasted) that can be
 * moved around without destroying what is underneath until it is anchored.
 *
 * The layer always shows "original with a hole + floating pixels at the
 * current offset", recomputed from the original tiles on every move, so
 * dragging across other artwork and back never loses pixels. Anchoring
 * produces a single undo step (pixels + moved selection).
 */
/** Scale (negative = flipped) and rotation (radians) around the floating pixels' center. */
export interface FloatTransform {
  sx: number;
  sy: number;
  angle: number;
  /** Bilinear resampling instead of nearest neighbour (crisp pixel art). */
  smooth: boolean;
}

export class MoveSession {
  readonly surface: Surface;
  readonly doc: ArtDocument;
  dx = 0;
  dy = 0;
  xf: FloatTransform = { sx: 1, sy: 1, angle: 0, smooth: false };
  private readonly recorder: TileRecorder;
  /** Area the pixels were lifted from; mask is null when the whole rect was lifted. */
  private readonly hole: { rect: Rect; mask: Uint8Array | null } | null;
  /** Floating pixels at offset (0,0). */
  private readonly float: { rect: Rect; data: Pixels };
  private readonly selBefore: SelectionState | null;
  private lastRect: Rect | null = null;

  private constructor(
    doc: ArtDocument,
    surface: Surface,
    hole: { rect: Rect; mask: Uint8Array | null } | null,
    float: { rect: Rect; data: Pixels },
    selBefore: SelectionState | null,
  ) {
    this.doc = doc;
    this.surface = surface;
    this.recorder = new TileRecorder(surface);
    this.hole = hole;
    this.float = float;
    this.selBefore = selBefore;
  }

  /** Lifts the selected pixels (or the whole layer content) into a floating session. */
  static lift(doc: ArtDocument, surface: Surface): MoveSession | null {
    const sel = doc.selection.getState();
    if (sel) {
      const rect = sel.bounds;
      const data = surface.readRect(rect);
      for (let i = 0; i < sel.data.length; i++) {
        const m = sel.data[i];
        if (m === 255) continue;
        const a = (data[i * 4 + 3] * m) / 255;
        if (a < 0.5) data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = data[i * 4 + 3] = 0;
        else data[i * 4 + 3] = a;
      }
      const s = new MoveSession(doc, surface, { rect, mask: sel.data }, { rect, data }, sel);
      s.render();
      return s;
    }
    const rect = surface.contentBounds();
    if (!rect) return null;
    const s = new MoveSession(doc, surface, { rect, mask: null }, { rect, data: surface.readRect(rect) }, null);
    s.render();
    return s;
  }

  /** Creates a floating session for pasted pixels placed at (x, y). */
  static paste(doc: ArtDocument, surface: Surface, width: number, height: number, data: Pixels, x: number, y: number): MoveSession {
    const rect = { x, y, w: width, h: height };
    const s = new MoveSession(doc, surface, null, { rect, data }, doc.selection.getState());
    // The pasted area becomes the selection so it can be seen and moved.
    const mask = new Uint8Array(width * height);
    for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4 + 3] ? 255 : 0;
    doc.selection.setState({ bounds: rect, data: mask });
    s.pastedSel = { bounds: { ...rect }, data: mask };
    doc.notifySelection();
    s.render();
    return s;
  }

  private pastedSel: SelectionState | null = null;

  moveTo(dx: number, dy: number): void {
    if (dx === this.dx && dy === this.dy) return;
    this.dx = dx;
    this.dy = dy;
    this.render();
  }

  get transformed(): boolean {
    const t = this.xf;
    return t.sx !== 1 || t.sy !== 1 || t.angle !== 0;
  }

  /** Size of the untransformed floating pixels. */
  get size(): { w: number; h: number } {
    return { w: this.float.rect.w, h: this.float.rect.h };
  }

  /** Center of the floating pixels in document coordinates (the transform pivot). */
  get center(): { x: number; y: number } {
    const f = this.float.rect;
    return { x: f.x + f.w / 2 + this.dx, y: f.y + f.h / 2 + this.dy };
  }

  /** The four corners of the (transformed) floating box: top-left, top-right, bottom-right, bottom-left. */
  corners(): { x: number; y: number }[] {
    const { w, h } = this.size;
    const c = this.center;
    const { sx, sy, angle } = this.xf;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return [
      [-w / 2, -h / 2],
      [w / 2, -h / 2],
      [w / 2, h / 2],
      [-w / 2, h / 2],
    ].map(([x, y]) => ({ x: c.x + cos * x * sx - sin * y * sy, y: c.y + sin * x * sx + cos * y * sy }));
  }

  /** Current floating rect in document coordinates (bounding box when transformed). */
  get rect(): Rect {
    const f = this.float.rect;
    if (!this.transformed) return { x: f.x + Math.round(this.dx), y: f.y + Math.round(this.dy), w: f.w, h: f.h };
    const pts = this.corners();
    const x0 = Math.floor(Math.min(...pts.map((p) => p.x)) + 1e-6);
    const y0 = Math.floor(Math.min(...pts.map((p) => p.y)) + 1e-6);
    const x1 = Math.ceil(Math.max(...pts.map((p) => p.x)) - 1e-6);
    const y1 = Math.ceil(Math.max(...pts.map((p) => p.y)) - 1e-6);
    return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
  }

  /** Sets scale/rotation (and optionally the center offset) and re-renders. */
  setTransform(t: Partial<FloatTransform>, dx = this.dx, dy = this.dy): void {
    this.xf = { ...this.xf, ...t };
    this.dx = dx;
    this.dy = dy;
    this.render();
  }

  /**
   * Resamples `src` (w×h, RGBA or 1-channel) through the current transform
   * into the target rect. Each target pixel center is mapped back into the
   * source; nearest neighbour keeps pixel art crisp.
   */
  private resample(src: Uint8Array | Uint8ClampedArray, channels: 1 | 4, target: Rect): Uint8ClampedArray {
    const { w, h } = this.size;
    const c = this.center;
    const { sx, sy, angle, smooth } = this.xf;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const out = new Uint8ClampedArray(target.w * target.h * channels);
    for (let ty = 0; ty < target.h; ty++) {
      for (let tx = 0; tx < target.w; tx++) {
        const ux = target.x + tx + 0.5 - c.x;
        const uy = target.y + ty + 0.5 - c.y;
        const qx = (cos * ux + sin * uy) / sx + w / 2;
        const qy = (-sin * ux + cos * uy) / sy + h / 2;
        const o = (ty * target.w + tx) * channels;
        if (!smooth) {
          const ix = Math.floor(qx);
          const iy = Math.floor(qy);
          if (ix < 0 || iy < 0 || ix >= w || iy >= h) continue;
          const s = (iy * w + ix) * channels;
          for (let k = 0; k < channels; k++) out[o + k] = src[s + k];
          continue;
        }
        // Bilinear on premultiplied values (no dark fringes at transparent edges).
        const fx = qx - 0.5;
        const fy = qy - 0.5;
        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        const ax = fx - x0;
        const ay = fy - y0;
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        for (const [px, py, wgt] of [
          [x0, y0, (1 - ax) * (1 - ay)],
          [x0 + 1, y0, ax * (1 - ay)],
          [x0, y0 + 1, (1 - ax) * ay],
          [x0 + 1, y0 + 1, ax * ay],
        ]) {
          if (px < 0 || py < 0 || px >= w || py >= h || wgt === 0) continue;
          const s = (py * w + px) * channels;
          if (channels === 1) {
            a += src[s] * wgt;
            continue;
          }
          const sa = src[s + 3] * wgt;
          r += src[s] * sa;
          g += src[s + 1] * sa;
          b += src[s + 2] * sa;
          a += sa;
        }
        if (channels === 1) out[o] = a;
        else if (a > 0) {
          out[o] = r / a;
          out[o + 1] = g / a;
          out[o + 2] = b / a;
          out[o + 3] = a;
        }
      }
    }
    return out;
  }

  private render(): void {
    const s = this.surface;
    const fr = this.rect;
    const area = clipRect(unionRect(unionRect(this.hole?.rect ?? null, this.lastRect), fr), s.width, s.height);
    this.lastRect = fr;
    if (area) {
      this.recorder.record(area);
      this.recorder.restore(area);
      const data = s.ensureData();
      const hole = this.hole;
      const h = hole ? intersectRect(hole.rect, area) : null;
      if (hole && h) {
        for (let y = h.y; y < h.y + h.h; y++) {
          for (let x = h.x; x < h.x + h.w; x++) {
            const o = (y * s.width + x) * 4;
            const m = hole.mask ? hole.mask[(y - hole.rect.y) * hole.rect.w + (x - hole.rect.x)] : 255;
            if (m === 0) continue;
            const a = (data[o + 3] * (255 - m)) / 255;
            if (a < 0.5) data[o] = data[o + 1] = data[o + 2] = data[o + 3] = 0;
            else data[o + 3] = a;
          }
        }
      }
      const pixels = this.transformed ? this.resample(this.float.data, 4, fr) : this.float.data;
      blendImage(data, s.width, s.height, pixels, fr.w, fr.h, fr.x, fr.y);
      s.touch(area);
      this.doc.notifyPixels(s, area);
    }
    const base = this.pastedSel ?? this.selBefore;
    if (base) {
      if (this.transformed) {
        // The selection follows the transform (it is the same shape as the floating pixels).
        const mask = this.resample(base.data, 1, fr);
        this.doc.selection.setState({ bounds: fr, data: new Uint8Array(mask.buffer) });
      } else this.doc.selection.setState({ bounds: { ...base.bounds, x: fr.x, y: fr.y }, data: base.data });
      this.doc.notifySelection();
    }
  }

  /** Anchors the floating pixels. Returns the undo record (null if nothing changed). */
  commit(): Command | null {
    const patch = this.recorder.finish(this.hole ? 'Move' : 'Paste', (s, r) => this.doc.notifyPixels(s, r));
    const selAfter = this.doc.selection.getState();
    const cmds: Command[] = [];
    if (patch) cmds.push(patch);
    if (this.selBefore || this.pastedSel) cmds.push(new SelectionCommand(this.doc, this.selBefore, selAfter));
    if (!patch) return null;
    return new CompoundCommand(this.hole ? 'Move' : 'Paste', cmds);
  }

  /** Puts everything back as it was before the session. */
  cancel(): void {
    const area = this.recorder.bounds();
    if (area) {
      this.recorder.restore(area);
      this.surface.touch(area);
      this.doc.notifyPixels(this.surface, area);
    }
    this.recorder.finish('', () => {});
    this.doc.selection.setState(this.selBefore);
    this.doc.notifySelection();
  }
}

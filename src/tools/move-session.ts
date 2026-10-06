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
export class MoveSession {
  readonly surface: Surface;
  readonly doc: ArtDocument;
  dx = 0;
  dy = 0;
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

  /** Current floating rect in document coordinates. */
  get rect(): Rect {
    const f = this.float.rect;
    return { x: f.x + this.dx, y: f.y + this.dy, w: f.w, h: f.h };
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
      blendImage(data, s.width, s.height, this.float.data, fr.w, fr.h, fr.x, fr.y);
      s.touch(area);
      this.doc.notifyPixels(s, area);
    }
    const base = this.pastedSel ?? this.selBefore;
    if (base) {
      this.doc.selection.setState({ bounds: { ...base.bounds, x: base.bounds.x + this.dx, y: base.bounds.y + this.dy }, data: base.data });
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

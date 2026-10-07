import type { Editor } from '../editor';
import { normalizeAngle } from '../render/viewport';
import type { Tool, ToolPointer } from '../tools/tool';

interface TrackedPointer {
  id: number;
  type: string;
  x: number;
  y: number;
  startX: number;
  startY: number;
  /** Ignored touches (e.g. a resting palm while drawing). */
  ignored: boolean;
}

interface ViewSnapshot {
  zoom: number;
  rotation: number;
  flipX: boolean;
  tx: number;
  ty: number;
}

interface Gesture {
  ids: number[];
  start: { x: number; y: number }[];
  view: ViewSnapshot;
  rotating: boolean;
}

const TAP_MAX_MS = 350;
const TAP_MAX_MOVE = 14;
/** A second finger arriving this soon after the first turns a stroke into a gesture. */
const GESTURE_GRACE_MS = 250;
const ROTATE_THRESHOLD = (12 * Math.PI) / 180;
const ROTATE_SNAP = (6 * Math.PI) / 180;
/** Touch and hold without moving: the paint tool becomes an eyedropper. */
const LONG_PRESS_MS = 450;

/**
 * Translates pointer events on the canvas into tool strokes and view
 * navigation, for mouse, pen and touch.
 *
 * - Pen always draws; touches are ignored while a pen stroke is active (palm rejection).
 * - Fingers draw (one finger) or navigate depending on the touch mode. In
 *   "auto" mode fingers draw until a pen is detected, then only navigate.
 * - Two fingers pan/zoom (and optionally rotate); a quick two-finger tap
 *   undoes, a three-finger tap redoes.
 * - A stroke started by one finger is cancelled if a second finger lands
 *   within a short grace period (the start of a pinch).
 */
export class CanvasInput {
  private readonly editor: Editor;
  private readonly el: HTMLElement;
  private pointers = new Map<number, TrackedPointer>();
  private mode: 'idle' | 'tool' | 'pan' | 'gesture' = 'idle';
  private toolPointerId: number | null = null;
  private toolPointerType = '';
  private toolStartTime = 0;
  private toolStartPos = { x: 0, y: 0 };
  private activeTool: Tool | null = null;
  private panLast = { x: 0, y: 0 };
  private gesture: Gesture | null = null;
  private tap: { start: number; maxCount: number; moved: boolean } | null = null;
  private penSeen = false;
  private spaceDown = false;
  private rect: DOMRect;
  private wheelAccum = 0;
  private longPressTimer = 0;
  private lastToolEvent: PointerEvent | null = null;

  constructor(editor: Editor, el: HTMLElement) {
    this.editor = editor;
    this.el = el;
    this.rect = el.getBoundingClientRect();
    el.addEventListener('pointerdown', this.onDown);
    el.addEventListener('pointermove', this.onMove);
    el.addEventListener('pointerup', this.onUp);
    el.addEventListener('pointercancel', this.onCancel);
    el.addEventListener('pointerleave', this.onLeave);
    el.addEventListener('wheel', this.onWheel, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    // Safari's proprietary pinch events would zoom the page.
    el.addEventListener('gesturestart', (e) => e.preventDefault());
    el.addEventListener('gesturechange', (e) => e.preventDefault());
    // Prevent long-press callouts / double-tap zoom on iOS.
    el.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', this.onKey);
    window.addEventListener('blur', () => {
      this.spaceDown = false;
      this.updateCursor();
    });
    editor.on('tool', () => this.updateCursor());
    this.updateCursor();
  }

  /** True while the user is in the middle of a stroke or gesture. */
  get busy(): boolean {
    return this.mode !== 'idle';
  }

  updateRect(): void {
    this.rect = this.el.getBoundingClientRect();
  }

  private updateCursor(): void {
    const panning = this.mode === 'pan' || this.spaceDown;
    this.el.style.cursor = panning ? (this.mode === 'pan' ? 'grabbing' : 'grab') : this.editor.tool.cursor;
  }

  private toPointer(e: PointerEvent, button = 0): ToolPointer {
    const sx = e.clientX - this.rect.left;
    const sy = e.clientY - this.rect.top;
    const d = this.editor.view.screenToDoc(sx, sy);
    const type = e.pointerType === 'pen' ? 'pen' : e.pointerType === 'touch' ? 'touch' : 'mouse';
    return {
      x: d.x,
      y: d.y,
      sx,
      sy,
      pressure: type === 'pen' ? Math.max(0.02, e.pressure || 0) : 1,
      pointerType: type,
      button,
      shift: e.shiftKey,
      alt: e.altKey,
      ctrl: e.ctrlKey || e.metaKey,
      time: e.timeStamp,
    };
  }

  private fingersDraw(): boolean {
    const m = this.editor.settings.touchMode;
    return m === 'draw' || (m === 'auto' && !this.penSeen);
  }

  private onDown = (e: PointerEvent): void => {
    this.updateRect();
    const sx = e.clientX - this.rect.left;
    const sy = e.clientY - this.rect.top;
    if (e.pointerType === 'pen' && !this.penSeen) {
      this.penSeen = true;
      if (this.editor.settings.touchMode === 'auto') this.editor.toast('Pen detected: fingers now pan and zoom (change in Settings).');
    }
    try {
      this.el.setPointerCapture(e.pointerId);
    } catch {
      // Not fatal: capture can fail for synthetic events.
    }
    const tp: TrackedPointer = { id: e.pointerId, type: e.pointerType, x: sx, y: sy, startX: sx, startY: sy, ignored: false };
    this.pointers.set(e.pointerId, tp);
    if (this.editor.playing) this.editor.stop();
    this.el.focus({ preventScroll: true });

    if (e.pointerType === 'touch') {
      this.touchDown(e, tp);
      return;
    }
    if (e.pointerType === 'pen' && (this.mode === 'gesture' || (this.mode === 'tool' && this.toolPointerType === 'touch'))) {
      // The pen wins over fingers: drop the finger stroke/gesture (palm or resting hand).
      if (this.mode === 'tool') this.activeTool?.cancel();
      this.activeTool = null;
      this.toolPointerId = null;
      this.cancelTouchActivity();
      this.mode = 'idle';
    }
    if (this.mode !== 'idle') {
      tp.ignored = true;
      return;
    }
    if (e.pointerType === 'mouse' && (e.button === 1 || this.spaceDown || this.editor.tool.id === 'hand')) {
      this.startPan(sx, sy);
      return;
    }
    if (e.pointerType === 'pen' && this.spaceDown) {
      this.startPan(sx, sy);
      return;
    }
    if (e.button !== 0 && e.button !== 2 && e.button !== 5) {
      tp.ignored = true;
      return;
    }
    this.startTool(e);
  };

  private startPan(x: number, y: number): void {
    this.mode = 'pan';
    this.panLast = { x, y };
    this.updateCursor();
  }

  private startTool(e: PointerEvent): void {
    const editor = this.editor;
    const secondary = e.button === 2;
    const eraserEnd = e.pointerType === 'pen' && (e.button === 5 || (e.buttons & 32) !== 0);
    const p = this.toPointer(e, secondary ? 2 : 0);
    let tool = editor.tool;
    if (eraserEnd) tool = editor.tools.eraser;
    else if (p.alt && tool.altPicks) tool = editor.tools.picker;
    else if (secondary && !tool.paints) return;
    this.activeTool = tool;
    this.mode = 'tool';
    this.toolPointerId = e.pointerId;
    this.toolPointerType = e.pointerType;
    this.toolStartTime = e.timeStamp;
    this.toolStartPos = { x: p.sx, y: p.sy };
    tool.down(p);
    editor.setPointer({ x: p.x, y: p.y });
    this.lastToolEvent = e;
    clearTimeout(this.longPressTimer);
    if (e.pointerType === 'touch' && tool.altPicks) {
      this.longPressTimer = window.setTimeout(() => this.longPressPick(), LONG_PRESS_MS);
    }
  }

  /** A finger resting on the canvas with a paint tool picks colors instead (with a loupe). */
  private longPressPick(): void {
    const e = this.lastToolEvent;
    const tool = this.activeTool;
    if (this.mode !== 'tool' || !e || !tool || e.pointerId !== this.toolPointerId) return;
    const tp = this.pointers.get(e.pointerId);
    if (!tp || Math.hypot(tp.x - tp.startX, tp.y - tp.startY) > TAP_MAX_MOVE) return;
    tool.cancel();
    const picker = this.editor.tools.picker;
    this.activeTool = picker;
    picker.down(this.toPointer(e));
    this.feedback('Color picker');
  }

  private onMove = (e: PointerEvent): void => {
    const tp = this.pointers.get(e.pointerId);
    if (!tp) {
      // Hover (mouse or pen without contact).
      if (e.pointerType !== 'touch' && this.mode === 'idle') {
        const p = this.toPointer(e);
        this.editor.tool.hover(p);
        this.editor.setPointer({ x: p.x, y: p.y });
      }
      return;
    }
    const sx = e.clientX - this.rect.left;
    const sy = e.clientY - this.rect.top;
    tp.x = sx;
    tp.y = sy;
    if (tp.ignored) return;
    if (this.tap && Math.hypot(sx - tp.startX, sy - tp.startY) > TAP_MAX_MOVE) this.tap.moved = true;

    if (this.mode === 'tool' && e.pointerId === this.toolPointerId && this.activeTool) {
      this.lastToolEvent = e;
      if (Math.hypot(sx - tp.startX, sy - tp.startY) > TAP_MAX_MOVE) clearTimeout(this.longPressTimer);
      const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
      for (const ev of events.length ? events : [e]) this.activeTool.move(this.toPointer(ev));
      const last = this.toPointer(e);
      this.editor.setPointer({ x: last.x, y: last.y });
    } else if (this.mode === 'pan') {
      this.editor.view.panBy(sx - this.panLast.x, sy - this.panLast.y);
      this.panLast = { x: sx, y: sy };
      this.editor.viewChanged();
    } else if (this.mode === 'gesture') {
      this.updateGesture();
    }
  };

  private onUp = (e: PointerEvent): void => {
    this.finishPointer(e, false);
  };

  private onCancel = (e: PointerEvent): void => {
    this.finishPointer(e, true);
  };

  private onLeave = (e: PointerEvent): void => {
    if (!this.pointers.has(e.pointerId) && e.pointerType !== 'touch') {
      this.editor.tool.hover(null);
      this.editor.setPointer(null);
    }
  };

  private finishPointer(e: PointerEvent, cancelled: boolean): void {
    const tp = this.pointers.get(e.pointerId);
    if (!tp) return;
    this.pointers.delete(e.pointerId);
    try {
      this.el.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    if (this.mode === 'tool' && e.pointerId === this.toolPointerId) {
      clearTimeout(this.longPressTimer);
      const tool = this.activeTool!;
      // A cancelled finger stroke is discarded; pen/mouse strokes are kept.
      if (cancelled && e.pointerType === 'touch') tool.cancel();
      else {
        tool.up(this.toPointer(e));
        // A completed stroke is never a tap (no accidental undo).
        this.tap = null;
      }
      this.mode = 'idle';
      this.toolPointerId = null;
      this.activeTool = null;
      if (e.pointerType === 'touch') this.editor.tool.hover(null);
      return;
    }
    if (this.mode === 'pan' && e.pointerType !== 'touch') {
      this.mode = 'idle';
      this.updateCursor();
      return;
    }
    if (e.pointerType === 'touch') {
      const remaining = this.touchPointers();
      if (this.mode === 'gesture') {
        if (remaining.length === 0) {
          this.mode = 'idle';
          this.gesture = null;
        } else this.beginGesture(remaining);
      }
      this.maybeEndTap(e);
    }
  }

  private touchPointers(): TrackedPointer[] {
    return [...this.pointers.values()].filter((p) => p.type === 'touch' && !p.ignored);
  }

  private touchDown(e: PointerEvent, tp: TrackedPointer): void {
    // Palm rejection: ignore touches while drawing with a pen or mouse.
    if (this.mode === 'tool' && this.toolPointerType !== 'touch') {
      tp.ignored = true;
      return;
    }
    const touches = this.touchPointers();
    if (touches.length === 1) {
      this.tap = { start: e.timeStamp, maxCount: 1, moved: false };
      if (this.fingersDraw() && this.editor.tool.id !== 'hand') this.startTool(e);
      else this.beginGesture(touches);
      return;
    }
    if (this.tap) this.tap.maxCount = Math.max(this.tap.maxCount, touches.length);
    if (this.mode === 'tool') {
      const quick = e.timeStamp - this.toolStartTime < GESTURE_GRACE_MS;
      const tool = this.activeTool;
      const toolPointer = this.toolPointerId !== null ? this.pointers.get(this.toolPointerId) : undefined;
      const moved = toolPointer ? Math.hypot(toolPointer.x - this.toolStartPos.x, toolPointer.y - this.toolStartPos.y) : 0;
      if (quick && moved < 40) {
        // The first finger was the start of a pinch, not a stroke.
        clearTimeout(this.longPressTimer);
        tool?.cancel();
        this.activeTool = null;
        this.toolPointerId = null;
        this.beginGesture(touches);
      } else {
        tp.ignored = true;
      }
      return;
    }
    this.beginGesture(touches);
  }

  private cancelTouchActivity(): void {
    for (const p of this.pointers.values()) if (p.type === 'touch') p.ignored = true;
    if (this.mode === 'gesture') {
      this.mode = 'idle';
      this.gesture = null;
    }
  }

  private snapshot(): ViewSnapshot {
    const v = this.editor.view;
    return { zoom: v.zoom, rotation: v.rotation, flipX: v.flipX, tx: v.tx, ty: v.ty };
  }

  private beginGesture(touches: TrackedPointer[]): void {
    const pts = touches.slice(0, 2);
    this.mode = 'gesture';
    this.gesture = {
      ids: pts.map((p) => p.id),
      start: pts.map((p) => ({ x: p.x, y: p.y })),
      view: this.snapshot(),
      rotating: false,
    };
  }

  private updateGesture(): void {
    const g = this.gesture;
    if (!g) return;
    const cur = g.ids.map((id) => this.pointers.get(id));
    if (cur.some((p) => !p)) return;
    const v = this.editor.view;
    Object.assign(v, g.view);
    if (cur.length === 1) {
      v.panBy(cur[0]!.x - g.start[0].x, cur[0]!.y - g.start[0].y);
    } else {
      const [a0, b0] = g.start;
      const a1 = cur[0]!;
      const b1 = cur[1]!;
      const c0 = { x: (a0.x + b0.x) / 2, y: (a0.y + b0.y) / 2 };
      const c1 = { x: (a1.x + b1.x) / 2, y: (a1.y + b1.y) / 2 };
      const d0 = Math.max(1, Math.hypot(b0.x - a0.x, b0.y - a0.y));
      const d1 = Math.max(1, Math.hypot(b1.x - a1.x, b1.y - a1.y));
      v.panBy(c1.x - c0.x, c1.y - c0.y);
      v.zoomAt(c1.x, c1.y, g.view.zoom * (d1 / d0));
      if (this.editor.settings.rotateGesture) {
        const angle = normalizeAngle(Math.atan2(b1.y - a1.y, b1.x - a1.x) - Math.atan2(b0.y - a0.y, b0.x - a0.x));
        if (!g.rotating && Math.abs(angle) > ROTATE_THRESHOLD) g.rotating = true;
        if (g.rotating) {
          let target = normalizeAngle(g.view.rotation + angle);
          const quarter = Math.round(target / (Math.PI / 2)) * (Math.PI / 2);
          if (Math.abs(target - quarter) < ROTATE_SNAP) target = quarter;
          v.rotateAt(c1.x, c1.y, normalizeAngle(target - v.rotation));
        }
      }
    }
    this.editor.viewChanged();
  }

  private maybeEndTap(e: PointerEvent): void {
    if (e.pointerType !== 'touch' || !this.tap) return;
    if (this.touchPointers().length > 0) return;
    const t = this.tap;
    this.tap = null;
    if (t.moved || e.timeStamp - t.start > TAP_MAX_MS || t.maxCount < 2) return;
    if (t.maxCount === 2) {
      if (this.editor.history.undo()) this.feedback('Undo');
    } else if (t.maxCount >= 3) {
      if (this.editor.history.redo()) this.feedback('Redo');
    }
  }

  private feedback(label: string): void {
    this.editor.setStatusHint(label);
    try {
      navigator.vibrate?.(8);
    } catch {
      // Vibration is optional.
    }
  }

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.updateRect();
    const v = this.editor.view;
    const sx = e.clientX - this.rect.left;
    const sy = e.clientY - this.rect.top;
    const lineScale = e.deltaMode === 1 ? 30 : e.deltaMode === 2 ? 300 : 1;
    const dx = e.deltaX * lineScale;
    const dy = e.deltaY * lineScale;
    if (e.ctrlKey || e.metaKey) {
      // Trackpad pinch (reported as ctrl+wheel) or Ctrl+wheel: smooth zoom.
      v.zoomAt(sx, sy, v.zoom * Math.exp(-dy * 0.01));
    } else if (this.editor.settings.wheelZoom && !e.shiftKey) {
      this.wheelAccum += dy;
      if (Math.abs(this.wheelAccum) >= 40 || e.deltaMode !== 0) {
        v.stepZoom(sx, sy, this.wheelAccum < 0 ? 1 : -1);
        this.wheelAccum = 0;
      }
    } else if (e.shiftKey && !dx) {
      v.panBy(-dy, 0);
    } else {
      v.panBy(-dx, -dy);
    }
    this.editor.viewChanged();
  };

  private onKey = (e: KeyboardEvent): void => {
    if (e.code !== 'Space') return;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
    const down = e.type === 'keydown';
    if (down) e.preventDefault();
    if (this.spaceDown !== down) {
      this.spaceDown = down;
      this.updateCursor();
    }
  };
}

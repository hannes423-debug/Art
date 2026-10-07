import type { Editor } from '../editor';
import type { RawImage } from '../io/png';
import { h, iconButton } from './dom';

const MIN_W = 140;
const MIN_H = 120;

/**
 * A floating reference image over the canvas: drag the title bar to move
 * it, the corner to resize it. Inside, drag to pan, scroll or pinch to
 * zoom, and tap or click to pick a color (exact pixel values) into the
 * foreground color.
 */
export class ReferenceWindow {
  readonly el: HTMLElement;
  private readonly editor: Editor;
  private readonly view: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly title: HTMLElement;
  private image: RawImage | null = null;
  private bitmap: HTMLCanvasElement | null = null;
  private zoom = 1;
  private tx = 0;
  private ty = 0;
  private pointers = new Map<number, { x: number; y: number; sx: number; sy: number }>();
  private pinch: { d: number; zoom: number; cx: number; cy: number; tx: number; ty: number } | null = null;
  private moved = false;
  /** Called when the user asks for another image. */
  onOpen: () => void = () => {};

  constructor(editor: Editor) {
    this.editor = editor;
    this.view = h('canvas', { class: 'reference-view', 'aria-label': 'Reference image. Tap to pick a color.' });
    this.ctx = this.view.getContext('2d')!;
    this.title = h('span', { class: 'reference-title' }, 'Reference');
    const header = h(
      'div',
      { class: 'reference-header' },
      this.title,
      iconButton('fit', 'Fit', () => this.fit(), 'small'),
      iconButton('open', 'Open another image', () => this.onOpen(), 'small'),
      iconButton('close', 'Close reference', () => this.hide(), 'small'),
    );
    const grip = h('div', { class: 'reference-grip', title: 'Resize', 'aria-hidden': 'true' });
    this.el = h('div', { class: 'reference-window', role: 'dialog', 'aria-label': 'Reference image', hidden: true }, header, this.view, grip);
    this.dragBy(header, (dx, dy) => this.moveBy(dx, dy));
    this.dragBy(grip, (dx, dy) => this.resizeBy(dx, dy));
    this.view.addEventListener('pointerdown', this.onDown);
    this.view.addEventListener('pointermove', this.onMove);
    this.view.addEventListener('pointerup', this.onUp);
    this.view.addEventListener('pointercancel', this.onUp);
    this.view.addEventListener('wheel', this.onWheel, { passive: false });
    new ResizeObserver(() => this.draw()).observe(this.view);
  }

  get visible(): boolean {
    return !this.el.hidden;
  }

  get hasImage(): boolean {
    return this.image !== null;
  }

  show(img: RawImage, name: string): void {
    this.image = img;
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const data = new Uint8ClampedArray(img.data.length);
    data.set(img.data);
    c.getContext('2d')!.putImageData(new ImageData(data, img.width, img.height), 0, 0);
    this.bitmap = c;
    this.title.textContent = name;
    this.title.title = name;
    this.el.hidden = false;
    requestAnimationFrame(() => this.fit());
  }

  /** Shows the window again with its last image (false if there is none). */
  reopen(): boolean {
    if (!this.image) return false;
    this.el.hidden = false;
    requestAnimationFrame(() => this.draw());
    return true;
  }

  hide(): void {
    this.el.hidden = true;
  }

  fit(): void {
    const img = this.image;
    if (!img) return;
    const w = this.view.clientWidth;
    const hgt = this.view.clientHeight;
    this.zoom = Math.min(w / img.width, hgt / img.height);
    if (this.zoom >= 1) this.zoom = Math.floor(this.zoom);
    this.tx = (w - img.width * this.zoom) / 2;
    this.ty = (hgt - img.height * this.zoom) / 2;
    this.draw();
  }

  private draw(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(this.view.clientWidth * dpr));
    const hgt = Math.max(1, Math.round(this.view.clientHeight * dpr));
    if (this.view.width !== w || this.view.height !== hgt) {
      this.view.width = w;
      this.view.height = hgt;
    }
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#1b1d21';
    ctx.fillRect(0, 0, w, hgt);
    if (!this.bitmap) return;
    ctx.setTransform(this.zoom * dpr, 0, 0, this.zoom * dpr, this.tx * dpr, this.ty * dpr);
    // Crisp pixels when zoomed in, smooth when zoomed out (photos).
    ctx.imageSmoothingEnabled = this.zoom < 1;
    ctx.drawImage(this.bitmap, 0, 0);
  }

  private zoomAt(x: number, y: number, zoom: number): void {
    const z = Math.max(0.05, Math.min(64, zoom));
    this.tx = x - ((x - this.tx) * z) / this.zoom;
    this.ty = y - ((y - this.ty) * z) / this.zoom;
    this.zoom = z;
    this.draw();
  }

  private local(e: PointerEvent | WheelEvent): { x: number; y: number } {
    const r = this.view.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const p = this.local(e);
    this.zoomAt(p.x, p.y, this.zoom * Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.002)));
  };

  private onDown = (e: PointerEvent): void => {
    e.stopPropagation();
    this.view.setPointerCapture(e.pointerId);
    const p = this.local(e);
    this.pointers.set(e.pointerId, { ...p, sx: p.x, sy: p.y });
    this.moved = this.pointers.size > 1;
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinch = { d: Math.hypot(b.x - a.x, b.y - a.y) || 1, zoom: this.zoom, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, tx: this.tx, ty: this.ty };
    }
  };

  private onMove = (e: PointerEvent): void => {
    const prev = this.pointers.get(e.pointerId);
    if (!prev) return;
    const p = this.local(e);
    if (Math.hypot(p.x - prev.sx, p.y - prev.sy) > 6) this.moved = true;
    const dx = p.x - prev.x;
    const dy = p.y - prev.y;
    prev.x = p.x;
    prev.y = p.y;
    if (this.pinch && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      const z = Math.max(0.05, Math.min(64, (this.pinch.zoom * d) / this.pinch.d));
      this.tx = cx - ((this.pinch.cx - this.pinch.tx) * z) / this.pinch.zoom;
      this.ty = cy - ((this.pinch.cy - this.pinch.ty) * z) / this.pinch.zoom;
      this.zoom = z;
      this.draw();
    } else if (this.moved) {
      this.tx += dx;
      this.ty += dy;
      this.draw();
    }
  };

  private onUp = (e: PointerEvent): void => {
    if (!this.pointers.has(e.pointerId)) return;
    const wasTap = !this.moved && this.pointers.size === 1 && e.type === 'pointerup';
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (wasTap) this.pick(this.local(e));
  };

  /** Picks the exact pixel under (x, y) into the foreground (right button: background). */
  private pick(p: { x: number; y: number }, which: 'fg' | 'bg' = 'fg'): void {
    const img = this.image;
    if (!img) return;
    const ix = Math.floor((p.x - this.tx) / this.zoom);
    const iy = Math.floor((p.y - this.ty) / this.zoom);
    if (ix < 0 || iy < 0 || ix >= img.width || iy >= img.height) return;
    const o = (iy * img.width + ix) * 4;
    if (img.data[o + 3] === 0) return;
    this.editor.setColor(which, { r: img.data[o], g: img.data[o + 1], b: img.data[o + 2], a: img.data[o + 3] });
  }

  private dragBy(handle: HTMLElement, fn: (dx: number, dy: number) => void): void {
    let last: { x: number; y: number } | null = null;
    handle.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      e.stopPropagation();
      handle.setPointerCapture(e.pointerId);
      last = { x: e.clientX, y: e.clientY };
    });
    handle.addEventListener('pointermove', (e) => {
      if (!last) return;
      fn(e.clientX - last.x, e.clientY - last.y);
      last = { x: e.clientX, y: e.clientY };
    });
    const end = () => (last = null);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  private bounds(): DOMRect {
    return (this.el.parentElement ?? document.body).getBoundingClientRect();
  }

  private moveBy(dx: number, dy: number): void {
    const parent = this.bounds();
    const x = Math.max(0, Math.min(parent.width - 60, this.el.offsetLeft + dx));
    const y = Math.max(0, Math.min(parent.height - 40, this.el.offsetTop + dy));
    this.el.style.left = `${x}px`;
    this.el.style.top = `${y}px`;
    this.el.style.right = 'auto';
  }

  private resizeBy(dx: number, dy: number): void {
    const parent = this.bounds();
    const w = Math.max(MIN_W, Math.min(parent.width - this.el.offsetLeft, this.el.offsetWidth + dx));
    const hgt = Math.max(MIN_H, Math.min(parent.height - this.el.offsetTop, this.el.offsetHeight + dy));
    this.el.style.width = `${w}px`;
    this.el.style.height = `${hgt}px`;
  }
}

import type { Editor } from '../editor';
import { h, iconButton } from './dom';

function zoomLabel(z: number): string {
  const pct = z * 100;
  return pct >= 100 ? `${Math.round(pct)}%` : `${pct.toFixed(pct < 10 ? 1 : 0)}%`;
}

/** Document size, exact pixel coordinates, hints, and view controls. */
export class StatusBar {
  readonly el = h('footer', { class: 'statusbar' });
  private readonly editor: Editor;
  private size = h('span', { class: 'sb-item sb-size', title: 'Canvas size' });
  private pos = h('span', { class: 'sb-item sb-pos', title: 'Pointer position (pixels)' });
  private sel = h('span', { class: 'sb-item sb-sel', title: 'Selection' });
  private hint = h('span', { class: 'sb-item sb-hint' });
  private zoom = h('button', { type: 'button', class: 'sb-zoom', title: 'Zoom (click for 100%)' });
  private rot = h('button', { type: 'button', class: 'sb-rot', title: 'View rotation (click to reset)' });
  private frame = h('span', { class: 'sb-item sb-frame' });
  private unsubDoc: (() => void)[] = [];

  constructor(editor: Editor) {
    this.editor = editor;
    this.zoom.addEventListener('click', () => editor.actualPixels());
    this.rot.addEventListener('click', () => editor.resetRotation());
    this.el.append(
      this.size,
      this.pos,
      this.sel,
      this.frame,
      this.hint,
      h('span', { class: 'sb-spacer' }),
      this.rot,
      iconButton('zoom-out', 'Zoom out (-)', () => editor.zoomBy(-1), 'small'),
      this.zoom,
      iconButton('zoom-in', 'Zoom in (+)', () => editor.zoomBy(1), 'small'),
      iconButton('fit', 'Fit to screen (Ctrl+0)', () => editor.fitView(), 'small'),
    );
    editor.on('pointer', (p) => {
      const d = editor.doc;
      if (!p) this.pos.textContent = '';
      else {
        const x = Math.floor(p.x);
        const y = Math.floor(p.y);
        const inside = x >= 0 && y >= 0 && x < d.width && y < d.height;
        this.pos.textContent = `${x}, ${y}`;
        this.pos.classList.toggle('outside', !inside);
      }
    });
    editor.on('hint', (t) => (this.hint.textContent = t));
    editor.on('view', () => this.updateView());
    editor.on('document', () => this.attach());
    this.attach();
  }

  private attach(): void {
    for (const u of this.unsubDoc) u();
    const doc = this.editor.doc;
    const upd = () => this.updateDoc();
    this.unsubDoc = [doc.on('resize', upd), doc.on('selection', upd), doc.on('frames', upd), doc.on('active', upd)];
    this.updateDoc();
    this.updateView();
  }

  private updateDoc(): void {
    const d = this.editor.doc;
    this.size.textContent = `${d.width} × ${d.height}`;
    const b = d.selection.bounds;
    this.sel.textContent = b ? `Sel ${b.w}×${b.h} @ ${b.x},${b.y}` : '';
    this.frame.textContent = d.frames.length > 1 ? `Frame ${d.activeFrame + 1}/${d.frames.length}` : '';
  }

  private updateView(): void {
    const v = this.editor.view;
    this.zoom.textContent = zoomLabel(v.zoom);
    const deg = Math.round((v.rotation * 180) / Math.PI);
    this.rot.textContent = deg ? `${deg}°` : '';
    this.rot.hidden = !deg && !v.flipX;
    if (v.flipX) this.rot.textContent += ' ⇋';
  }
}

export { zoomLabel };

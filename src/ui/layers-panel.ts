import type { ArtDocument } from '../core/document';
import { BLEND_MODES, type BlendMode, type Layer } from '../core/layer';
import type { Editor } from '../editor';
import { addLayer, deleteLayer, duplicateLayer, mergeDown, moveLayer, setLayerProps } from '../ops';
import { h, icon, iconButton } from './dom';
import { type PopupItem, popupMenu } from './menu';

const THUMB = 36;

/**
 * Layer list (top layer first) with visibility, thumbnails, rename,
 * drag-to-reorder, and the active layer's opacity / blend mode / alpha lock.
 */
export class LayersPanel {
  readonly el: HTMLElement;
  private readonly editor: Editor;
  private list = h('div', { class: 'layer-list', role: 'listbox', 'aria-label': 'Layers' });
  private opacity = h('input', { type: 'range', min: '0', max: '100', step: '1', 'aria-label': 'Layer opacity' });
  private opacityNum = h('span', { class: 'lp-opacity-num' });
  private blend = h('select', { class: 'input lp-blend', 'aria-label': 'Blend mode' }, ...BLEND_MODES.map((m) => h('option', { value: m.id }, m.label)));
  private alphaLock = h(
    'button',
    { type: 'button', class: 'opt-toggle lp-alpha', title: 'Lock alpha: paint only on existing pixels', 'aria-pressed': 'false' },
    icon('lock', 14),
    ' Alpha',
  );
  private unsub: (() => void)[] = [];
  private thumbTimer = 0;
  private dirtyThumbs = new Set<Layer>();
  private opacityStart: number | null = null;
  onLayerMenu: ((layer: Layer, anchor: HTMLElement | { x: number; y: number }) => PopupItem[]) | null = null;

  constructor(editor: Editor) {
    this.editor = editor;
    const add = iconButton('plus', 'New layer (Shift+N)', () => addLayer(editor.doc, editor.history));
    const dup = iconButton('duplicate', 'Duplicate layer (Ctrl+J)', () => duplicateLayer(editor.doc, editor.history));
    const del = iconButton('trash', 'Delete layer', () => {
      if (!deleteLayer(editor.doc, editor.history)) editor.toast('A document needs at least one layer');
    });
    const up = iconButton('chevron-up', 'Move layer up', () => this.shift(1));
    const down = iconButton('chevron-down', 'Move layer down', () => this.shift(-1));
    const merge = iconButton('merge-down', 'Merge down', () => {
      const problem = mergeDown(editor.doc, editor.history);
      if (problem) editor.toast(problem);
    });
    this.el = h(
      'section',
      { class: 'panel layers-panel', 'aria-label': 'Layers' },
      h('div', { class: 'panel-header' }, h('h3', null, 'Layers'), h('div', { class: 'panel-actions' }, add, dup, up, down, merge, del)),
      h(
        'div',
        { class: 'lp-props' },
        h('label', { class: 'lp-opacity', title: 'Layer opacity' }, h('span', null, 'Opacity'), this.opacity, this.opacityNum),
        h('div', { class: 'lp-row2' }, this.blend, this.alphaLock),
      ),
      this.list,
    );

    this.opacity.addEventListener('input', () => {
      const l = editor.doc.activeLayer;
      if (this.opacityStart === null) this.opacityStart = l.opacity;
      l.opacity = Number(this.opacity.value) / 100;
      this.opacityNum.textContent = `${this.opacity.value}%`;
      editor.doc.notifyLayers();
    });
    this.opacity.addEventListener('change', () => {
      const l = editor.doc.activeLayer;
      const v = Number(this.opacity.value) / 100;
      if (this.opacityStart !== null) l.opacity = this.opacityStart;
      this.opacityStart = null;
      if (v !== l.opacity) setLayerProps(editor.doc, editor.history, l, { opacity: v }, 'Layer opacity');
    });
    this.blend.addEventListener('change', () =>
      setLayerProps(editor.doc, editor.history, editor.doc.activeLayer, { blendMode: this.blend.value as BlendMode }, 'Blend mode'),
    );
    this.alphaLock.addEventListener('click', () => {
      const l = editor.doc.activeLayer;
      setLayerProps(editor.doc, editor.history, l, { alphaLocked: !l.alphaLocked }, l.alphaLocked ? 'Unlock alpha' : 'Lock alpha');
    });

    editor.on('document', () => this.attach(editor.doc));
    this.attach(editor.doc);
  }

  private attach(doc: ArtDocument): void {
    for (const u of this.unsub) u();
    this.unsub = [
      doc.on('layers', () => this.render()),
      doc.on('active', () => this.render()),
      doc.on('frames', () => this.render()),
      doc.on('resize', () => this.render()),
      doc.on('pixels', ({ surface }) => {
        const loc = doc.layers.find((l) => l.cels[doc.activeFrame] === surface);
        if (loc) this.queueThumb(loc);
      }),
    ];
    this.render();
  }

  private shift(delta: number): void {
    const doc = this.editor.doc;
    moveLayer(doc, this.editor.history, doc.activeLayer, doc.activeLayerIndex + delta);
  }

  private queueThumb(layer: Layer): void {
    this.dirtyThumbs.add(layer);
    if (this.thumbTimer) return;
    this.thumbTimer = window.setTimeout(() => {
      this.thumbTimer = 0;
      for (const l of this.dirtyThumbs) {
        const c = this.list.querySelector<HTMLCanvasElement>(`[data-layer="${l.id}"] canvas`);
        if (c) this.drawThumb(c, l);
      }
      this.dirtyThumbs.clear();
    }, 200);
  }

  /** Nearest-neighbour thumbnail straight from pixel data (no extra canvases per layer). */
  private drawThumb(canvas: HTMLCanvasElement, layer: Layer): void {
    const doc = this.editor.doc;
    const cel = layer.cels[doc.activeFrame];
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const scale = Math.min(THUMB / doc.width, THUMB / doc.height);
    const cw = Math.max(1, Math.round(doc.width * scale));
    const ch = Math.max(1, Math.round(doc.height * scale));
    const pw = Math.max(1, Math.round(cw * dpr));
    const ph = Math.max(1, Math.round(ch * dpr));
    canvas.width = pw;
    canvas.height = ph;
    canvas.style.width = `${cw}px`;
    canvas.style.height = `${ch}px`;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(pw, ph);
    const src = cel.data;
    if (src) {
      const d = img.data;
      for (let y = 0; y < ph; y++) {
        const sy = Math.min(doc.height - 1, Math.floor(((y + 0.5) * doc.height) / ph));
        for (let x = 0; x < pw; x++) {
          const sx = Math.min(doc.width - 1, Math.floor(((x + 0.5) * doc.width) / pw));
          const s = (sy * doc.width + sx) * 4;
          const o = (y * pw + x) * 4;
          d[o] = src[s];
          d[o + 1] = src[s + 1];
          d[o + 2] = src[s + 2];
          d[o + 3] = src[s + 3];
        }
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  render(): void {
    const e = this.editor;
    const doc = e.doc;
    const active = doc.activeLayer;
    this.opacity.value = String(Math.round(active.opacity * 100));
    this.opacityNum.textContent = `${Math.round(active.opacity * 100)}%`;
    this.blend.value = active.blendMode;
    this.alphaLock.classList.toggle('on', active.alphaLocked);
    this.alphaLock.setAttribute('aria-pressed', String(active.alphaLocked));

    const rows: HTMLElement[] = [];
    for (let i = doc.layers.length - 1; i >= 0; i--) {
      const layer = doc.layers[i];
      const thumb = h('canvas', { class: 'lp-thumb', 'aria-hidden': 'true' });
      this.drawThumb(thumb, layer);
      const eye = h(
        'button',
        {
          type: 'button',
          class: `icon-btn lp-eye ${layer.visible ? '' : 'off'}`.trim(),
          title: layer.visible ? 'Hide layer' : 'Show layer',
          'aria-label': layer.visible ? 'Hide layer' : 'Show layer',
        },
        icon(layer.visible ? 'eye' : 'eye-off', 16),
      );
      eye.addEventListener('click', (ev) => {
        ev.stopPropagation();
        layer.visible = !layer.visible;
        doc.notifyLayers();
        e.markChanged();
      });
      const name = h('span', { class: 'lp-name', title: 'Double-click to rename' }, layer.name);
      name.addEventListener('dblclick', (ev) => {
        ev.stopPropagation();
        this.rename(layer, name);
      });
      const badges = h(
        'span',
        { class: 'lp-badges' },
        layer.alphaLocked ? h('span', { class: 'lp-badge', title: 'Alpha locked' }, icon('lock', 12)) : null,
        layer.opacity < 1 ? h('span', { class: 'lp-badge' }, `${Math.round(layer.opacity * 100)}%`) : null,
        layer.blendMode !== 'normal' ? h('span', { class: 'lp-badge' }, BLEND_MODES.find((m) => m.id === layer.blendMode)!.label) : null,
      );
      const handle = h('span', { class: 'lp-handle', title: 'Drag to reorder', 'aria-hidden': 'true' }, icon('menu', 16));
      const row = h(
        'div',
        {
          class: `layer-row ${layer === active ? 'active' : ''} ${layer.visible ? '' : 'hidden-layer'}`.trim(),
          role: 'option',
          'aria-selected': String(layer === active),
          tabindex: '0',
          dataset: { layer: String(layer.id) },
        },
        eye,
        h('span', { class: 'lp-thumb-wrap' }, thumb),
        name,
        badges,
        handle,
      );
      row.addEventListener('click', () => {
        if (doc.activeLayer !== layer) {
          e.commitFloating();
          doc.setActiveLayer(layer);
        }
      });
      row.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          e.commitFloating();
          doc.setActiveLayer(layer);
        } else if (ev.key === 'F2') this.rename(layer, name);
      });
      row.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        if (this.onLayerMenu) popupMenu({ x: ev.clientX, y: ev.clientY }, this.onLayerMenu(layer, { x: ev.clientX, y: ev.clientY }));
      });
      this.enableDrag(handle, row, layer);
      rows.push(row);
    }
    this.list.replaceChildren(...rows);
  }

  private rename(layer: Layer, nameEl: HTMLElement): void {
    const input = h('input', { type: 'text', class: 'input lp-rename', value: layer.name, 'aria-label': 'Layer name' });
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      if (ok && v && v !== layer.name) setLayerProps(this.editor.doc, this.editor.history, layer, { name: v }, 'Rename layer');
      else this.render();
    };
    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') finish(true);
      else if (ev.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  }

  /** Drag the handle to reorder layers (works with mouse, pen and touch). */
  private enableDrag(handle: HTMLElement, row: HTMLElement, layer: Layer): void {
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const rows = [...this.list.children] as HTMLElement[];
      const startIndex = rows.indexOf(row);
      const rowH = row.getBoundingClientRect().height || 40;
      const startY = e.clientY;
      let target = startIndex;
      handle.setPointerCapture(e.pointerId);
      row.classList.add('dragging');
      const move = (ev: PointerEvent) => {
        const dy = ev.clientY - startY;
        row.style.transform = `translateY(${dy}px)`;
        target = Math.max(0, Math.min(rows.length - 1, startIndex + Math.round(dy / rowH)));
        rows.forEach((r, i) => r.classList.toggle('drop-target', i === target && i !== startIndex));
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        row.classList.remove('dragging');
        row.style.transform = '';
        rows.forEach((r) => r.classList.remove('drop-target'));
        if (target !== startIndex) {
          const doc = this.editor.doc;
          // Rows are top-first; document layers are bottom-first.
          moveLayer(doc, this.editor.history, layer, doc.layers.length - 1 - target);
        }
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
  }
}

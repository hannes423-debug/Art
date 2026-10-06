import { blendPixel } from '../core/composite';
import type { ArtDocument } from '../core/document';
import type { Editor } from '../editor';
import { addFrame, deleteFrame, moveFrame, setAllFrameDurations } from '../ops';
import { h, icon, iconButton } from './dom';

const THUMB = 40;

/**
 * Frame strip for simple sprite animation: select frames, add/duplicate/
 * delete/reorder, onion skin and playback. Hidden until enabled in View.
 */
export class Timeline {
  readonly el = h('div', { class: 'timeline', role: 'group', 'aria-label': 'Frames' });
  private readonly editor: Editor;
  private frames = h('div', { class: 'tl-frames', role: 'listbox', 'aria-label': 'Frames' });
  private playBtn: HTMLButtonElement;
  private onionBtn: HTMLButtonElement;
  private fps = h('input', { type: 'number', class: 'input tl-fps', min: '1', max: '60', 'aria-label': 'Frames per second', inputmode: 'numeric' });
  private unsub: (() => void)[] = [];
  private thumbTimer = 0;

  constructor(editor: Editor) {
    this.editor = editor;
    this.playBtn = iconButton('play', 'Play / stop', () => (editor.playing ? editor.stop() : editor.play()));
    this.onionBtn = iconButton('onion', 'Onion skin (show neighbouring frames)', () => editor.updateSettings({ onionSkin: !editor.settings.onionSkin }));
    const prev = iconButton('skip-back', 'Previous frame (,)', () => this.go(-1), 'tl-optional');
    const next = iconButton('skip-forward', 'Next frame (.)', () => this.go(1), 'tl-optional');
    const add = iconButton('plus', 'New empty frame (Alt+N)', () => addFrame(editor.doc, editor.history, false));
    const dup = iconButton('duplicate', 'Duplicate frame', () => addFrame(editor.doc, editor.history, true));
    const del = iconButton('trash', 'Delete frame', () => {
      if (!deleteFrame(editor.doc, editor.history)) editor.toast('A document needs at least one frame');
    });
    const left = iconButton('chevron-left', 'Move frame earlier', () => moveFrame(editor.doc, editor.history, -1), 'tl-optional');
    const right = iconButton('chevron-right', 'Move frame later', () => moveFrame(editor.doc, editor.history, 1), 'tl-optional');
    this.fps.addEventListener('change', () => {
      const fps = Math.max(1, Math.min(60, Math.round(Number(this.fps.value) || 8)));
      setAllFrameDurations(editor.doc, editor.history, Math.round(1000 / fps));
    });
    this.el.append(
      h('div', { class: 'tl-controls' }, prev, this.playBtn, next),
      this.frames,
      h(
        'div',
        { class: 'tl-controls' },
        add,
        dup,
        left,
        right,
        del,
        this.onionBtn,
        h('label', { class: 'tl-fps-label', title: 'Playback speed' }, this.fps, 'fps'),
      ),
    );
    editor.on('document', () => this.attach(editor.doc));
    editor.on('playback', () => this.updateButtons());
    editor.on('settings', () => this.updateButtons());
    this.attach(editor.doc);
  }

  private go(delta: number): void {
    const doc = this.editor.doc;
    this.editor.commitFloating();
    doc.setActiveFrame((doc.activeFrame + delta + doc.frames.length) % doc.frames.length);
  }

  private attach(doc: ArtDocument): void {
    for (const u of this.unsub) u();
    this.unsub = [
      doc.on('frames', () => this.render()),
      doc.on('active', () => this.render()),
      doc.on('layers', () => this.render()),
      doc.on('resize', () => this.render()),
      doc.on('pixels', () => {
        if (this.thumbTimer || this.el.offsetParent === null) return;
        this.thumbTimer = window.setTimeout(() => {
          this.thumbTimer = 0;
          const c = this.frames.querySelector<HTMLCanvasElement>(`[data-frame="${doc.activeFrame}"] canvas`);
          if (c) this.drawThumb(c, doc.activeFrame);
        }, 300);
      }),
    ];
    this.render();
  }

  private updateButtons(): void {
    const e = this.editor;
    this.playBtn.replaceChildren(icon(e.playing ? 'pause' : 'play'));
    this.playBtn.classList.toggle('on', e.playing);
    this.onionBtn.classList.toggle('on', e.settings.onionSkin);
    this.onionBtn.setAttribute('aria-pressed', String(e.settings.onionSkin));
  }

  private drawThumb(canvas: HTMLCanvasElement, frame: number): void {
    const doc = this.editor.doc;
    const scale = Math.min(THUMB / doc.width, THUMB / doc.height);
    const w = Math.max(1, Math.round(doc.width * scale));
    const hh = Math.max(1, Math.round(doc.height * scale));
    canvas.width = w;
    canvas.height = hh;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(w, hh);
    const d = img.data;
    for (let y = 0; y < hh; y++) {
      const sy = Math.min(doc.height - 1, Math.floor(((y + 0.5) * doc.height) / hh));
      for (let x = 0; x < w; x++) {
        const sx = Math.min(doc.width - 1, Math.floor(((x + 0.5) * doc.width) / w));
        const o = (y * w + x) * 4;
        const s = (sy * doc.width + sx) * 4;
        for (const l of doc.layers) {
          const src = l.cels[frame]?.data;
          if (!l.visible || !src || src[s + 3] === 0) continue;
          blendPixel(d, o, src[s], src[s + 1], src[s + 2], (src[s + 3] / 255) * l.opacity, l.blendMode);
        }
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  render(): void {
    const doc = this.editor.doc;
    this.fps.value = String(Math.round(1000 / (doc.frames[0]?.duration || 125)));
    const items = doc.frames.map((_, i) => {
      const c = h('canvas', { 'aria-hidden': 'true' });
      this.drawThumb(c, i);
      const b = h(
        'button',
        {
          type: 'button',
          class: `tl-frame ${i === doc.activeFrame ? 'active' : ''}`.trim(),
          role: 'option',
          'aria-selected': String(i === doc.activeFrame),
          title: `Frame ${i + 1}`,
          dataset: { frame: String(i) },
        },
        c,
        h('span', { class: 'tl-num' }, String(i + 1)),
      );
      b.addEventListener('click', () => {
        this.editor.stop();
        this.editor.commitFloating();
        doc.setActiveFrame(i);
      });
      return b;
    });
    this.frames.replaceChildren(...items);
    this.frames.querySelector('.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    this.updateButtons();
  }
}

import { blendPixel } from '../core/composite';
import type { ArtDocument } from '../core/document';
import type { Editor } from '../editor';
import { previewFrames, previewKey, renderStrip } from '../core/thumbnail';
import { addFrame, deleteFrame, moveFrame, setAllFrameDurations } from '../ops';
import { h, icon, iconButton } from './dom';
import { crispSize, thumbAnimator } from './thumb-animator';

const THUMB = 40;
/** Live preview: frame size and the most frames it plays. */
const PREVIEW_BOX = 40;
const PREVIEW_MAX_FRAMES = 64;

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
  private pendingThumbs = new Set<number>();
  /** Live animated preview (the frames in the strip stay still). */
  private preview = h('div', { class: 'tl-preview', title: 'Live preview of the animation' });
  private previewCanvas: HTMLCanvasElement | null = null;
  private previewStrip: HTMLCanvasElement | null = null;
  private previewSig = '';
  private previewKey = '';
  private previewTimer = 0;
  /** Opens the tag dialog (null = new tag). */
  onTag: (index: number | null) => void = () => {};

  constructor(editor: Editor) {
    this.editor = editor;
    this.playBtn = iconButton('play', 'Play / stop', () => (editor.playing ? editor.stop() : editor.play()));
    this.onionBtn = iconButton('onion', 'Onion skin (show neighbouring frames)', () => editor.updateSettings({ onionSkin: !editor.settings.onionSkin }));
    const prev = iconButton('skip-back', 'Previous frame (,)', () => this.go(-1), 'tl-optional');
    const next = iconButton('skip-forward', 'Next frame (.)', () => this.go(1), 'tl-optional');
    const add = iconButton('plus', 'New empty frame (Alt+N)', () => addFrame(editor.doc, editor.history, false));
    const dup = iconButton('duplicate', 'Duplicate frame (Alt+D)', () => addFrame(editor.doc, editor.history, true));
    const linked = iconButton(
      'link',
      'New linked frame: shares the pixels of this frame (Alt+L)',
      () => addFrame(editor.doc, editor.history, 'linked'),
      'tl-optional',
    );
    const tag = iconButton('tag', 'New tag for this frame…', () => this.onTag(null), 'tl-optional');
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
      this.preview,
      this.frames,
      h(
        'div',
        { class: 'tl-controls' },
        add,
        dup,
        linked,
        tag,
        left,
        right,
        del,
        this.onionBtn,
        h('label', { class: 'tl-fps-label', title: 'Playback speed' }, this.fps, 'fps'),
      ),
    );
    editor.on('document', () => this.attach(editor.doc));
    editor.on('playback', () => this.updateButtons());
    editor.on('settings', () => {
      this.updateButtons();
      this.queuePreview(0);
    });
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
      doc.on('pixels', ({ surface }) => {
        if (this.el.offsetParent === null) return;
        this.queuePreview();
        // A linked cel changes every frame it appears in.
        for (const f of doc.framesOf(surface)) this.pendingThumbs.add(f);
        if (this.thumbTimer) return;
        this.thumbTimer = window.setTimeout(() => {
          this.thumbTimer = 0;
          for (const f of this.pendingThumbs) {
            const c = this.frames.querySelector<HTMLCanvasElement>(`[data-frame="${f}"] canvas`);
            if (c) this.drawThumb(c, f);
          }
          this.pendingThumbs.clear();
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
          if (!doc.isShown(l) || !src || src[s + 3] === 0) continue;
          blendPixel(d, o, src[s], src[s + 1], src[s + 2], (src[s + 3] / 255) * doc.effectiveOpacity(l), l.blendMode);
        }
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  /** Rebuilds the live preview soon (edits are batched, like the frame thumbnails). */
  private queuePreview(delay = 300): void {
    clearTimeout(this.previewTimer);
    this.previewTimer = window.setTimeout(() => {
      this.previewTimer = 0;
      this.updatePreview();
    }, delay);
  }

  private updatePreview(): void {
    const e = this.editor;
    const doc = e.doc;
    const order = e.playbackOrder();
    // Nothing to animate, previews turned off, or the timeline is hidden.
    if (order.length < 2 || !e.settings.animatedThumbs || this.el.offsetParent === null) {
      this.preview.hidden = order.length < 2 || !e.settings.animatedThumbs;
      if (this.preview.hidden) this.clearPreview();
      return;
    }
    this.preview.hidden = false;
    const { order: frames, durations } = previewFrames(doc, order, PREVIEW_MAX_FRAMES);
    const key = previewKey(doc, frames, durations);
    if (key === this.previewKey && this.previewCanvas?.isConnected) return;
    this.previewKey = key;
    const s = renderStrip(doc, frames, PREVIEW_BOX);
    const sig = `${s.width}x${s.height}:${durations.join('.')}`;
    const strip = this.previewStrip ?? document.createElement('canvas');
    this.previewStrip = strip;
    if (strip.width !== s.width || strip.height !== s.height) {
      strip.width = s.width;
      strip.height = s.height;
    }
    strip.getContext('2d')!.putImageData(new ImageData(s.data as ImageDataArray, s.width, s.height), 0, 0);
    if (sig === this.previewSig && this.previewCanvas?.isConnected) {
      // Same frames and timing: just redraw the current frame.
      thumbAnimator.refresh(this.previewCanvas);
      return;
    }
    this.previewSig = sig;
    if (this.previewCanvas) thumbAnimator.detach(this.previewCanvas);
    const c = h('canvas', { 'aria-hidden': 'true' });
    const size = crispSize(s.frameW, s.frameH, PREVIEW_BOX);
    c.style.width = `${size.w}px`;
    c.style.height = `${size.h}px`;
    this.preview.replaceChildren(c);
    this.previewCanvas = c;
    thumbAnimator.attach(c, { strip, frameW: s.frameW, frameH: s.frameH, durations });
  }

  private clearPreview(): void {
    if (this.previewCanvas) thumbAnimator.detach(this.previewCanvas);
    this.previewCanvas = null;
    this.previewSig = '';
    this.previewKey = '';
    this.preview.replaceChildren();
  }

  render(): void {
    this.queuePreview(0);
    const doc = this.editor.doc;
    this.fps.value = String(Math.round(1000 / (doc.frames[0]?.duration || 125)));
    const layer = doc.activeLayer;
    const items = doc.frames.map((_, i) => {
      const c = h('canvas', { 'aria-hidden': 'true' });
      this.drawThumb(c, i);
      const tagIndex = doc.tags.findIndex((t) => i >= t.from && i <= t.to);
      const tag = tagIndex >= 0 ? doc.tags[tagIndex] : null;
      // The active layer's cel is shared with the previous frame.
      const linked = i > 0 && layer.cels[i] === layer.cels[i - 1];
      const band = tag
        ? h(
            'span',
            {
              class: `tl-tag ${tag.from === i ? 'start' : ''} ${tag.to === i ? 'end' : ''}`.trim(),
              title: `Tag “${tag.name}” (frames ${tag.from + 1}–${tag.to + 1}) — click to edit`,
            },
            tag.from === i ? tag.name : '',
          )
        : null;
      if (band) {
        band.style.background = tag!.color;
        band.addEventListener('click', (ev) => {
          ev.stopPropagation();
          this.onTag(tagIndex);
        });
      }
      const b = h(
        'button',
        {
          type: 'button',
          class: `tl-frame ${i === doc.activeFrame ? 'active' : ''} ${linked ? 'linked' : ''}`.trim(),
          role: 'option',
          'aria-selected': String(i === doc.activeFrame),
          title: `Frame ${i + 1}${linked ? ' · linked to the previous frame on this layer' : ''}`,
          dataset: { frame: String(i) },
        },
        band,
        c,
        h('span', { class: 'tl-num' }, String(i + 1)),
        linked ? h('span', { class: 'tl-link', 'aria-hidden': 'true' }, icon('link', 12)) : null,
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

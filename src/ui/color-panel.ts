import { type HSV, type RGBA, colorsEqual, hsvToRgb, parseHex, rgbToHsv, toCss, toHex } from '../core/color';
import { extractColors } from '../core/palette';
import type { Editor } from '../editor';
import { h, iconButton } from './dom';
import { type PopupItem, popupMenu } from './menu';

export interface PaletteIO {
  importPalette(): void;
  exportPalette(format: 'gpl' | 'hex'): void;
  showMapToPalette(): void;
  /** Opens the palette browser. */
  showPalettes(): void;
  /** Items for the quick palette switcher. */
  switchItems(): (PopupItem | '-')[];
}

/**
 * Foreground/background colors with an HSV picker, numeric inputs, recent
 * colors and a palette — compact enough for a side panel or a phone sheet.
 */
export class ColorPanel {
  readonly el: HTMLElement;
  private readonly editor: Editor;
  private readonly io: PaletteIO;
  private target: 'fg' | 'bg' = 'fg';
  private hsv: HSV = { h: 0, s: 0, v: 0 };
  private alpha = 255;
  private selfUpdate = false;

  private fgSw = h('button', { type: 'button', class: 'cp-sw fg', title: 'Foreground color', 'aria-label': 'Edit foreground color' });
  private bgSw = h('button', { type: 'button', class: 'cp-sw bg', title: 'Background color', 'aria-label': 'Edit background color' });
  private hex = h('input', { type: 'text', class: 'input cp-hex', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Hex color', maxlength: '9' });
  private sv = h('div', { class: 'cp-sv', role: 'slider', 'aria-label': 'Saturation and brightness', tabindex: '0' });
  private svHandle = h('div', { class: 'cp-handle' });
  private hue = h('div', { class: 'cp-hue', role: 'slider', 'aria-label': 'Hue', tabindex: '0' });
  private hueHandle = h('div', { class: 'cp-bar-handle' });
  private alphaBar = h('div', { class: 'cp-alpha', role: 'slider', 'aria-label': 'Alpha', tabindex: '0' });
  private alphaFill = h('div', { class: 'cp-alpha-fill' });
  private alphaHandle = h('div', { class: 'cp-bar-handle' });
  private nums: Record<'r' | 'g' | 'b' | 'a', HTMLInputElement>;
  private recentRow = h('div', { class: 'cp-swatches recent', 'aria-label': 'Recent colors' });
  private paletteGrid = h('div', { class: 'cp-swatches palette', 'aria-label': 'Palette' });
  /** Palette name and size; opens the quick switcher. */
  private paletteName = h('button', { type: 'button', class: 'cp-pal-name', title: 'Switch palette', 'aria-haspopup': 'menu' });

  constructor(editor: Editor, io: PaletteIO) {
    this.editor = editor;
    this.io = io;
    const num = (label: string) => h('input', { type: 'number', class: 'input cp-num', min: '0', max: '255', 'aria-label': label, inputmode: 'numeric' });
    this.nums = { r: num('Red'), g: num('Green'), b: num('Blue'), a: num('Alpha') };
    this.sv.append(this.svHandle);
    this.hue.append(this.hueHandle);
    this.alphaBar.append(this.alphaFill, this.alphaHandle);

    const swap = iconButton('swap', 'Swap colors (X)', () => editor.swapColors(), 'small');
    const reset = iconButton('reset', 'Reset to black/white (D)', () => editor.resetColors(), 'small');
    const paletteMenu = iconButton('more', 'Palette options', () => popupMenu(paletteMenu, this.paletteMenuItems()), 'small');
    const addColor = iconButton('plus', 'Add current color to palette', () => this.addToPalette(), 'small');

    this.el = h(
      'section',
      { class: 'panel color-panel', 'aria-label': 'Colors' },
      h('div', { class: 'cp-top' }, h('div', { class: 'cp-pair' }, this.bgSw, this.fgSw), swap, reset, this.hex),
      h('div', { class: 'cp-picker' }, this.sv, this.hue),
      this.alphaBar,
      h(
        'div',
        { class: 'cp-nums' },
        ...(['r', 'g', 'b', 'a'] as const).map((k) => h('label', { class: 'cp-numfield' }, h('span', null, k.toUpperCase()), this.nums[k])),
      ),
      h('div', { class: 'cp-section-title' }, h('span', null, 'Recent')),
      this.recentRow,
      h('div', { class: 'cp-section-title' }, this.paletteName, h('span', { class: 'cp-title-actions' }, addColor, paletteMenu)),
      this.paletteGrid,
    );

    this.paletteName.addEventListener('click', () => popupMenu(this.paletteName, this.io.switchItems()));
    this.fgSw.addEventListener('click', () => this.setTarget('fg'));
    this.bgSw.addEventListener('click', () => this.setTarget('bg'));
    this.hex.addEventListener('change', () => {
      const c = parseHex(this.hex.value);
      if (c) this.commit(c, true);
      else this.sync();
    });
    for (const k of ['r', 'g', 'b', 'a'] as const) {
      this.nums[k].addEventListener('change', () => {
        const c = { ...this.current() };
        c[k] = Math.max(0, Math.min(255, Math.round(Number(this.nums[k].value) || 0)));
        this.commit(c, true);
      });
    }
    this.dragArea(this.sv, (x, y) => {
      this.hsv = { ...this.hsv, s: x, v: 1 - y };
      this.commit(hsvToRgb(this.hsv, this.alpha), false);
    });
    this.dragArea(this.hue, (_x, y) => {
      this.hsv = { ...this.hsv, h: Math.min(359.99, y * 360) };
      this.commit(hsvToRgb(this.hsv, this.alpha), false);
    });
    this.dragArea(this.alphaBar, (x) => {
      this.alpha = Math.round(x * 255);
      this.commit(hsvToRgb(this.hsv, this.alpha), false);
    });
    this.keyNudge(this.sv, (dx, dy) => {
      this.hsv = { ...this.hsv, s: clamp01(this.hsv.s + dx * 0.02), v: clamp01(this.hsv.v - dy * 0.02) };
      this.commit(hsvToRgb(this.hsv, this.alpha), false);
    });
    this.keyNudge(this.hue, (_dx, dy) => {
      this.hsv = { ...this.hsv, h: (this.hsv.h + dy * 3 + 360) % 360 };
      this.commit(hsvToRgb(this.hsv, this.alpha), false);
    });
    this.keyNudge(this.alphaBar, (dx) => {
      this.alpha = Math.max(0, Math.min(255, this.alpha + dx * 5));
      this.commit(hsvToRgb(this.hsv, this.alpha), false);
    });

    editor.on('colors', () => this.sync());
    editor.on('palette', () => this.renderSwatches());
    this.sync(true);
    this.renderSwatches();
  }

  private current(): RGBA {
    return this.target === 'fg' ? this.editor.fg : this.editor.bg;
  }

  setTarget(t: 'fg' | 'bg'): void {
    this.target = t;
    this.sync(true);
  }

  /** Applies a color to the edited slot. `fromRgb` recomputes HSV (typed input). */
  private commit(c: RGBA, fromRgb: boolean): void {
    if (fromRgb) {
      this.hsv = rgbToHsvKeepHue(c, this.hsv);
      this.alpha = c.a;
    }
    this.selfUpdate = true;
    this.editor.setColor(this.target, c);
    this.selfUpdate = false;
    this.sync();
  }

  private sync(force = false): void {
    const c = this.current();
    if (!this.selfUpdate || force) {
      const expected = hsvToRgb(this.hsv, this.alpha);
      if (force || !colorsEqual(expected, c)) {
        this.hsv = rgbToHsvKeepHue(c, this.hsv);
        this.alpha = c.a;
      }
    }
    this.fgSw.style.setProperty('--c', toCss(this.editor.fg));
    this.bgSw.style.setProperty('--c', toCss(this.editor.bg));
    this.fgSw.classList.toggle('active', this.target === 'fg');
    this.bgSw.classList.toggle('active', this.target === 'bg');
    if (document.activeElement !== this.hex) this.hex.value = toHex(c);
    for (const k of ['r', 'g', 'b', 'a'] as const) if (document.activeElement !== this.nums[k]) this.nums[k].value = String(c[k]);
    this.sv.style.setProperty('--hue', String(this.hsv.h));
    this.svHandle.style.left = `${this.hsv.s * 100}%`;
    this.svHandle.style.top = `${(1 - this.hsv.v) * 100}%`;
    this.svHandle.style.background = toCss({ ...c, a: 255 });
    this.hueHandle.style.top = `${(this.hsv.h / 360) * 100}%`;
    this.alphaFill.style.setProperty('--c', toCss({ ...c, a: 255 }));
    this.alphaHandle.style.left = `${(this.alpha / 255) * 100}%`;
    this.sv.setAttribute('aria-valuetext', `saturation ${Math.round(this.hsv.s * 100)}%, brightness ${Math.round(this.hsv.v * 100)}%`);
    this.hue.setAttribute('aria-valuetext', `${Math.round(this.hsv.h)}°`);
    this.alphaBar.setAttribute('aria-valuetext', `${this.alpha}`);
    this.highlightPalette();
  }

  private dragArea(el: HTMLElement, onPos: (x: number, y: number) => void): void {
    const update = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      onPos(clamp01((e.clientX - r.left) / r.width), clamp01((e.clientY - r.top) / r.height));
    };
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      el.setPointerCapture(e.pointerId);
      update(e);
      const move = (ev: PointerEvent) => update(ev);
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
  }

  private keyNudge(el: HTMLElement, fn: (dx: number, dy: number) => void): void {
    el.addEventListener('keydown', (e) => {
      const d: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      const v = d[e.key];
      if (!v) return;
      e.preventDefault();
      e.stopPropagation();
      fn(v[0], v[1]);
    });
  }

  private swatch(c: RGBA, onPick: (which: 'fg' | 'bg') => void, menu?: () => PopupItem[]): HTMLButtonElement {
    const b = h('button', { type: 'button', class: 'swatch', title: toHex(c), 'aria-label': `Color ${toHex(c)}` });
    b.style.setProperty('--c', toCss(c));
    b.dataset.hex = toHex(c, true);
    b.addEventListener('click', () => onPick(this.target));
    b.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (menu) popupMenu({ x: e.clientX, y: e.clientY }, menu());
      else onPick(this.target === 'fg' ? 'bg' : 'fg');
    });
    // Long press on touch opens the menu.
    let timer = 0;
    b.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch' || !menu) return;
      timer = window.setTimeout(() => {
        timer = -1;
        popupMenu(b, menu());
      }, 500);
    });
    const clearTimer = () => {
      if (timer > 0) clearTimeout(timer);
    };
    b.addEventListener('pointerup', (e) => {
      if (timer === -1) e.preventDefault();
      clearTimer();
    });
    b.addEventListener('pointerleave', clearTimer);
    b.addEventListener(
      'click',
      (e) => {
        if (timer === -1) {
          e.stopImmediatePropagation();
          timer = 0;
        }
      },
      true,
    );
    return b;
  }

  private renderSwatches(): void {
    const e = this.editor;
    this.recentRow.replaceChildren(...e.recent.map((c) => this.swatch(c, (w) => e.setColor(w, c))));
    if (!e.recent.length) this.recentRow.append(h('span', { class: 'cp-empty' }, 'Colors you paint with appear here'));
    this.paletteGrid.replaceChildren(
      ...e.palette.map((c, i) =>
        this.swatch(
          c,
          (w) => e.setColor(w, c),
          () => [
            { label: 'Use as foreground', run: () => e.setColor('fg', c) },
            { label: 'Use as background', run: () => e.setColor('bg', c) },
            { label: 'Replace with current color', run: () => e.setPalette(e.palette.map((p, j) => (j === i ? { ...this.current() } : p))) },
            { label: 'Remove from palette', danger: true, run: () => e.setPalette(e.palette.filter((_, j) => j !== i)) },
          ],
        ),
      ),
    );
    if (!e.palette.length) this.paletteGrid.append(h('span', { class: 'cp-empty' }, 'Empty palette — use + to add colors'));
    this.paletteName.replaceChildren(
      h('span', { class: 'cp-pal-label' }, e.paletteName),
      h('span', { class: 'cp-pal-count' }, String(e.palette.length)),
      h('span', { class: 'cp-pal-caret', 'aria-hidden': 'true' }, '▾'),
    );
    this.paletteName.setAttribute('aria-label', `Palette: ${e.paletteName}, ${e.palette.length} colors. Switch palette`);
    this.highlightPalette();
  }

  private highlightPalette(): void {
    const fg = toHex(this.editor.fg, true);
    this.paletteGrid.querySelectorAll<HTMLElement>('.swatch').forEach((s) => s.classList.toggle('current', s.dataset.hex === fg));
  }

  private addToPalette(): void {
    const c = this.current();
    if (this.editor.palette.some((p) => colorsEqual(p, c))) {
      this.editor.toast('That color is already in the palette');
      return;
    }
    this.editor.setPalette([...this.editor.palette, { ...c }]);
  }

  private paletteMenuItems(): (PopupItem | '-')[] {
    const e = this.editor;
    return [
      {
        label: 'Lock colors to palette',
        checked: e.settings.paletteLock,
        run: () => e.setPaletteLock(!e.settings.paletteLock),
      },
      { label: 'Map image colors to palette…', run: () => this.io.showMapToPalette() },
      '-',
      { label: 'Palettes… (browse, create, edit)', run: () => this.io.showPalettes() },
      '-',
      {
        label: 'Colors from active layer',
        run: () => {
          const d = e.doc.activeCel.data;
          const colors = d ? extractColors(d, 256) : [];
          if (colors === null) e.toast('The layer has more than 256 colors', true);
          else if (!colors.length) e.toast('The layer is empty');
          else e.setPalette(colors, `Colors of ${e.doc.activeLayer.name}`);
        },
      },
      { label: 'Import palette…', run: () => this.io.importPalette() },
      { label: 'Export as GIMP palette (.gpl)', run: () => this.io.exportPalette('gpl') },
      { label: 'Export as hex list (.hex)', run: () => this.io.exportPalette('hex') },
      '-',
      { label: 'Clear palette', danger: true, run: () => e.setPalette([]) },
    ];
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** RGB → HSV, keeping the previous hue/saturation where they are undefined (grays, black). */
function rgbToHsvKeepHue(c: RGBA, prev: HSV): HSV {
  const hsv = rgbToHsv(c);
  if (hsv.v === 0) return { h: prev.h, s: prev.s, v: 0 };
  if (hsv.s === 0) return { h: prev.h, s: 0, v: hsv.v };
  return hsv;
}

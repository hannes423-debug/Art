import type { App } from '../app';
import { type RGBA, parseHex, toCss, toHex } from '../core/color';
import { MAX_DIMENSION } from '../core/document';
import type { MorphShape } from '../core/morphology';
import { type ExportFormat, isAnimatedFormat } from '../io/image';
import { canShareFile } from '../io/files';
import type { ProjectMeta } from '../io/storage';
import { colorMask, mapToPalette, replaceColor, resizeCanvas, scaleImage } from '../ops';
import type { TouchMode } from '../settings';
import { checkbox, confirmDialog, field, numberInput, openDialog, readNumber, selectInput } from './dialog';
import { formatShortcut, h, icon } from './dom';

// ------------------------------------------------------------------ New image

const SIZE_PRESETS: [number, number][] = [
  [16, 16],
  [32, 32],
  [48, 48],
  [64, 64],
  [128, 128],
  [256, 256],
  [512, 512],
  [1024, 1024],
  [320, 180],
  [640, 360],
  [1920, 1080],
];

export type NewBackground = 'transparent' | 'white' | 'black' | 'bg';

export function newImageDialog(app: App, firstRun = false): void {
  const last = app.lastNewSize;
  const w = numberInput(last.w, 1, MAX_DIMENSION);
  const hh = numberInput(last.h, 1, MAX_DIMENSION);
  const bg = selectInput(
    [
      { value: 'transparent', label: 'Transparent' },
      { value: 'white', label: 'White' },
      { value: 'black', label: 'Black' },
      { value: 'bg', label: 'Background color' },
    ],
    last.bg,
  );
  const presets = h(
    'div',
    { class: 'chips' },
    ...SIZE_PRESETS.map(([pw, ph]) => {
      const b = h('button', { type: 'button', class: 'chip' }, pw === ph ? `${pw}` : `${pw}×${ph}`);
      b.title = `${pw} × ${ph} pixels`;
      b.addEventListener('click', () => {
        w.value = String(pw);
        hh.value = String(ph);
      });
      return b;
    }),
  );
  const swap = h('button', { type: 'button', class: 'icon-btn', title: 'Swap width and height', 'aria-label': 'Swap width and height' }, icon('swap'));
  swap.addEventListener('click', () => ([w.value, hh.value] = [hh.value, w.value]));
  const content = [
    firstRun ? h('p', { class: 'dialog-message' }, 'Free, open source and offline. Your work is saved in this browser automatically.') : null,
    h('div', { class: 'field-label' }, 'Size presets (pixels)'),
    presets,
    h('div', { class: 'row' }, field('Width', w), swap, field('Height', hh)),
    field('Background', bg),
  ].filter(Boolean) as HTMLElement[];
  const buttons = [
    ...(firstRun ? [{ label: 'Open file…', onClick: () => void app.open() }] : [{ label: 'Cancel' }]),
    {
      label: 'Create',
      primary: true,
      onClick: () => {
        const W = readNumber(w, 1, MAX_DIMENSION, 64);
        const H = readNumber(hh, 1, MAX_DIMENSION, 64);
        if (W * H > 4096 * 4096 && !window.confirm(`${W}×${H} is very large and may be slow or run out of memory. Continue?`)) return false;
        void app.newDocument(W, H, bg.value as NewBackground);
      },
    },
  ];
  openDialog({ title: firstRun ? 'Welcome to Art' : 'New image', content, buttons });
}

// --------------------------------------------------------------------- Export

export interface ExportSettings {
  format: ExportFormat;
  scale: number;
  content: 'image' | 'layer' | 'sheet' | 'animation';
  columns: number;
  padding: number;
  json: boolean;
  quality: number;
}

export function exportDialog(app: App, webp: boolean, initialContent?: ExportSettings['content']): void {
  const e = app.editor;
  const doc = e.doc;
  const s = app.exportSettings;
  const frames = doc.frames.length;
  const name = h('input', { type: 'text', class: 'input', value: app.exportBaseName(), 'aria-label': 'File name', spellcheck: 'false' });
  const stillFormats = [
    { value: 'png', label: 'PNG (lossless)' },
    { value: 'jpeg', label: 'JPEG (no alpha)' },
    ...(webp ? [{ value: 'webp', label: 'WebP' }] : []),
  ];
  const animFormats = [
    { value: 'gif', label: 'GIF (plays everywhere)' },
    { value: 'apng', label: 'APNG (lossless, full alpha)' },
  ];
  const format = selectInput(stillFormats, 'png');
  /** Remembers the last still and animated format separately. */
  const lastFormat: { still: ExportFormat; anim: 'gif' | 'apng' } = {
    still: isAnimatedFormat(s.format) || (s.format === 'webp' && !webp) ? 'png' : s.format,
    anim: isAnimatedFormat(s.format) ? s.format : 'gif',
  };
  const setFormats = (animated: boolean) => {
    const opts = animated ? animFormats : stillFormats;
    const want = animated ? lastFormat.anim : lastFormat.still;
    format.replaceChildren(...opts.map((o) => h('option', { value: o.value }, o.label)));
    format.value = opts.some((o) => o.value === want) ? want : opts[0].value;
  };
  const scale = selectInput(
    [0.25, 0.5, 1, 2, 3, 4, 5, 6, 8, 10, 12, 16].map((v) => ({
      value: String(v),
      label: v < 1 ? `${v * 100}%` : `${v}× ${v === 1 ? '(original)' : ''}`.trim(),
    })),
    String(s.scale),
  );
  const content = selectInput(
    [
      { value: 'image', label: frames > 1 ? 'Image (current frame)' : 'Image' },
      { value: 'layer', label: 'Active layer only' },
      ...(frames > 1 ? [{ value: 'sheet', label: `Sprite sheet (all ${frames} frames)` }] : []),
      { value: 'animation', label: frames > 1 ? `Animation (all ${frames} frames)` : 'Animation (add frames to animate)' },
    ],
    (() => {
      const c = initialContent ?? s.content;
      return c === 'sheet' && frames < 2 ? 'image' : c;
    })(),
  );
  setFormats(content.value === 'animation');
  content.addEventListener('input', () => setFormats(content.value === 'animation'));
  format.addEventListener('input', () => {
    if (content.value === 'animation') lastFormat.anim = format.value as 'gif' | 'apng';
    else lastFormat.still = format.value as ExportFormat;
  });
  const columns = numberInput(Math.min(s.columns || frames, frames), 1, frames);
  const padding = numberInput(s.padding, 0, 64);
  const json = checkbox('Also save frame data (.json)', s.json, 'Frame rectangles and durations, compatible with common game engines');
  const quality = h('input', { type: 'range', min: '0.5', max: '1', step: '0.01', value: String(s.quality), 'aria-label': 'Quality' });
  const info = h('p', { class: 'field-hint export-info' });
  const sheetFields = h('div', { class: 'row' }, field('Columns', columns), field('Padding (px)', padding));
  const sheetBox = h('div', null, sheetFields, json.el);
  const qualityField = field('Quality', quality);

  const read = (): ExportSettings => ({
    format: format.value as ExportFormat,
    scale: Number(scale.value),
    content: content.value as ExportSettings['content'],
    columns: readNumber(columns, 1, frames, frames),
    padding: readNumber(padding, 0, 64, 0),
    json: json.input.checked,
    quality: Number(quality.value),
  });
  const update = () => {
    const r = read();
    sheetBox.hidden = r.content !== 'sheet';
    qualityField.hidden = r.format !== 'jpeg' && r.format !== 'webp';
    const [w, hgt] = app.exportSize(r);
    const notes: Record<string, string> = {
      jpeg: ' · transparency becomes the background color',
      gif: ` · ${frames} frame${frames === 1 ? '' : 's'}, loops · semi-transparent pixels become fully opaque or transparent`,
      apng: ` · ${frames} frame${frames === 1 ? '' : 's'}, loops`,
    };
    info.textContent = `Output: ${w} × ${hgt} px${notes[r.format] ?? ''}`;
  };
  for (const el of [format, scale, content, columns, padding, quality]) el.addEventListener('input', update);
  update();

  const doExport = async (share: boolean) => {
    const r = read();
    Object.assign(app.exportSettings, r);
    return app.runExport(r, name.value, share);
  };
  const buttons = [
    { label: 'Cancel' },
    ...(typeof navigator.share === 'function' && canShareFile(new Blob([], { type: 'image/png' }), 'a.png')
      ? [{ label: 'Share…', onClick: () => doExport(true).then((ok) => ok !== false) }]
      : []),
    { label: 'Export', primary: true, onClick: () => doExport(false).then((ok) => ok !== false) },
  ];
  const titleFor = () => (content.value === 'animation' ? 'Export animation' : 'Export image');
  const dlg = openDialog({
    title: titleFor(),
    content: [
      field('File name', name),
      field('Content', content),
      sheetBox,
      h('div', { class: 'row' }, field('Format', format), field('Scale', scale)),
      qualityField,
      info,
    ],
    buttons,
  });
  content.addEventListener('input', () => {
    const t = dlg.el.querySelector('h2');
    if (t) t.textContent = titleFor();
  });
}

// --------------------------------------------------------------- Canvas size

export function canvasSizeDialog(app: App): void {
  const e = app.editor;
  const doc = e.doc;
  const w = numberInput(doc.width, 1, MAX_DIMENSION);
  const hh = numberInput(doc.height, 1, MAX_DIMENSION);
  let ax = 0.5;
  let ay = 0.5;
  const grid = h('div', { class: 'anchor-grid', role: 'radiogroup', 'aria-label': 'Anchor' });
  const cells: HTMLButtonElement[] = [];
  for (let j = 0; j < 3; j++) {
    for (let i = 0; i < 3; i++) {
      const b = h('button', { type: 'button', class: 'anchor-cell', role: 'radio', title: 'Keep the image anchored here' });
      b.addEventListener('click', () => {
        ax = i / 2;
        ay = j / 2;
        cells.forEach((c) => c.classList.toggle('on', c === b));
      });
      if (i === 1 && j === 1) b.classList.add('on');
      cells.push(b);
      grid.append(b);
    }
  }
  openDialog({
    title: 'Canvas size',
    content: [
      h('p', { class: 'field-hint' }, `Current: ${doc.width} × ${doc.height}. Pixels are not scaled; the canvas grows or is cropped.`),
      h('div', { class: 'row' }, field('Width', w), field('Height', hh)),
      field('Anchor', grid),
    ],
    buttons: [
      { label: 'Cancel' },
      {
        label: 'Resize canvas',
        primary: true,
        onClick: () => {
          e.commitFloating();
          resizeCanvas(doc, e.history, readNumber(w, 1, MAX_DIMENSION, doc.width), readNumber(hh, 1, MAX_DIMENSION, doc.height), ax, ay);
          e.fitView();
        },
      },
    ],
  });
}

// --------------------------------------------------------------- Scale image

export function scaleImageDialog(app: App): void {
  const e = app.editor;
  const doc = e.doc;
  const w = numberInput(doc.width, 1, MAX_DIMENSION);
  const hh = numberInput(doc.height, 1, MAX_DIMENSION);
  const keep = checkbox('Keep proportions', true);
  const mode = selectInput(
    [
      { value: 'nearest', label: 'Nearest neighbour (crisp pixel art)' },
      { value: 'smooth', label: 'Smooth (photos, painting)' },
    ],
    'nearest',
  );
  const ratio = doc.width / doc.height;
  w.addEventListener('input', () => {
    if (keep.input.checked) hh.value = String(Math.max(1, Math.round(Number(w.value) / ratio)));
  });
  hh.addEventListener('input', () => {
    if (keep.input.checked) w.value = String(Math.max(1, Math.round(Number(hh.value) * ratio)));
  });
  const quick = h(
    'div',
    { class: 'chips' },
    ...[0.5, 2, 3, 4].map((f) => {
      const b = h('button', { type: 'button', class: 'chip' }, f < 1 ? '50%' : `${f}×`);
      b.addEventListener('click', () => {
        w.value = String(Math.max(1, Math.round(doc.width * f)));
        hh.value = String(Math.max(1, Math.round(doc.height * f)));
      });
      return b;
    }),
  );
  openDialog({
    title: 'Scale image',
    content: [quick, h('div', { class: 'row' }, field('Width', w), field('Height', hh)), keep.el, field('Resampling', mode)],
    buttons: [
      { label: 'Cancel' },
      {
        label: 'Scale',
        primary: true,
        onClick: () => {
          e.commitFloating();
          scaleImage(
            doc,
            e.history,
            readNumber(w, 1, MAX_DIMENSION, doc.width),
            readNumber(hh, 1, MAX_DIMENSION, doc.height),
            mode.value as 'nearest' | 'smooth',
          );
          e.fitView();
        },
      },
    ],
  });
}

// ------------------------------------------------------------- Replace color

const replaceDefaults = { tolerance: 0, allLayers: false, allFrames: false };

/** A hex field with a live swatch and buttons to load the foreground/background color. */
function colorField(app: App, label: string, initial: RGBA): { el: HTMLElement; read: () => RGBA | null } {
  const e = app.editor;
  const input = h('input', { type: 'text', class: 'input mono', value: toHex(initial), spellcheck: 'false', 'aria-label': label, maxlength: '9' });
  const chip = colorChip(initial);
  const sync = () => {
    const c = parseHex(input.value);
    chip.style.background = c ? toCss(c) : 'transparent';
    input.classList.toggle('invalid', !c);
  };
  input.addEventListener('input', sync);
  const use = (which: 'fg' | 'bg', text: string) => {
    const b = h(
      'button',
      {
        type: 'button',
        class: 'chip',
        title: `Use the ${which === 'fg' ? 'foreground' : 'background'} color`,
        'aria-label': `${label}: ${which === 'fg' ? 'foreground' : 'background'} color`,
      },
      text,
    );
    b.addEventListener('click', () => {
      input.value = toHex(e[which]);
      sync();
    });
    return b;
  };
  const clear = h('button', { type: 'button', class: 'chip', title: 'Fully transparent', 'aria-label': `${label}: transparent` }, 'Transparent');
  clear.addEventListener('click', () => {
    input.value = '#00000000';
    sync();
  });
  const row = h('div', { class: 'color-field' }, chip, input, use('fg', 'FG'), use('bg', 'BG'), clear);
  return { el: field(label, row), read: () => parseHex(input.value) };
}

export function replaceColorDialog(app: App): void {
  const e = app.editor;
  const d = replaceDefaults;
  const from = colorField(app, 'Replace', e.fg);
  const to = colorField(app, 'With', e.bg);
  const tol = numberInput(d.tolerance, 0, 255);
  const layers = checkbox('All visible layers', d.allLayers);
  const frames = checkbox('All frames', d.allFrames);
  const frameCount = e.doc.frames.length;
  const content: Node[] = [from.el, to.el, field('Tolerance', tol, '0 = only this exact color')];
  content.push(layers.el);
  if (frameCount > 1) content.push(frames.el);
  if (e.doc.selection.active) content.push(h('p', { class: 'field-hint' }, 'Only pixels inside the selection are changed.'));
  openDialog({
    title: 'Replace color',
    content,
    buttons: [
      { label: 'Cancel' },
      {
        label: 'Replace',
        primary: true,
        onClick: () => {
          const a = from.read();
          const b = to.read();
          if (!a || !b) {
            e.toast('Enter colors as #RRGGBB or #RRGGBBAA', true);
            return false;
          }
          d.tolerance = readNumber(tol, 0, 255, 0);
          d.allLayers = layers.input.checked;
          d.allFrames = frames.input.checked;
          e.commitFloating();
          if (!d.allLayers && !e.canEditPixels()) return;
          const n = replaceColor(e.doc, e.history, { from: a, to: b, ...d, allFrames: d.allFrames && frameCount > 1 });
          e.toast(n ? `Replaced ${n} pixel${n === 1 ? '' : 's'}` : 'No pixels of that color found');
        },
      },
    ],
  });
}

// ------------------------------------------------------------- Map to palette

const mapDefaults = { allLayers: false, allFrames: false, dither: false };

export function mapToPaletteDialog(app: App): void {
  const e = app.editor;
  const d = mapDefaults;
  const n = e.palette.length;
  if (!n) {
    e.toast('The palette is empty. Load or add colors first.', true);
    return;
  }
  const layers = checkbox('All visible layers', d.allLayers);
  const frames = checkbox('All frames', d.allFrames);
  const dither = checkbox('Dither (mix the two nearest colors)', d.dither);
  const content: Node[] = [h('p', null, `Every color is replaced by the nearest of the ${n} palette colors. Transparency is kept.`), layers.el];
  if (e.doc.frames.length > 1) content.push(frames.el);
  content.push(dither.el);
  if (e.doc.selection.active) content.push(h('p', { class: 'field-hint' }, 'Only pixels inside the selection are changed.'));
  openDialog({
    title: 'Map colors to palette',
    content,
    buttons: [
      { label: 'Cancel' },
      {
        label: 'Map colors',
        primary: true,
        onClick: () => {
          d.allLayers = layers.input.checked;
          d.allFrames = frames.input.checked && e.doc.frames.length > 1;
          d.dither = dither.input.checked;
          e.commitFloating();
          if (!d.allLayers && !e.canEditPixels()) return;
          const changed = mapToPalette(e.doc, e.history, e.palette, d);
          e.toast(changed ? `Changed ${changed} pixel${changed === 1 ? '' : 's'}` : 'All colors are already in the palette');
        },
      },
    ],
  });
}

// ------------------------------------------------------------- Select color

const selectColorDefaults = { tolerance: 0, merged: false };

export function selectColorDialog(app: App): void {
  const e = app.editor;
  const d = selectColorDefaults;
  const color = colorField(app, 'Color', e.fg);
  const tol = numberInput(d.tolerance, 0, 255);
  const merged = checkbox('Use all visible layers', d.merged);
  const mode = selectInput(
    [
      { value: 'replace', label: 'New selection' },
      { value: 'add', label: 'Add to selection' },
      { value: 'subtract', label: 'Subtract from selection' },
      { value: 'intersect', label: 'Intersect with selection' },
    ],
    'replace',
  );
  openDialog({
    title: 'Select by color',
    content: [color.el, field('Tolerance', tol, '0 = only this exact color'), merged.el, field('Mode', mode)],
    buttons: [
      { label: 'Cancel' },
      {
        label: 'Select',
        primary: true,
        onClick: () => {
          const c = color.read();
          if (!c) {
            e.toast('Enter the color as #RRGGBB or #RRGGBBAA', true);
            return false;
          }
          d.tolerance = readNumber(tol, 0, 255, 0);
          d.merged = merged.input.checked;
          const { mask, bounds } = colorMask(e.doc, c, d.tolerance, d.merged);
          if (!bounds && mode.value === 'replace') {
            e.toast('No pixels of that color');
            return;
          }
          e.applySelection(mask, bounds, mode.value as 'replace' | 'add' | 'subtract' | 'intersect', 'Select by color');
        },
      },
    ],
  });
}

// ------------------------------------------------------------- Symmetry axis

export function symmetryAxisDialog(app: App): void {
  const e = app.editor;
  const doc = e.doc;
  const sym = e.options.symmetry;
  const cur = (v: number, size: number) => (v >= 0 && v <= size ? v : size / 2);
  const x = numberInput(cur(sym.x, doc.width), 0, doc.width, 0.5);
  const y = numberInput(cur(sym.y, doc.height), 0, doc.height, 0.5);
  const mode = selectInput(
    [
      { value: 'off', label: 'Off' },
      { value: 'x', label: 'Mirror left ↔ right' },
      { value: 'y', label: 'Mirror top ↔ bottom' },
      { value: 'xy', label: 'Both (4 copies)' },
    ],
    sym.mode,
  );
  const center = h('button', { type: 'button', class: 'chip' }, 'Center');
  center.addEventListener('click', () => {
    x.value = String(doc.width / 2);
    y.value = String(doc.height / 2);
  });
  const read = (input: HTMLInputElement, size: number) => {
    const v = Number(input.value);
    return Number.isFinite(v) ? Math.max(0, Math.min(size, Math.round(v * 2) / 2)) : size / 2;
  };
  openDialog({
    title: 'Symmetry',
    content: [
      field('Mirror', mode),
      h('div', { class: 'row' }, field('Vertical axis at x', x), field('Horizontal axis at y', y)),
      h('div', { class: 'chips' }, center),
      h(
        'p',
        { class: 'field-hint' },
        'Brush, pencil and eraser strokes are mirrored across the pink axis lines. Use .5 to put the axis through the middle of a pixel.',
      ),
    ],
    buttons: [
      { label: 'Cancel' },
      {
        label: 'Apply',
        primary: true,
        onClick: () => {
          const xv = read(x, doc.width);
          const yv = read(y, doc.height);
          // Store "center" as -1 so it follows the canvas when its size changes.
          e.setSymmetry({
            mode: mode.value as 'off' | 'x' | 'y' | 'xy',
            x: xv === doc.width / 2 ? -1 : xv,
            y: yv === doc.height / 2 ? -1 : yv,
          });
        },
      },
    ],
  });
}

// ----------------------------------------------------------- Grow / shrink

export type SelectionModifyKind = 'grow' | 'shrink' | 'border' | 'feather';

/** Last used values, so repeating an adjustment is one Enter away. */
const modifyDefaults = { radius: 1, shape: 'round' as MorphShape, fromCanvasEdge: true, side: 'outside' as 'outside' | 'inside' };

export function modifySelectionDialog(app: App, kind: SelectionModifyKind): void {
  const e = app.editor;
  const d = modifyDefaults;
  const amount = numberInput(d.radius, 1, 256);
  const shape = selectInput(
    [
      { value: 'round', label: 'Round' },
      { value: 'square', label: 'Square (keeps corners sharp)' },
    ],
    d.shape,
  );
  const edge = checkbox('Shrink away from canvas edges', d.fromCanvasEdge);
  const side = selectInput(
    [
      { value: 'outside', label: 'Outside the selection (outline)' },
      { value: 'inside', label: 'Inside the selection' },
    ],
    d.side,
  );
  const titles = { grow: 'Grow selection', shrink: 'Shrink selection', border: 'Border selection', feather: 'Feather selection' };
  const verbs = { grow: 'Grow', shrink: 'Shrink', border: 'Select border', feather: 'Feather' };
  const content: Node[] =
    kind === 'feather'
      ? [field('Radius (px)', amount, 'Soft edge: painting fades out across it.')]
      : [h('div', { class: 'row' }, field(kind === 'border' ? 'Width (px)' : 'By (px)', amount), field('Shape', shape))];
  if (kind === 'shrink') content.push(edge.el);
  if (kind === 'border') {
    content.push(field('Position', side));
    content.push(h('p', { class: 'field-hint' }, 'Tip: Select layer content, then a 1px outside border, then fill it to outline a sprite.'));
  }
  openDialog({
    title: titles[kind],
    content,
    buttons: [
      { label: 'Cancel' },
      {
        label: verbs[kind],
        primary: true,
        onClick: () => {
          d.radius = readNumber(amount, 1, 256, d.radius);
          d.shape = shape.value as MorphShape;
          d.fromCanvasEdge = edge.input.checked;
          d.side = side.value as 'outside' | 'inside';
          if (kind === 'feather') e.modifySelection({ kind, radius: d.radius });
          else if (kind === 'grow') e.modifySelection({ kind, radius: d.radius, shape: d.shape });
          else if (kind === 'shrink') e.modifySelection({ kind, radius: d.radius, shape: d.shape, fromCanvasEdge: d.fromCanvasEdge });
          else e.modifySelection({ kind, radius: d.radius, shape: d.shape, side: d.side });
        },
      },
    ],
  });
}

// ---------------------------------------------------------------------- Grid

export function gridDialog(app: App): void {
  const e = app.editor;
  const g = e.settings.grid;
  const w = numberInput(g.width, 1, 4096);
  const hh = numberInput(g.height, 1, 4096);
  const show = checkbox('Show grid', g.enabled);
  const snap = checkbox('Snap selections, shapes and moves to the grid', e.settings.snapToGrid);
  openDialog({
    title: 'Grid',
    content: [
      h('div', { class: 'row' }, field('Cell width', w), field('Cell height', hh)),
      show.el,
      snap.el,
      h('p', { class: 'field-hint' }, 'Tip: set the cell size to your tile or sprite size.'),
    ],
    buttons: [
      { label: 'Cancel' },
      {
        label: 'Apply',
        primary: true,
        onClick: () => {
          e.updateSettings({
            grid: { width: readNumber(w, 1, 4096, 16), height: readNumber(hh, 1, 4096, 16), enabled: show.input.checked },
            snapToGrid: snap.input.checked,
          });
          e.markChanged();
        },
      },
    ],
  });
}

// ------------------------------------------------------------------ Settings

export function settingsDialog(app: App): void {
  const e = app.editor;
  const s = e.settings;
  const touch = selectInput(
    [
      { value: 'auto', label: 'Automatic: fingers draw until a pen is used' },
      { value: 'draw', label: 'Fingers draw (two fingers navigate)' },
      { value: 'navigate', label: 'Fingers only pan & zoom (pen draws)' },
    ],
    s.touchMode,
  );
  const wheel = selectInput(
    [
      { value: 'zoom', label: 'Zoom' },
      { value: 'pan', label: 'Scroll / pan (Ctrl+wheel zooms)' },
    ],
    s.wheelZoom ? 'zoom' : 'pan',
  );
  const rotate = checkbox('Rotate the canvas with two fingers', s.rotateGesture);
  const pixelGrid = checkbox('Show pixel grid when zoomed in', s.pixelGrid);
  const smooth = checkbox('Smooth zoom (turn off for crisp pixel art)', s.smooth);
  const onion = h('input', { type: 'range', min: '0.1', max: '0.8', step: '0.05', value: String(s.onionOpacity), 'aria-label': 'Onion skin opacity' });
  const storage = h('p', { class: 'field-hint' }, 'Checking storage…');
  void app.storageInfo().then((t) => (storage.textContent = t));
  openDialog({
    title: 'Settings',
    content: [
      h('h3', { class: 'dialog-section' }, 'Input'),
      field('Touch input', touch),
      field('Mouse wheel', wheel),
      rotate.el,
      h('h3', { class: 'dialog-section' }, 'View'),
      pixelGrid.el,
      smooth.el,
      field('Onion skin opacity', onion),
      h('h3', { class: 'dialog-section' }, 'Storage'),
      storage,
    ],
    buttons: [
      { label: 'Cancel' },
      {
        label: 'Save',
        primary: true,
        onClick: () =>
          e.updateSettings({
            touchMode: touch.value as TouchMode,
            wheelZoom: wheel.value === 'zoom',
            rotateGesture: rotate.input.checked,
            pixelGrid: pixelGrid.input.checked,
            smooth: smooth.input.checked,
            onionOpacity: Number(onion.value),
          }),
      },
    ],
  });
}

// ----------------------------------------------------------------- Shortcuts

export function shortcutsDialog(app: App): void {
  const rows: [string, string][] = [];
  const add = (id: string) => {
    const a = app.actions.get(id);
    if (a?.keys?.length) rows.push([a.label, a.keys.slice(0, 2).map(formatShortcut).join(' / ')]);
  };
  const tools = h(
    'table',
    { class: 'kbd-table' },
    ...Object.values(app.editor.tools).map((t) => h('tr', null, h('td', null, t.label), h('td', null, h('kbd', null, t.shortcut || '—')))),
  );
  for (const id of [
    'edit.undo',
    'edit.redo',
    'file.save',
    'file.saveAs',
    'file.open',
    'file.export',
    'edit.copy',
    'edit.cut',
    'edit.clear',
    'select.all',
    'select.none',
    'layer.new',
    'layer.duplicate',
    'view.zoomIn',
    'view.zoomOut',
    'view.fit',
    'view.actual',
    'view.rotateLeft',
    'view.rotateRight',
    'view.flip',
    'view.grid',
    'view.canvasOnly',
    'view.fullscreen',
    'frame.prev',
    'frame.next',
    'colors.swap',
    'colors.reset',
    'tool.sizeDown',
    'tool.sizeUp',
  ])
    add(id);
  rows.push(['Paste', formatShortcut('mod+v')], ['Opacity 10–100%', `${formatShortcut('alt+1')} … ${formatShortcut('alt+0')}`]);
  const general = h('table', { class: 'kbd-table' }, ...rows.map(([l, k]) => h('tr', null, h('td', null, l), h('td', null, h('kbd', null, k)))));
  const gestures = h(
    'table',
    { class: 'kbd-table' },
    ...[
      ['Pan', 'Space + drag · middle mouse · two fingers'],
      ['Zoom', 'Mouse wheel · pinch · Ctrl + wheel'],
      ['Straight line', 'Shift + click (brush, pencil, eraser)'],
      ['Pick color', 'Alt + click (paint tools)'],
      ['Paint background color', 'Right mouse button'],
      ['Undo / redo', 'Two-finger tap / three-finger tap'],
      ['Selection add / subtract', 'Shift / Alt while selecting'],
      ['Nudge selection', 'Arrow keys with Move (Shift = 10 px)'],
      ['Pen eraser end', 'Erases automatically'],
    ].map(([l, k]) => h('tr', null, h('td', null, l), h('td', null, k))),
  );
  openDialog({
    title: 'Shortcuts & gestures',
    wide: true,
    content: [
      h(
        'div',
        { class: 'kbd-columns' },
        h('div', null, h('h3', { class: 'dialog-section' }, 'Tools'), tools),
        h('div', null, h('h3', { class: 'dialog-section' }, 'Commands'), general),
      ),
      h('h3', { class: 'dialog-section' }, 'Mouse, pen & touch'),
      gestures,
    ],
    buttons: [{ label: 'Close', primary: true }],
  });
}

// --------------------------------------------------------------------- About

export function aboutDialog(): void {
  openDialog({
    title: 'About Art',
    content: [
      h('p', { class: 'about-lead' }, h('strong', null, `Art ${__APP_VERSION__}`), ' — a free, open-source raster and sprite editor.'),
      h(
        'ul',
        { class: 'about-list' },
        h('li', null, 'No accounts, ads, subscriptions, tracking or premium features.'),
        h('li', null, 'Works offline. Your images never leave your device unless you export or share them.'),
        h('li', null, 'Projects are saved in this browser automatically; use “Save project as file” for backups.'),
        h('li', null, 'Licensed under the MIT License.'),
      ),
      h('p', null, h('a', { href: 'https://github.com/hannes423-debug/Art', target: '_blank', rel: 'noopener' }, 'Source code & issues on GitHub')),
    ],
    buttons: [{ label: 'Close', primary: true }],
  });
}

// ------------------------------------------------------------------ Projects

export function projectsDialog(app: App, projects: ProjectMeta[]): void {
  const list = h('div', { class: 'project-list' });
  const urls: string[] = [];
  const handle = openDialog({
    title: 'Recent projects',
    wide: true,
    content: [h('p', { class: 'field-hint' }, 'Projects are stored in this browser on this device. Download a project file to back it up or move it.'), list],
    buttons: [
      { label: 'New image…', onClick: () => app.showNewDialog() },
      { label: 'Open file…', onClick: () => void app.open() },
      { label: 'Close', primary: true },
    ],
    onClose: () => urls.forEach((u) => URL.revokeObjectURL(u)),
  });
  const render = (items: ProjectMeta[]) => {
    list.replaceChildren();
    if (!items.length) {
      list.append(h('p', { class: 'empty' }, 'No saved projects yet. Anything you draw is saved here automatically.'));
      return;
    }
    for (const p of items) {
      const thumb = h('div', { class: 'project-thumb' });
      if (p.thumbnail) {
        const url = URL.createObjectURL(p.thumbnail);
        urls.push(url);
        thumb.append(h('img', { src: url, alt: '', loading: 'lazy' }));
      }
      const isCurrent = app.editor.info.projectId === p.id;
      const open = h(
        'button',
        { type: 'button', class: 'project-open' },
        thumb,
        h('span', { class: 'project-name' }, p.name),
        h(
          'span',
          { class: 'project-meta' },
          `${p.width}×${p.height} · ${p.layers} layer${p.layers === 1 ? '' : 's'}${p.frames > 1 ? ` · ${p.frames} frames` : ''} · ${new Date(p.modified).toLocaleString()}`,
        ),
      );
      open.addEventListener('click', () => {
        handle.close();
        void app.openFromLibrary(p.id);
      });
      const dl = h('button', { type: 'button', class: 'icon-btn', title: 'Download project file', 'aria-label': `Download ${p.name}` }, icon('download'));
      dl.addEventListener('click', () => void app.downloadLibraryProject(p.id));
      const del = h('button', { type: 'button', class: 'icon-btn danger', title: 'Delete project', 'aria-label': `Delete ${p.name}` }, icon('trash'));
      del.addEventListener('click', async () => {
        if (!(await confirmDialog('Delete project?', `“${p.name}” will be permanently deleted from this browser.`, 'Delete', true))) return;
        await app.deleteLibraryProject(p.id);
        render(items.filter((x) => x.id !== p.id));
      });
      list.append(h('div', { class: `project-item ${isCurrent ? 'current' : ''}`.trim() }, open, h('div', { class: 'project-actions' }, dl, del)));
    }
  };
  render(projects);
}

// ------------------------------------------------------------- Sprite sheet

export interface SheetSlice {
  frameW: number;
  frameH: number;
  offsetX: number;
  offsetY: number;
  gapX: number;
  gapY: number;
  skipEmpty: boolean;
}

/** Lets the user describe how a sprite sheet is laid out, with a live grid preview. */
export function spriteSheetDialog(
  _app: App,
  name: string,
  img: { width: number; height: number; data: Uint8ClampedArray },
  onImport: (s: SheetSlice) => void,
): void {
  const guess = guessCell(img.width, img.height);
  const fw = numberInput(guess, 1, img.width);
  const fh = numberInput(Math.min(guess, img.height), 1, img.height);
  const ox = numberInput(0, 0, img.width - 1);
  const oy = numberInput(0, 0, img.height - 1);
  const gx = numberInput(0, 0, img.width);
  const gy = numberInput(0, 0, img.height);
  const skip = checkbox('Skip empty cells', true);
  const preview = h('canvas', { class: 'sheet-preview' });
  const info = h('p', { class: 'field-hint' });
  const scale = Math.max(1, Math.min(8, Math.floor(320 / Math.max(img.width, img.height))));
  const base = document.createElement('canvas');
  base.width = img.width;
  base.height = img.height;
  const copy = new Uint8ClampedArray(img.data.length);
  copy.set(img.data);
  base.getContext('2d')!.putImageData(new ImageData(copy, img.width, img.height), 0, 0);
  const read = (): SheetSlice => ({
    frameW: readNumber(fw, 1, img.width, guess),
    frameH: readNumber(fh, 1, img.height, guess),
    offsetX: readNumber(ox, 0, img.width - 1, 0),
    offsetY: readNumber(oy, 0, img.height - 1, 0),
    gapX: readNumber(gx, 0, img.width, 0),
    gapY: readNumber(gy, 0, img.height, 0),
    skipEmpty: skip.input.checked,
  });
  const draw = () => {
    const s = read();
    const dw = img.width * scale;
    const dh = img.height * scale;
    const dpr = window.devicePixelRatio || 1;
    preview.width = Math.round(dw * dpr);
    preview.height = Math.round(dh * dpr);
    preview.style.width = `${dw}px`;
    preview.style.height = `${dh}px`;
    const ctx = preview.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, dw, dh);
    ctx.drawImage(base, 0, 0, dw, dh);
    ctx.strokeStyle = 'rgba(70,170,255,0.9)';
    ctx.lineWidth = 1;
    let n = 0;
    for (let y = s.offsetY; y + s.frameH <= img.height; y += s.frameH + s.gapY) {
      for (let x = s.offsetX; x + s.frameW <= img.width; x += s.frameW + s.gapX) {
        ctx.strokeRect(x * scale + 0.5, y * scale + 0.5, s.frameW * scale - 1, s.frameH * scale - 1);
        n++;
      }
    }
    info.textContent = `${n} cell${n === 1 ? '' : 's'} of ${s.frameW} × ${s.frameH} px`;
  };
  for (const el of [fw, fh, ox, oy, gx, gy]) el.addEventListener('input', draw);
  draw();
  openDialog({
    title: `Import sprite sheet — ${name}`,
    wide: true,
    content: [
      h('div', { class: 'sheet-preview-wrap' }, preview),
      info,
      h('div', { class: 'row' }, field('Frame width', fw), field('Frame height', fh)),
      h('div', { class: 'row' }, field('Offset X', ox), field('Offset Y', oy), field('Gap X', gx), field('Gap Y', gy)),
      skip.el,
    ],
    buttons: [{ label: 'Cancel' }, { label: 'Import frames', primary: true, onClick: () => onImport(read()) }],
  });
}

/** Guesses a square cell size: the image height for horizontal strips, else common sprite sizes. */
function guessCell(w: number, h: number): number {
  if (w > h && w % h === 0) return h;
  if (h > w && h % w === 0) return w;
  for (const s of [64, 48, 32, 24, 16]) if (w % s === 0 && h % s === 0 && w / s <= 64) return s;
  return Math.min(w, h);
}

export function colorChip(c: RGBA): HTMLElement {
  const el = h('span', { class: 'color-chip' });
  el.style.background = toCss(c);
  return el;
}

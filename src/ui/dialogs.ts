import type { App } from '../app';
import { type RGBA, toCss } from '../core/color';
import { MAX_DIMENSION } from '../core/document';
import type { ExportFormat } from '../io/image';
import { canShareFile } from '../io/files';
import type { ProjectMeta } from '../io/storage';
import { resizeCanvas, scaleImage } from '../ops';
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
  content: 'image' | 'layer' | 'sheet';
  columns: number;
  padding: number;
  json: boolean;
  quality: number;
}

export function exportDialog(app: App, webp: boolean): void {
  const e = app.editor;
  const doc = e.doc;
  const s = app.exportSettings;
  const frames = doc.frames.length;
  const name = h('input', { type: 'text', class: 'input', value: app.exportBaseName(), 'aria-label': 'File name', spellcheck: 'false' });
  const format = selectInput(
    [
      { value: 'png', label: 'PNG (lossless)' },
      { value: 'jpeg', label: 'JPEG (no alpha)' },
      ...(webp ? [{ value: 'webp', label: 'WebP' }] : []),
    ],
    s.format === 'webp' && !webp ? 'png' : s.format,
  );
  const scale = selectInput(
    [0.25, 0.5, 1, 2, 3, 4, 5, 6, 8, 10, 12, 16].map((v) => ({ value: String(v), label: v < 1 ? `${v * 100}%` : `${v}× ${v === 1 ? '(original)' : ''}`.trim() })),
    String(s.scale),
  );
  const content = selectInput(
    [
      { value: 'image', label: frames > 1 ? 'Image (current frame)' : 'Image' },
      { value: 'layer', label: 'Active layer only' },
      ...(frames > 1 ? [{ value: 'sheet', label: `Sprite sheet (all ${frames} frames)` }] : []),
    ],
    s.content === 'sheet' && frames < 2 ? 'image' : s.content,
  );
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
    qualityField.hidden = r.format === 'png';
    const [w, hgt] = app.exportSize(r);
    info.textContent = `Output: ${w} × ${hgt} px${r.format === 'jpeg' ? ' · transparency becomes the background color' : ''}`;
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
  openDialog({
    title: 'Export image',
    content: [field('File name', name), field('Content', content), sheetBox, h('div', { class: 'row' }, field('Format', format), field('Scale', scale)), qualityField, info],
    buttons,
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
          scaleImage(doc, e.history, readNumber(w, 1, MAX_DIMENSION, doc.width), readNumber(hh, 1, MAX_DIMENSION, doc.height), mode.value as 'nearest' | 'smooth');
          e.fitView();
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
    content: [h('div', { class: 'row' }, field('Cell width', w), field('Cell height', hh)), show.el, snap.el, h('p', { class: 'field-hint' }, 'Tip: set the cell size to your tile or sprite size.')],
    buttons: [
      { label: 'Cancel' },
      {
        label: 'Apply',
        primary: true,
        onClick: () => {
          e.updateSettings({ grid: { width: readNumber(w, 1, 4096, 16), height: readNumber(hh, 1, 4096, 16), enabled: show.input.checked }, snapToGrid: snap.input.checked });
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
    'edit.undo', 'edit.redo', 'file.save', 'file.saveAs', 'file.open', 'file.export', 'edit.copy', 'edit.cut', 'edit.clear', 'select.all', 'select.none',
    'layer.new', 'layer.duplicate', 'view.zoomIn', 'view.zoomOut', 'view.fit', 'view.actual', 'view.rotateLeft', 'view.rotateRight', 'view.flip', 'view.grid',
    'view.canvasOnly', 'view.fullscreen', 'frame.prev', 'frame.next', 'colors.swap', 'colors.reset', 'tool.sizeDown', 'tool.sizeUp',
  ]) add(id);
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
    content: [h('div', { class: 'kbd-columns' }, h('div', null, h('h3', { class: 'dialog-section' }, 'Tools'), tools), h('div', null, h('h3', { class: 'dialog-section' }, 'Commands'), general)), h('h3', { class: 'dialog-section' }, 'Mouse, pen & touch'), gestures],
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
    buttons: [{ label: 'New image…', onClick: () => app.showNewDialog() }, { label: 'Open file…', onClick: () => void app.open() }, { label: 'Close', primary: true }],
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
      const open = h('button', { type: 'button', class: 'project-open' }, thumb, h('span', { class: 'project-name' }, p.name), h('span', { class: 'project-meta' }, `${p.width}×${p.height} · ${p.layers} layer${p.layers === 1 ? '' : 's'}${p.frames > 1 ? ` · ${p.frames} frames` : ''} · ${new Date(p.modified).toLocaleString()}`));
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
export function spriteSheetDialog(_app: App, name: string, img: { width: number; height: number; data: Uint8ClampedArray }, onImport: (s: SheetSlice) => void): void {
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

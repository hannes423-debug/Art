import type { App } from '../app';
import { type RGBA, colorsEqual, parseHex, toCss, toHex } from '../core/color';
import { PALETTE_PRESETS, type PaletteCategory, presetColors, quantizeRGB555 } from '../core/palette';
import type { PaletteRef } from '../editor';
import { countOffPalette } from '../ops';
import { checkbox, confirmDialog, openDialog, promptDialog } from './dialog';
import { h, icon } from './dom';
import { type PopupItem, popupMenu } from './menu';

/** Small non-interactive strip of a palette's colors. */
function strip(colors: RGBA[], max = 64): HTMLElement {
  const el = h('span', { class: 'pal-strip', 'aria-hidden': 'true' });
  for (const c of colors.slice(0, max)) {
    const s = h('span', { class: 'pal-chip' });
    s.style.background = toCss(c);
    el.append(s);
  }
  return el;
}

function sameRef(a: PaletteRef, b: PaletteRef): boolean {
  return !!a && !!b && a.kind === b.kind && a.id === b.id;
}

/** The palettes the quick switcher offers: saved ones first, then the built-ins. */
export function paletteSwitchItems(app: App): (PopupItem | '-')[] {
  const e = app.editor;
  const cur = e.paletteRef;
  const items: (PopupItem | '-')[] = [];
  for (const p of e.customPalettes) {
    items.push({
      label: `${p.name} (${p.colors.length})`,
      checked: sameRef(cur, { kind: 'custom', id: p.id }),
      run: () => selectAndCheck(app, { kind: 'custom', id: p.id }),
    });
  }
  if (items.length) items.push('-');
  for (const p of PALETTE_PRESETS) {
    items.push({
      label: `${p.name} (${p.colors.length})`,
      checked: sameRef(cur, { kind: 'builtin', id: p.id }),
      run: () => selectAndCheck(app, { kind: 'builtin', id: p.id }),
    });
  }
  items.push('-', { label: 'Manage palettes…', run: () => paletteBrowserDialog(app) });
  return items;
}

/**
 * Selects a palette. If the image has colors outside it, says so and
 * offers to map them (nothing changes in the image until the user asks).
 */
function selectAndCheck(app: App, ref: Exclude<PaletteRef, null>): number {
  const e = app.editor;
  e.selectPalette(ref);
  const off = countOffPalette(e.doc, e.palette, 1000);
  if (off)
    e.toast(
      `${off >= 1000 ? 'Many' : off} color${off === 1 ? '' : 's'} in the image ${off === 1 ? 'is' : 'are'} not in “${e.paletteName}”. Image → Map colors to palette… converts them.`,
    );
  return off;
}

/**
 * Palette browser: pick a built-in or saved palette, create, import, copy,
 * rename, edit and delete saved palettes. Works with touch (no hover needed)
 * and scrolls inside the dialog on small screens.
 */
export function paletteBrowserDialog(app: App): void {
  const e = app.editor;
  const body = h('div', { class: 'pal-browser' });
  const notice = h('div', { class: 'pal-notice', role: 'status' });
  const lock = checkbox('Lock painting to the selected palette', e.settings.paletteLock);
  lock.input.addEventListener('change', () => e.setPaletteLock(lock.input.checked));

  const row = (opts: { ref: PaletteRef; name: string; colors: RGBA[]; note?: string; actions?: HTMLElement[]; onSelect: () => void }) => {
    const active = opts.ref ? sameRef(e.paletteRef, opts.ref) : !e.paletteRef;
    const pick = h(
      'button',
      { type: 'button', class: 'pal-pick', 'aria-pressed': String(active), title: `Use ${opts.name}` },
      h('span', { class: 'pal-name' }, opts.name, h('span', { class: 'pal-count' }, `${opts.colors.length} color${opts.colors.length === 1 ? '' : 's'}`)),
      strip(opts.colors),
      opts.note ? h('span', { class: 'pal-note' }, opts.note) : null,
    );
    pick.addEventListener('click', opts.onSelect);
    return h(
      'div',
      { class: `pal-row ${active ? 'active' : ''}`.trim() },
      pick,
      opts.actions?.length ? h('div', { class: 'pal-actions' }, ...opts.actions) : null,
    );
  };
  const btn = (label: string, title: string, fn: () => void, cls = '') => {
    const b = h('button', { type: 'button', class: `btn small ${cls}`.trim(), title }, label);
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      fn();
    });
    return b;
  };

  const showNotice = (off: number) => {
    notice.replaceChildren();
    if (!off) return;
    const map = btn('Map colors…', 'Convert the image colors to this palette (you can keep the original)', () => {
      handle.close();
      app.showMapToPalette();
    });
    notice.append(
      h(
        'span',
        null,
        `${off >= 1000 ? 'Many' : off} color${off === 1 ? '' : 's'} in the image ${off === 1 ? 'is' : 'are'} not in “${e.paletteName}”. The image is unchanged until you map it.`,
      ),
      map,
    );
  };
  const choose = (ref: Exclude<PaletteRef, null>) => {
    e.selectPalette(ref);
    render();
    showNotice(countOffPalette(e.doc, e.palette, 1000));
  };

  const render = () => {
    body.replaceChildren();
    // Current, unsaved palette (edited built-in or loaded with a project).
    if (!e.paletteRef) {
      body.append(
        h('h3', { class: 'dialog-section' }, 'Current palette (not saved)'),
        row({
          ref: null,
          name: e.paletteName,
          colors: e.palette,
          onSelect: () => {},
          actions: [btn('Save as my palette', 'Keep these colors in “My palettes”', () => void saveCurrent())],
        }),
      );
    }
    body.append(
      h(
        'div',
        { class: 'pal-section-head' },
        h('h3', { class: 'dialog-section' }, 'My palettes'),
        btn('New…', 'Create an empty palette, or one from the current colors', () => void createNew()),
        btn('Import…', 'Import a .gpl, .hex, .txt or .pal file', () => void app.importPaletteFile().then(render)),
      ),
    );
    if (!e.customPalettes.length) body.append(h('p', { class: 'field-hint' }, 'Palettes you create, import or copy appear here, saved in this browser.'));
    for (const p of e.customPalettes) {
      const ref = { kind: 'custom' as const, id: p.id };
      const more = h('button', { type: 'button', class: 'icon-btn small', title: `More for ${p.name}`, 'aria-label': `More for ${p.name}` }, icon('more', 16));
      more.addEventListener('click', (ev) => {
        ev.stopPropagation();
        popupMenu(more, [
          { label: 'Rename…', run: () => void rename(p.id, p.name) },
          { label: 'Duplicate', run: () => duplicate(p.name, p.colors) },
          { label: 'Export as .gpl', run: () => void app.exportPaletteColors(p.name, p.colors, 'gpl') },
          { label: 'Export as .hex', run: () => void app.exportPaletteColors(p.name, p.colors, 'hex') },
          '-',
          { label: 'Delete palette', danger: true, run: () => void remove(p.id, p.name) },
        ]);
      });
      body.append(
        row({
          ref,
          name: p.name,
          colors: p.colors,
          onSelect: () => choose(ref),
          actions: [btn('Edit', `Edit ${p.name}`, () => paletteEditorDialog(app, p.id, render)), more],
        }),
      );
    }
    const cats: PaletteCategory[] = ['Consoles', 'Artist palettes', 'Computers', 'Basic'];
    for (const cat of cats) {
      body.append(h('h3', { class: 'dialog-section' }, cat));
      for (const p of PALETTE_PRESETS.filter((x) => x.category === cat)) {
        const ref = { kind: 'builtin' as const, id: p.id };
        body.append(
          row({
            ref,
            name: p.name,
            colors: presetColors(p.id),
            note: p.note,
            onSelect: () => choose(ref),
            actions: [btn('Copy', `Copy ${p.name} to My palettes to edit it`, () => duplicate(p.name, presetColors(p.id)))],
          }),
        );
      }
    }
  };

  const saveCurrent = async () => {
    const name = await promptDialog('Save palette', 'Name', e.paletteName.replace(/ \(edited\)$/, ''), 'Save');
    if (name === null) return;
    e.createCustomPalette(name, e.palette);
    render();
  };
  const createNew = async () => {
    const name = await promptDialog('New palette', 'Name', `My palette ${e.customPalettes.length + 1}`, 'Create');
    if (name === null) return;
    const fromCurrent = await confirmDialog(
      'New palette',
      `Start “${name.trim() || 'My palette'}” with the ${e.palette.length} colors of the current palette?`,
      'Use current colors',
    );
    const p = e.createCustomPalette(name, fromCurrent ? e.palette : [{ ...e.fg }]);
    render();
    paletteEditorDialog(app, p.id, render);
  };
  const duplicate = (name: string, colors: RGBA[]) => {
    e.createCustomPalette(`${name} copy`, colors);
    render();
  };
  const rename = async (id: string, name: string) => {
    const v = await promptDialog('Rename palette', 'Name', name, 'Rename');
    if (v !== null && v.trim()) e.updateCustomPalette(id, { name: v });
    render();
  };
  const remove = async (id: string, name: string) => {
    if (!(await confirmDialog('Delete palette?', `“${name}” will be removed from My palettes. Images are not changed.`, 'Delete', true))) return;
    e.deleteCustomPalette(id);
    render();
  };

  render();
  const handle = openDialog({
    title: 'Palettes',
    wide: true,
    className: 'pal-dialog',
    content: [lock.el, notice, body],
    buttons: [{ label: 'Done', primary: true }],
  });
  // Bring the selected palette into view.
  requestAnimationFrame(() => body.querySelector('.pal-row.active')?.scrollIntoView({ block: 'nearest' }));
}

/**
 * Edits a saved palette: tap a color to select it, then change it, move
 * it, or remove it; add the foreground color or a new color. Changes are
 * saved immediately (and apply to the working palette if it is this one).
 */
export function paletteEditorDialog(app: App, id: string, onChange: () => void = () => {}): void {
  const e = app.editor;
  const pal = e.customPalettes.find((p) => p.id === id);
  if (!pal) return;
  let colors = pal.colors.map((c) => ({ ...c }));
  let sel = colors.length ? 0 : -1;
  const name = h('input', { type: 'text', class: 'input', value: pal.name, 'aria-label': 'Palette name', maxlength: '64', spellcheck: 'false' });
  const grid = h('div', { class: 'pal-edit-grid', role: 'listbox', 'aria-label': 'Palette colors' });
  const hex = h('input', { type: 'text', class: 'input mono pal-hex', 'aria-label': 'Selected color (hex)', maxlength: '9', spellcheck: 'false' });
  const preview = h('span', { class: 'color-chip pal-sel-chip' });
  const count = h('span', { class: 'pal-count' });
  const save = () => {
    e.updateCustomPalette(id, { colors });
    onChange();
  };
  const ctl = (label: string, title: string, fn: () => void) => {
    const b = h('button', { type: 'button', class: 'btn small', title }, label);
    b.addEventListener('click', () => {
      fn();
      render();
    });
    return b;
  };
  const left = ctl('◀ Move', 'Move the selected color earlier', () => {
    if (sel <= 0) return;
    [colors[sel - 1], colors[sel]] = [colors[sel], colors[sel - 1]];
    sel--;
    save();
  });
  const right = ctl('Move ▶', 'Move the selected color later', () => {
    if (sel < 0 || sel >= colors.length - 1) return;
    [colors[sel + 1], colors[sel]] = [colors[sel], colors[sel + 1]];
    sel++;
    save();
  });
  const useFg = ctl('Set to FG', 'Replace the selected color with the foreground color', () => {
    if (sel < 0) return;
    colors[sel] = { ...e.fg };
    save();
  });
  const del = ctl('Remove', 'Remove the selected color', () => {
    if (sel < 0) return;
    colors.splice(sel, 1);
    sel = Math.min(sel, colors.length - 1);
    save();
  });
  const addFg = ctl('+ Add FG', 'Add the foreground color', () => {
    if (colors.some((c) => colorsEqual(c, e.fg))) {
      e.toast('That color is already in the palette');
      sel = colors.findIndex((c) => colorsEqual(c, e.fg));
      return;
    }
    colors.push({ ...e.fg });
    sel = colors.length - 1;
    save();
  });
  const snap = ctl('15-bit', 'Round every color to 15-bit RGB555 (what the GBA and SNES can show)', () => {
    colors = colors.map((c) => ({ ...parseHex(quantizeRGB555(toHex(c, false)))!, a: c.a }));
    save();
  });
  const sort = ctl('Sort', 'Sort colors from dark to light', () => {
    const cur = sel >= 0 ? colors[sel] : null;
    const lum = (c: RGBA) => 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
    colors.sort((a, b) => lum(a) - lum(b));
    sel = cur ? colors.indexOf(cur) : -1;
    save();
  });
  hex.addEventListener('input', () => {
    const c = parseHex(hex.value);
    hex.classList.toggle('invalid', !c);
    if (!c || sel < 0) return;
    colors[sel] = c;
    preview.style.background = toCss(c);
    const sw = grid.children[sel] as HTMLElement | undefined;
    sw?.style.setProperty('--c', toCss(c));
    save();
  });
  name.addEventListener('change', () => {
    e.updateCustomPalette(id, { name: name.value });
    onChange();
  });

  const render = () => {
    grid.replaceChildren(
      ...colors.map((c, i) => {
        const b = h('button', {
          type: 'button',
          class: `swatch ${i === sel ? 'selected' : ''}`.trim(),
          role: 'option',
          'aria-selected': String(i === sel),
          title: toHex(c),
          'aria-label': `Color ${i + 1}: ${toHex(c)}`,
        });
        b.style.setProperty('--c', toCss(c));
        b.addEventListener('click', () => {
          sel = i;
          render();
        });
        // Double-tap / double-click paints with it.
        b.addEventListener('dblclick', () => e.setColor('fg', c));
        return b;
      }),
    );
    const c = sel >= 0 ? colors[sel] : null;
    hex.value = c ? toHex(c) : '';
    hex.disabled = !c;
    preview.style.background = c ? toCss(c) : 'transparent';
    for (const b of [left, right, useFg, del]) b.disabled = !c;
    left.disabled ||= sel === 0;
    right.disabled ||= sel === colors.length - 1;
    count.textContent = `${colors.length} color${colors.length === 1 ? '' : 's'}`;
  };
  render();
  openDialog({
    title: 'Edit palette',
    className: 'pal-dialog',
    content: [
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Name'), name),
      h('div', { class: 'pal-edit-head' }, count, h('span', { class: 'field-hint' }, 'Tap a color to select it. Double-tap to paint with it.')),
      grid,
      h('div', { class: 'pal-edit-sel' }, preview, hex, useFg),
      h('div', { class: 'pal-edit-tools' }, left, right, del, addFg, sort, snap),
    ],
    buttons: [{ label: 'Done', primary: true }],
  });
}

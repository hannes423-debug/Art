import { BLACK, type RGBA, WHITE, colorsEqual, parseHex, toHex } from './core/color';
import { ArtDocument } from './core/document';
import { Emitter } from './core/emitter';
import { History } from './core/history';
import { type PaintParams, PaintSession } from './core/paint';
import { PALETTE_PRESETS, findPreset, nearestColorFinder, presetColors } from './core/palette';
import type { SelectionMode, SelectionModify } from './core/selection';
import { type ClipImage, addLayer, changeSelection, clearPixels, copyPixels } from './ops';
import { Renderer } from './render/renderer';
import { Viewport } from './render/viewport';
import { type Settings, loadState, saveState } from './settings';
import { MoveSession } from './tools/move-session';
import { EllipseSelectTool, FillTool, HandTool, LassoTool, MoveTool, PickerTool, RectSelectTool, WandTool } from './tools/other-tools';
import { GradientTool, ShadeTool, TextTool } from './tools/extra-tools';
import { BrushTool, EraserTool, PencilTool, type SymmetryAxes } from './tools/paint-tools';
import { EllipseTool, LineTool, RectTool } from './tools/shape-tools';
import type { Tool, ToolId, ToolOptions } from './tools/tool';

/** A palette the user saved (stored in the browser). */
export interface CustomPalette {
  id: string;
  name: string;
  colors: RGBA[];
}

/** Where the working palette comes from; null = edited or loaded with a project. */
export type PaletteRef = { kind: 'builtin' | 'custom'; id: string } | null;

export interface EditorEvents {
  /** A different document was loaded. */
  document: void;
  tool: void;
  colors: void;
  options: void;
  settings: void;
  /** Zoom, pan or rotation changed. */
  view: void;
  /** Pointer position in document coordinates (null when outside). */
  pointer: { x: number; y: number } | null;
  /** Transient status text (shape size, move offset...). */
  hint: string;
  palette: void;
  toast: { message: string; error: boolean };
  /** The document was modified or saved (drives title/autosave). */
  modified: void;
  playback: void;
  /** Symmetry mode or axis changed outside the options bar (menu, shortcut, dialog). */
  symmetry: void;
}

/** Where the current document lives, beyond this browser tab. */
export interface DocumentInfo {
  /** Id in the local project library (IndexedDB), once saved there. */
  projectId: string | null;
  /** .artproj file handle (File System Access API), for Save. */
  projectHandle: FileSystemFileHandle | null;
  /** Image file handle, for quick re-export to the same file. */
  imageHandle: FileSystemFileHandle | null;
}

/**
 * Application state and the operations the UI calls. Owns the document,
 * history, view, renderer and tools. UI components subscribe to events and
 * update only what changed.
 */
export class Editor extends Emitter<EditorEvents> {
  doc!: ArtDocument;
  info: DocumentInfo = { projectId: null, projectHandle: null, imageHandle: null };
  readonly history: History;
  readonly view = new Viewport();
  readonly renderer: Renderer;
  readonly tools: Record<ToolId, Tool>;
  tool!: Tool;
  fg: RGBA = { ...BLACK };
  bg: RGBA = { ...WHITE };
  palette: RGBA[];
  /** Name of the working palette (shown in the palette panel). */
  paletteName = 'DawnBringer 32';
  paletteRef: PaletteRef = { kind: 'builtin', id: 'db32' };
  customPalettes: CustomPalette[] = [];
  recent: RGBA[] = [];
  options: ToolOptions;
  settings: Settings;
  /** Active floating selection (move/paste) not yet anchored. */
  floating: MoveSession | null = null;
  /** End of the last freehand stroke, for Shift+click straight lines. */
  lastStrokeEnd: { x: number; y: number } | null = null;
  clipboard: ClipImage | null = null;
  /** history.version when the document was last saved. */
  savedVersion = 0;
  /** Changes that bypass history (e.g. visibility) since the last save. */
  untrackedChanges = 0;
  playing = false;
  private playTimer = 0;
  private persistTimer = 0;

  constructor(canvas: HTMLCanvasElement) {
    super();
    const state = loadState();
    this.settings = state.settings;
    this.options = state.options;
    if (state.fg) this.fg = parseHex(state.fg) ?? this.fg;
    if (state.bg) this.bg = parseHex(state.bg) ?? this.bg;
    this.palette = state.palette?.map((h) => parseHex(h)).filter((c): c is RGBA => !!c) ?? presetColors('db32');
    const hexes = (list: string[]) => list.map((h) => parseHex(h)).filter((c): c is RGBA => !!c);
    this.customPalettes = (state.customPalettes ?? []).map((p) => ({ id: p.id, name: p.name, colors: hexes(p.colors) }));
    if (state.paletteName !== undefined) this.paletteName = state.paletteName;
    else if (state.palette) this.paletteName = 'Palette'; // saved by an older version: unknown origin
    if (state.paletteRef !== undefined) this.paletteRef = parseRef(state.paletteRef);
    else if (state.palette) this.paletteRef = null;
    this.recent = state.recent?.map((h) => parseHex(h)).filter((c): c is RGBA => !!c) ?? [];

    const lowMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
    this.history = new History(200, lowMemory && lowMemory <= 4 ? 128 * 1024 * 1024 : 384 * 1024 * 1024);
    this.history.beforeChange = () => this.commitFloating();
    this.history.on('change', () => this.emit('modified'));

    this.renderer = new Renderer(canvas, this.view, this.settings);
    this.tools = {
      brush: new BrushTool(this),
      pencil: new PencilTool(this),
      eraser: new EraserTool(this),
      shade: new ShadeTool(this),
      line: new LineTool(this),
      rect: new RectTool(this),
      ellipse: new EllipseTool(this),
      fill: new FillTool(this),
      gradient: new GradientTool(this),
      text: new TextTool(this),
      picker: new PickerTool(this),
      'select-rect': new RectSelectTool(this),
      'select-ellipse': new EllipseSelectTool(this),
      lasso: new LassoTool(this),
      wand: new WandTool(this),
      move: new MoveTool(this),
      hand: new HandTool(this),
    };
    this.tool = this.tools[state.tool && state.tool in this.tools ? state.tool : 'pencil'];
    this.renderer.overlays.push({ drawOverlay: (ctx, view) => this.drawSymmetryAxes(ctx, view) });
    this.renderer.overlays.push({ drawOverlay: (ctx, view) => this.tool.drawOverlay(ctx, view) });
    this.setDocument(ArtDocument.createBlank(64, 64));
  }

  // ------------------------------------------------------------ Document

  get modified(): boolean {
    return this.history.version !== this.savedVersion || this.untrackedChanges > 0;
  }

  markSaved(): void {
    this.savedVersion = this.history.version;
    this.untrackedChanges = 0;
    this.emit('modified');
  }

  /** Records a change that is not part of undo history (still needs saving). */
  markChanged(): void {
    this.untrackedChanges++;
    this.emit('modified');
  }

  setDocument(doc: ArtDocument, info: Partial<DocumentInfo> = {}): void {
    if (this.tool?.busy) this.tool.cancel();
    this.stop();
    this.floating = null;
    const old = this.doc;
    this.doc = doc;
    this.info = { projectId: null, projectHandle: null, imageHandle: null, ...info };
    this.history.clear();
    this.savedVersion = this.history.version;
    this.untrackedChanges = 0;
    this.lastStrokeEnd = null;
    this.renderer.setDocument(doc);
    old?.dispose();
    this.fitView();
    this.emit('document');
    this.emit('modified');
  }

  // ---------------------------------------------------------------- Tools

  setTool(id: ToolId): void {
    if (this.tool.id === id) return;
    if (this.tool.busy) this.tool.cancel();
    this.tool.deactivate();
    this.tool = this.tools[id];
    this.tool.activate();
    this.setStatusHint('');
    this.emit('tool');
    this.renderer.requestRender();
    this.persist();
  }

  setOption(key: string, field: string, value: unknown): void {
    const group = (this.options as unknown as Record<string, Record<string, unknown>>)[key];
    if (!group || group[field] === value) return;
    group[field] = value;
    this.emit('options');
    this.renderer.requestRender();
    this.persist();
  }

  updateSettings(patch: Partial<Settings>): void {
    Object.assign(this.settings, patch);
    this.renderer.invalidateAll();
    this.emit('settings');
    this.persist();
  }

  gridSnap(): { w: number; h: number } | null {
    const g = this.settings.grid;
    return this.settings.snapToGrid && g.width > 0 && g.height > 0 ? { w: g.width, h: g.height } : null;
  }

  // --------------------------------------------------------------- Colors

  setColor(which: 'fg' | 'bg', c: RGBA): void {
    this[which] = this.snapColor(c);
    this.emit('colors');
    this.persist();
  }

  swapColors(): void {
    [this.fg, this.bg] = [this.bg, this.fg];
    this.emit('colors');
    this.persist();
  }

  resetColors(): void {
    this.fg = { ...BLACK };
    this.bg = { ...WHITE };
    this.emit('colors');
    this.persist();
  }

  addRecent(c: RGBA): void {
    if (this.recent[0] && colorsEqual(this.recent[0], c)) return;
    this.recent = [c, ...this.recent.filter((r) => !colorsEqual(r, c))].slice(0, 16);
    this.emit('palette');
    this.persist();
  }

  /**
   * Changes the colors of the working palette. A custom palette is updated
   * too; a built-in one becomes an edited copy (built-ins never change).
   * `name` starts a new, unsaved palette (e.g. one loaded with a project).
   */
  setPalette(colors: RGBA[], name?: string): void {
    this.palette = colors.map((c) => ({ ...c }));
    this.snapFinder = null;
    const ref = this.paletteRef;
    if (name !== undefined) {
      this.paletteName = name;
      this.paletteRef = null;
    } else if (ref?.kind === 'custom') {
      const p = this.customPalettes.find((x) => x.id === ref.id);
      if (p) p.colors = this.palette.map((c) => ({ ...c }));
      else this.paletteRef = null;
    } else if (ref?.kind === 'builtin') {
      this.paletteRef = null;
      this.paletteName = `${this.paletteName} (edited)`;
    }
    this.emit('palette');
    this.persist();
  }

  /**
   * Uses colors loaded with a project: re-selects the built-in or saved
   * palette with exactly these colors (preferring one with the same name),
   * otherwise keeps them as an unsaved palette called `name`.
   */
  adoptPalette(colors: RGBA[], name: string): void {
    const key = (list: RGBA[]) => list.map((c) => toHex(c, true)).join(',');
    const k = key(colors);
    const candidates: { ref: Exclude<PaletteRef, null>; name: string }[] = [
      ...this.customPalettes.filter((p) => key(p.colors) === k).map((p) => ({ ref: { kind: 'custom' as const, id: p.id }, name: p.name })),
      ...PALETTE_PRESETS.filter((p) => key(presetColors(p.id)) === k).map((p) => ({ ref: { kind: 'builtin' as const, id: p.id }, name: p.name })),
    ];
    const hit = candidates.find((c) => c.name === name) ?? candidates[0];
    if (hit) this.selectPalette(hit.ref);
    else this.setPalette(colors, name);
  }

  /** Makes a built-in or saved palette the working palette. */
  selectPalette(ref: Exclude<PaletteRef, null>): boolean {
    if (ref.kind === 'builtin') {
      const p = findPreset(ref.id);
      if (!p) return false;
      this.palette = presetColors(p.id);
      this.paletteName = p.name;
    } else {
      const p = this.customPalettes.find((x) => x.id === ref.id);
      if (!p) return false;
      this.palette = p.colors.map((c) => ({ ...c }));
      this.paletteName = p.name;
    }
    this.paletteRef = ref;
    this.snapFinder = null;
    if (this.settings.paletteLock) {
      this.fg = this.snapColor(this.fg);
      this.bg = this.snapColor(this.bg);
      this.emit('colors');
    }
    this.emit('palette');
    this.persist();
    return true;
  }

  /** Saves colors as a new custom palette and makes it the working palette. */
  createCustomPalette(name: string, colors: RGBA[]): CustomPalette {
    const ids = new Set(this.customPalettes.map((p) => p.id));
    let id = `p${Date.now().toString(36)}`;
    while (ids.has(id)) id += 'x';
    const p: CustomPalette = { id, name: name.trim() || 'My palette', colors: colors.map((c) => ({ ...c })) };
    this.customPalettes = [...this.customPalettes, p];
    this.selectPalette({ kind: 'custom', id });
    return p;
  }

  updateCustomPalette(id: string, patch: { name?: string; colors?: RGBA[] }): void {
    const p = this.customPalettes.find((x) => x.id === id);
    if (!p) return;
    if (patch.name !== undefined) p.name = patch.name.trim() || p.name;
    if (patch.colors) p.colors = patch.colors.map((c) => ({ ...c }));
    if (this.paletteRef?.kind === 'custom' && this.paletteRef.id === id) {
      this.palette = p.colors.map((c) => ({ ...c }));
      this.paletteName = p.name;
      this.snapFinder = null;
    }
    this.emit('palette');
    this.persist();
  }

  /** Deletes a saved palette. If it is in use, its colors stay as an unsaved palette. */
  deleteCustomPalette(id: string): void {
    this.customPalettes = this.customPalettes.filter((p) => p.id !== id);
    if (this.paletteRef?.kind === 'custom' && this.paletteRef.id === id) this.paletteRef = null;
    this.emit('palette');
    this.persist();
  }

  // --------------------------------------------------------- Palette lock

  private snapFinder: ((r: number, g: number, b: number) => number) | null = null;

  /** Nearest-palette mapping while palette lock is on (null otherwise or with an empty palette). */
  paletteSnap(): ((r: number, g: number, b: number) => number) | null {
    if (!this.settings.paletteLock || !this.palette.length) return null;
    if (!this.snapFinder) this.snapFinder = nearestColorFinder(this.palette);
    return this.snapFinder;
  }

  /** The color itself, or its nearest palette color (same alpha) while palette lock is on. */
  snapColor(c: RGBA): RGBA {
    const snap = this.paletteSnap();
    if (!snap) return { ...c };
    const p = snap(c.r, c.g, c.b);
    return { r: p >> 16, g: (p >> 8) & 255, b: p & 255, a: c.a };
  }

  setPaletteLock(on: boolean): void {
    this.updateSettings({ paletteLock: on });
    if (on) {
      if (!this.palette.length) this.toast('The palette is empty: add colors to lock to.');
      this.fg = this.snapColor(this.fg);
      this.bg = this.snapColor(this.bg);
      this.emit('colors');
    }
  }

  // ------------------------------------------------------------- Painting

  /** Checks the active layer can be edited, telling the user why not. */
  canEditPixels(): boolean {
    if (!this.doc.activeLayer.visible) {
      this.toast('The active layer is hidden. Show it to edit.');
      return false;
    }
    const group = this.doc.groupOf(this.doc.activeLayer);
    if (group && !group.visible) {
      this.toast(`The group “${group.name}” is hidden. Show it to edit.`);
      return false;
    }
    return true;
  }

  beginPaint(params: PaintParams): PaintSession {
    this.commitFloating();
    this.stop();
    const snap = params.mode === 'paint' ? this.paletteSnap() : null;
    const session = new PaintSession(this.doc, this.doc.activeCel, snap ? { ...params, snap } : params);
    const t = this.tileWrap();
    session.wrapX = t.x;
    session.wrapY = t.y;
    return session;
  }

  // ------------------------------------------------- Symmetry & tile mode

  /** Directions in which tile mode repeats the image (and wraps drawing). */
  tileWrap(): { x: boolean; y: boolean } {
    const m = this.settings.tileMode;
    return { x: m === 'both' || m === 'x', y: m === 'both' || m === 'y' };
  }

  /** Maps a point in a neighbouring tile back onto the canvas (tile mode only). */
  wrapPoint(x: number, y: number): { x: number; y: number } {
    const t = this.tileWrap();
    const { width: w, height: h } = this.doc;
    return { x: t.x ? x - Math.floor(x / w) * w : x, y: t.y ? y - Math.floor(y / h) * h : y };
  }

  /** Axis position in pixels (on a half-pixel step); -1 or out of range = canvas center. */
  private axisPos(v: number, size: number): number {
    if (!(v >= 0 && v <= size)) return size / 2;
    return Math.round(v * 2) / 2;
  }

  /** Freehand tools mirror their strokes when symmetry is on. */
  toolUsesSymmetry(id: ToolId = this.tool.id): boolean {
    return id === 'brush' || id === 'pencil' || id === 'eraser' || id === 'shade';
  }

  /** Active mirror axes for freehand tools, or null when symmetry is off. */
  symmetryAxes(): SymmetryAxes | null {
    const s = this.options.symmetry;
    if (s.mode !== 'x' && s.mode !== 'y' && s.mode !== 'xy') return null;
    return {
      x: s.mode !== 'y' ? this.axisPos(s.x, this.doc.width) : null,
      y: s.mode !== 'x' ? this.axisPos(s.y, this.doc.height) : null,
    };
  }

  setSymmetry(patch: Partial<ToolOptions['symmetry']>): void {
    Object.assign(this.options.symmetry, patch);
    this.emit('options');
    this.emit('symmetry');
    this.renderer.requestRender();
    this.persist();
  }

  private drawSymmetryAxes(ctx: CanvasRenderingContext2D, view: Viewport): void {
    const axes = this.symmetryAxes();
    if (!axes || !this.toolUsesSymmetry()) return;
    const { width: w, height: h } = this.doc;
    const lines: [number, number, number, number][] = [];
    if (axes.x !== null) lines.push([axes.x, 0, axes.x, h]);
    if (axes.y !== null) lines.push([0, axes.y, w, axes.y]);
    ctx.beginPath();
    for (const [x0, y0, x1, y1] of lines) {
      const a = view.docToScreen(x0, y0);
      const b = view.docToScreen(x1, y1);
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = '#ff5ad1';
    ctx.stroke();
    ctx.setLineDash([]);
  }

  commitPaint(session: PaintSession, label: string): void {
    const patch = session.commit(label);
    if (!patch) return;
    this.history.push(patch);
    if (session.params.mode === 'paint') this.addRecent(session.params.color);
  }

  // ------------------------------------------------------------ Selection

  applySelection(mask: Uint8Array, hint: { x: number; y: number; w: number; h: number } | null, mode: SelectionMode, label: string): void {
    this.commitFloating();
    changeSelection(this.doc, this.history, label, () => this.doc.selection.combine(mask, hint, mode));
  }

  selectAll(): void {
    this.commitFloating();
    changeSelection(this.doc, this.history, 'Select all', () => this.doc.selection.selectAll());
  }

  deselect(): void {
    this.commitFloating();
    if (!this.doc.selection.active) return;
    changeSelection(this.doc, this.history, 'Deselect', () => this.doc.selection.clear());
  }

  invertSelection(): void {
    this.commitFloating();
    changeSelection(this.doc, this.history, 'Invert selection', () => this.doc.selection.invert());
  }

  /** Grows, shrinks or borders the selection as one undo step. */
  modifySelection(m: SelectionModify): void {
    this.commitFloating();
    if (!this.doc.selection.active) return;
    const labels = { grow: 'Grow selection', shrink: 'Shrink selection', border: 'Border selection', feather: 'Feather selection' };
    changeSelection(this.doc, this.history, labels[m.kind], () => this.doc.selection.modify(m));
    if (!this.doc.selection.active) this.toast('The selection is now empty');
  }

  // ------------------------------------------------- Floating & clipboard

  /** Anchors a floating selection (moved or pasted pixels), recording one undo step. */
  commitFloating(): void {
    const f = this.floating;
    if (!f) return;
    this.floating = null;
    const cmd = f.commit();
    if (cmd) this.history.push(cmd);
    this.setStatusHint('');
  }

  /** The floating pixels on the active cel, lifting the selection (or layer) if needed. */
  liftFloating(): MoveSession | null {
    const cel = this.doc.activeCel;
    if (this.floating && this.floating.surface === cel) return this.floating;
    this.commitFloating();
    if (!this.canEditPixels()) return null;
    const s = MoveSession.lift(this.doc, cel);
    if (!s) {
      this.toast('Nothing to move on this layer');
      return null;
    }
    this.floating = s;
    this.emit('modified');
    return s;
  }

  /** Free transform: float the selection with scale and rotate handles (Move tool). */
  startTransform(): void {
    if (this.tool.id !== 'move') this.setTool('move');
    if (this.liftFloating()) {
      this.setStatusHint('Drag the handles to scale or rotate · Shift keeps proportions / snaps 15° · Enter applies');
      this.renderer.requestRender();
    }
  }

  cancelFloating(): void {
    const f = this.floating;
    if (!f) return;
    this.floating = null;
    f.cancel();
    this.setStatusHint('');
  }

  copy(merged = false): ClipImage | null {
    this.commitFloating();
    const clip = copyPixels(this.doc, merged);
    if (clip) this.clipboard = clip;
    return clip;
  }

  cut(): ClipImage | null {
    if (!this.canEditPixels()) return null;
    const clip = this.copy(false);
    if (clip) clearPixels(this.doc, this.history);
    return clip;
  }

  /** Pastes pixels as a floating selection on the active (or a new) layer, ready to move. */
  paste(img: ClipImage, asNewLayer = false, layerName?: string, keepPosition = false): void {
    this.commitFloating();
    this.stop();
    const doc = this.doc;
    if (asNewLayer) {
      const layer = addLayer(doc, this.history, undefined, undefined, layerName ? 'Import layer' : 'Paste as new layer');
      if (layerName) {
        layer.name = layerName;
        doc.notifyLayers();
      }
    }
    if (!this.canEditPixels()) return;
    let { x, y } = img;
    const fits = x >= 0 && y >= 0 && x + img.width <= doc.width && y + img.height <= doc.height;
    if (!fits && !keepPosition) {
      // Center on the visible part of the canvas.
      const c = this.view.screenToDoc(this.view.width / 2, this.view.height / 2);
      x = Math.round(Math.max(0, Math.min(doc.width - 1, c.x)) - img.width / 2);
      y = Math.round(Math.max(0, Math.min(doc.height - 1, c.y)) - img.height / 2);
    }
    this.setTool('move');
    this.floating = MoveSession.paste(doc, doc.activeCel, img.width, img.height, img.data.slice(), x, y);
    this.setStatusHint('Drag to position · Enter to apply · Esc to cancel');
  }

  // ---------------------------------------------------------------- View

  viewChanged(): void {
    this.renderer.requestRender();
    this.emit('view');
  }

  fitView(): void {
    this.view.fit(this.doc.width, this.doc.height);
    this.viewChanged();
  }

  actualPixels(): void {
    this.view.actualPixels(this.doc.width, this.doc.height);
    this.viewChanged();
  }

  zoomBy(direction: 1 | -1): void {
    this.view.stepZoom(this.view.width / 2, this.view.height / 2, direction);
    this.viewChanged();
  }

  rotateViewBy(degrees: number): void {
    this.view.rotateAt(this.view.width / 2, this.view.height / 2, (degrees * Math.PI) / 180);
    this.viewChanged();
  }

  resetRotation(): void {
    this.view.setRotation(0);
    this.viewChanged();
  }

  flipView(): void {
    this.view.toggleFlip();
    this.viewChanged();
  }

  // ------------------------------------------------------------ Playback

  /** Frame order for playback: the tag around the active frame (with its direction), or every frame. */
  playbackOrder(): number[] {
    const doc = this.doc;
    const tag = doc.tagAt(doc.activeFrame);
    const from = tag ? tag.from : 0;
    const to = tag ? tag.to : doc.frames.length - 1;
    const fwd: number[] = [];
    for (let i = from; i <= to; i++) fwd.push(i);
    if (!tag || tag.direction === 'forward') return fwd;
    if (tag.direction === 'reverse') return fwd.reverse();
    // Ping-pong: there and back without repeating the ends.
    return [...fwd, ...fwd.slice(1, -1).reverse()];
  }

  play(): void {
    if (this.playing) return;
    const order = this.playbackOrder();
    if (order.length < 2) {
      if (this.doc.frames.length > 1) this.toast('This tag has only one frame');
      return;
    }
    this.commitFloating();
    this.playing = true;
    let pos = Math.max(0, order.indexOf(this.doc.activeFrame));
    let frame = order[pos];
    const tick = () => {
      if (!this.playing) return;
      pos = (pos + 1) % order.length;
      frame = order[pos];
      this.renderer.displayFrame = frame;
      this.renderer.invalidateAll();
      this.playTimer = window.setTimeout(tick, Math.max(16, this.doc.frames[frame].duration));
    };
    this.renderer.displayFrame = frame;
    this.playTimer = window.setTimeout(tick, Math.max(16, this.doc.frames[frame].duration));
    this.emit('playback');
  }

  stop(): void {
    if (!this.playing) return;
    this.playing = false;
    clearTimeout(this.playTimer);
    this.renderer.displayFrame = null;
    this.renderer.invalidateAll();
    this.emit('playback');
  }

  // -------------------------------------------------------------- Status

  setPointer(p: { x: number; y: number } | null): void {
    this.emit('pointer', p);
  }

  setStatusHint(text: string): void {
    this.emit('hint', text);
  }

  toast(message: string, error = false): void {
    this.emit('toast', { message, error });
  }

  // --------------------------------------------------------- Persistence

  persist(): void {
    clearTimeout(this.persistTimer);
    this.persistTimer = window.setTimeout(() => this.persistNow(), 300);
  }

  persistNow(): void {
    clearTimeout(this.persistTimer);
    saveState({
      settings: this.settings,
      options: this.options,
      fg: toHex(this.fg, true),
      bg: toHex(this.bg, true),
      palette: this.palette.map((c) => toHex(c, true)),
      paletteName: this.paletteName,
      paletteRef: this.paletteRef ? `${this.paletteRef.kind}:${this.paletteRef.id}` : '',
      customPalettes: this.customPalettes.map((p) => ({ id: p.id, name: p.name, colors: p.colors.map((c) => toHex(c, true)) })),
      recent: this.recent.map((c) => toHex(c, true)),
      tool: this.tool.id,
    });
  }
}

function parseRef(s: string): PaletteRef {
  const m = /^(builtin|custom):(.+)$/.exec(s);
  return m ? { kind: m[1] as 'builtin' | 'custom', id: m[2] } : null;
}

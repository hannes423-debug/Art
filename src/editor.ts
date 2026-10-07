import { BLACK, type RGBA, WHITE, colorsEqual, parseHex, toHex } from './core/color';
import { ArtDocument } from './core/document';
import { Emitter } from './core/emitter';
import { History } from './core/history';
import { type PaintParams, PaintSession } from './core/paint';
import { presetColors } from './core/palette';
import type { SelectionMode, SelectionModify } from './core/selection';
import { type ClipImage, addLayer, changeSelection, clearPixels, copyPixels } from './ops';
import { Renderer } from './render/renderer';
import { Viewport } from './render/viewport';
import { type Settings, loadState, saveState } from './settings';
import { MoveSession } from './tools/move-session';
import { EllipseSelectTool, FillTool, HandTool, LassoTool, MoveTool, PickerTool, RectSelectTool, WandTool } from './tools/other-tools';
import { BrushTool, EraserTool, PencilTool } from './tools/paint-tools';
import { EllipseTool, LineTool, RectTool } from './tools/shape-tools';
import type { Tool, ToolId, ToolOptions } from './tools/tool';

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
    this.palette = state.palette?.map((h) => parseHex(h)).filter((c): c is RGBA => !!c) ?? presetColors('DawnBringer 32');
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
      line: new LineTool(this),
      rect: new RectTool(this),
      ellipse: new EllipseTool(this),
      fill: new FillTool(this),
      picker: new PickerTool(this),
      'select-rect': new RectSelectTool(this),
      'select-ellipse': new EllipseSelectTool(this),
      lasso: new LassoTool(this),
      wand: new WandTool(this),
      move: new MoveTool(this),
      hand: new HandTool(this),
    };
    this.tool = this.tools[state.tool && state.tool in this.tools ? state.tool : 'pencil'];
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
    this[which] = { ...c };
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

  setPalette(colors: RGBA[]): void {
    this.palette = colors.map((c) => ({ ...c }));
    this.emit('palette');
    this.persist();
  }

  // ------------------------------------------------------------- Painting

  /** Checks the active layer can be edited, telling the user why not. */
  canEditPixels(): boolean {
    if (!this.doc.activeLayer.visible) {
      this.toast('The active layer is hidden. Show it to edit.');
      return false;
    }
    return true;
  }

  beginPaint(params: PaintParams): PaintSession {
    this.commitFloating();
    this.stop();
    return new PaintSession(this.doc, this.doc.activeCel, params);
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
    const labels = { grow: 'Grow selection', shrink: 'Shrink selection', border: 'Border selection' };
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
  paste(img: ClipImage, asNewLayer = false, layerName?: string): void {
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
    if (!fits) {
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

  play(): void {
    if (this.playing || this.doc.frames.length < 2) return;
    this.commitFloating();
    this.playing = true;
    let frame = this.doc.activeFrame;
    const tick = () => {
      if (!this.playing) return;
      frame = (frame + 1) % this.doc.frames.length;
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
      recent: this.recent.map((c) => toHex(c, true)),
      tool: this.tool.id,
    });
  }
}

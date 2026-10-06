import { type ActionRegistry, MENUS, createActions } from './actions';
import { ProjectFiles } from './app-files';
import { Editor } from './editor';
import { decodeImage, encodeImage, webpEncodeSupported } from './io/image';
import { CanvasInput } from './input/pointer';
import type { ProjectMeta } from './io/storage';
import { ColorPanel } from './ui/color-panel';
import { dialogOpen, promptDialog } from './ui/dialog';
import {
  type ExportSettings,
  type NewBackground,
  aboutDialog,
  canvasSizeDialog,
  exportDialog,
  gridDialog,
  newImageDialog,
  projectsDialog,
  scaleImageDialog,
  settingsDialog,
  shortcutsDialog,
} from './ui/dialogs';
import { h, icon, iconButton, isTyping } from './ui/dom';
import { LayersPanel } from './ui/layers-panel';
import { closePopup, menuBar, mobileMenu } from './ui/menu';
import { OptionsBar } from './ui/options-bar';
import { StatusBar, zoomLabel } from './ui/statusbar';
import { Timeline } from './ui/timeline';
import { Toasts } from './ui/toast';
import { Toolbar } from './ui/toolbar';

type Layout = 'desktop' | 'mobile';
type Drawer = 'menu' | 'layers' | 'colors';

/** Phones (and short landscape phones) get the mobile layout; everything else the desktop one. */
const MOBILE_QUERY = '(max-width: 759px), (max-height: 519px) and (pointer: coarse)';

/**
 * The application shell: builds the responsive UI around the canvas and
 * connects the editor, input, panels, menus, keyboard shortcuts, clipboard
 * and file handling.
 */
export class App {
  readonly root: HTMLElement;
  readonly editor: Editor;
  readonly input: CanvasInput;
  readonly actions: ActionRegistry;
  readonly toasts = new Toasts();
  readonly files: ProjectFiles;
  layout: Layout = 'desktop';
  canvasOnly = false;
  lastNewSize: { w: number; h: number; bg: NewBackground } = { w: 64, h: 64, bg: 'transparent' };
  exportSettings: ExportSettings = { format: 'png', scale: 1, content: 'image', columns: 0, padding: 0, json: true, quality: 0.92 };

  private readonly stage: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly toolbar: Toolbar;
  private readonly optionsBar: OptionsBar;
  private readonly colorPanel: ColorPanel;
  private readonly layersPanel: LayersPanel;
  private readonly timeline: Timeline;
  private readonly statusbar: StatusBar;
  private readonly main: HTMLElement;
  private readonly sidePanel: HTMLElement;
  private readonly bottombar: HTMLElement;
  private readonly drawers: Record<Drawer, HTMLElement>;
  private readonly scrim: HTMLElement;
  private readonly hud: HTMLElement;
  private readonly busyEl: HTMLElement;
  private readonly titleName = h('span', { class: 'doc-name' });
  private readonly titleDims = h('span', { class: 'doc-dims' });
  private readonly titleDirty = h('span', { class: 'doc-dirty', title: 'Unsaved changes', 'aria-label': 'Unsaved changes' });
  private readonly undoBtns: HTMLButtonElement[] = [];
  private readonly redoBtns: HTMLButtonElement[] = [];
  private readonly fsBtns: HTMLButtonElement[] = [];
  private mobileMenuEl: HTMLElement & { refresh?: () => void };
  private openDrawerName: Drawer | null = null;
  private backStack: (() => void)[] = [];
  private ignorePop = 0;
  private hudTimer = 0;
  private lastCopy: { w: number; h: number } | null = null;
  /** Set by Ctrl+Shift+V so the following paste event creates a new layer. */
  private pasteAsLayerNext = false;
  private fitted = false;

  constructor(root: HTMLElement) {
    this.root = root;
    root.classList.add('app');
    this.canvas = h('canvas', { class: 'view', tabindex: '0', 'aria-label': 'Drawing canvas' });
    this.editor = new Editor(this.canvas);
    this.files = new ProjectFiles(this);
    this.actions = createActions(this);
    const e = this.editor;

    // --- components
    this.toolbar = new Toolbar(e);
    this.optionsBar = new OptionsBar(e);
    this.colorPanel = new ColorPanel(e, { importPalette: () => void this.files.importPalette(), exportPalette: (f) => void this.files.exportPalette(f) });
    this.layersPanel = new LayersPanel(e);
    this.timeline = new Timeline(e);
    this.statusbar = new StatusBar(e);
    this.toolbar.onColorClick = () => (this.layout === 'mobile' ? this.openDrawer('colors') : this.colorPanel.el.scrollIntoView({ block: 'nearest' }));
    this.toolbar.onToolReselect = () => {
      if (this.layout === 'mobile') this.optionsBar.openSheet();
    };

    // --- top bar
    const undo = (cls = '') => {
      const b = iconButton('undo', 'Undo (Ctrl+Z)', () => e.history.undo(), cls);
      this.undoBtns.push(b);
      return b;
    };
    const redo = (cls = '') => {
      const b = iconButton('redo', 'Redo (Ctrl+Shift+Z)', () => e.history.redo(), cls);
      this.redoBtns.push(b);
      return b;
    };
    const fullscreen = (cls = '') => {
      const b = iconButton('fullscreen', 'Fullscreen (F)', () => this.toggleFullscreen(), cls);
      this.fsBtns.push(b);
      return b;
    };
    const title = h('button', { type: 'button', class: 'doc-title', title: 'Rename document' }, this.titleName, this.titleDirty, this.titleDims);
    title.addEventListener('click', () => void this.renameDocument());
    const topbar = h(
      'header',
      { class: 'topbar' },
      iconButton('menu', 'Menu', () => this.openDrawer('menu'), 'mobile-only'),
      h('span', { class: 'brand desktop-only', 'aria-hidden': 'true' }, 'Art'),
      menuBar(this.actions, MENUS),
      title,
      h('span', { class: 'topbar-spacer' }),
      undo(),
      redo(),
      iconButton('share', 'Export image (Ctrl+E)', () => this.showExport(), 'topbar-export'),
      iconButton('focus', 'Canvas only (Tab)', () => this.toggleCanvasOnly()),
      document.fullscreenEnabled ? fullscreen('desktop-only') : null,
      iconButton('panel', 'Toggle side panel (F7)', () => this.toggleSidePanel(), 'desktop-only'),
      iconButton('layers', 'Layers', () => this.openDrawer('layers'), 'mobile-only'),
    );

    // --- stage
    this.hud = h('div', { class: 'hud', 'aria-hidden': 'true' });
    this.busyEl = h('div', { class: 'busy', role: 'progressbar', 'aria-label': 'Working' });
    const focusControls = h(
      'div',
      { class: 'focus-controls' },
      undo('floating'),
      redo('floating'),
      document.fullscreenEnabled ? fullscreen('floating') : null,
      iconButton('close', 'Exit canvas only (Tab)', () => this.toggleCanvasOnly(false), 'floating exit-focus'),
    );
    this.stage = h('div', { class: 'stage' }, this.canvas, focusControls, this.hud, this.busyEl, this.toasts.el);
    this.sidePanel = h('aside', { class: 'sidepanel', 'aria-label': 'Panels' });
    this.main = h('div', { class: 'main' }, this.stage, this.sidePanel);
    this.bottombar = h('div', { class: 'bottombar' });

    // --- drawers (mobile)
    this.mobileMenuEl = mobileMenu(this.actions, MENUS, () => this.closeDrawer());
    const drawerHeader = (label: string) => h('div', { class: 'drawer-header' }, h('h2', null, label), iconButton('close', 'Close', () => this.closeDrawer()));
    this.drawers = {
      menu: h('div', { class: 'drawer left', role: 'dialog', 'aria-label': 'Menu' }, drawerHeader('Art'), this.mobileMenuEl),
      layers: h('div', { class: 'drawer right', role: 'dialog', 'aria-label': 'Layers' }, drawerHeader('Layers')),
      colors: h('div', { class: 'drawer bottom', role: 'dialog', 'aria-label': 'Colors' }, drawerHeader('Colors')),
    };
    this.scrim = h('div', { class: 'scrim' });
    this.scrim.addEventListener('click', () => this.closeDrawer());

    root.append(topbar, this.optionsBar.el, this.main, this.timeline.el, this.statusbar.el, this.bottombar, this.scrim, ...Object.values(this.drawers));
    this.input = new CanvasInput(e, this.canvas);

    // --- events
    e.on('toast', ({ message, error }) => this.toast(message, error));
    e.on('modified', () => this.updateTitle());
    e.on('document', () => {
      this.updateTitle();
      if (this.canvasOnly && this.layout === 'mobile') return;
    });
    e.history.on('change', () => this.updateUndo());
    e.on('view', () => this.showZoomHud());
    e.on('settings', () => this.applyPanels());
    e.on('hint', (t) => {
      if (this.layout === 'mobile' && t) this.flashHud(t);
    });
    document.addEventListener('fullscreenchange', () => this.updateFullscreenButtons());

    const ro = new ResizeObserver(() => this.onStageResize());
    ro.observe(this.stage);
    const mq = matchMedia(MOBILE_QUERY);
    mq.addEventListener('change', () => this.applyLayout(mq.matches ? 'mobile' : 'desktop'));
    this.applyLayout(mq.matches ? 'mobile' : 'desktop', true);
    this.applyPanels();
    this.updateTitle();
    this.updateUndo();

    window.addEventListener('keydown', (ev) => this.onKeyDown(ev));
    document.addEventListener('paste', (ev) => void this.onPaste(ev));
    window.addEventListener('popstate', () => this.onPopState());
    this.setupDragDrop();
    this.setupLaunchQueue();
    // Keep the page itself from scrolling or zooming on touch devices.
    document.addEventListener('gesturestart', (ev) => ev.preventDefault());
  }

  /** Restores the previous session or welcomes the user with the New Image dialog. */
  async start(): Promise<void> {
    const restored = await this.files.restoreLastSession();
    if (!restored) newImageDialog(this, true);
  }

  // ------------------------------------------------------------- Layout

  private applyLayout(layout: Layout, initial = false): void {
    if (layout === this.layout && !initial) return;
    this.layout = layout;
    this.root.dataset.layout = layout;
    this.closeDrawer();
    closePopup();
    const mobile = layout === 'mobile';
    this.toolbar.setMobile(mobile);
    this.optionsBar.setMobile(mobile);
    if (mobile) {
      this.bottombar.append(this.toolbar.el);
      this.drawers.colors.append(this.colorPanel.el);
      this.drawers.layers.append(this.layersPanel.el);
    } else {
      this.main.prepend(this.toolbar.el);
      this.sidePanel.append(this.colorPanel.el, this.layersPanel.el);
    }
    this.mobileMenuEl.refresh?.();
  }

  private applyPanels(): void {
    const s = this.editor.settings;
    this.root.classList.toggle('no-sidepanel', !s.sidePanel);
    this.root.classList.toggle('show-timeline', s.showTimeline);
  }

  toggleSidePanel(): void {
    this.editor.updateSettings({ sidePanel: !this.editor.settings.sidePanel });
  }

  toggleTimeline(on = !this.editor.settings.showTimeline): void {
    this.editor.updateSettings({ showTimeline: on });
  }

  private onStageResize(): void {
    const r = this.stage.getBoundingClientRect();
    const v = this.editor.view;
    const dw = r.width - v.width;
    const dh = r.height - v.height;
    this.editor.renderer.resize(r.width, r.height);
    this.input.updateRect();
    if (!this.fitted && r.width > 1 && r.height > 1) {
      this.fitted = true;
      this.editor.fitView();
    } else if (dw || dh) {
      // Keep the document anchored to the center as panels appear/disappear.
      v.panBy(dw / 2, dh / 2);
      this.editor.viewChanged();
    }
  }

  /** Canvas-only (focus) mode: hides all UI except a few floating controls. */
  toggleCanvasOnly(on = !this.canvasOnly): void {
    if (on === this.canvasOnly) return;
    this.canvasOnly = on;
    this.root.classList.toggle('canvas-only', on);
    this.closeDrawer();
    closePopup();
    if (on) {
      this.pushBack(() => this.toggleCanvasOnly(false));
      this.flashHud(this.layout === 'mobile' ? 'Canvas only — tap ✕ or go back to exit' : 'Canvas only — press Tab or click ✕ to exit');
    } else this.dropBack();
    this.mobileMenuEl.refresh?.();
  }

  async toggleFullscreen(): Promise<void> {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    } catch {
      this.toast('Fullscreen is not available here', true);
    }
  }

  private updateFullscreenButtons(): void {
    const on = !!document.fullscreenElement;
    for (const b of this.fsBtns) {
      b.replaceChildren(icon(on ? 'fullscreen-exit' : 'fullscreen'));
      b.title = on ? 'Exit fullscreen (F)' : 'Fullscreen (F)';
      b.setAttribute('aria-label', b.title);
    }
  }

  openDrawer(which: Drawer): void {
    if (this.openDrawerName === which) {
      this.closeDrawer();
      return;
    }
    this.closeDrawer();
    if (which === 'menu') this.mobileMenuEl.refresh?.();
    this.openDrawerName = which;
    this.drawers[which].classList.add('open');
    this.scrim.classList.add('open');
    this.pushBack(() => this.closeDrawer(true));
  }

  closeDrawer(fromBack = false): void {
    if (!this.openDrawerName) return;
    this.drawers[this.openDrawerName].classList.remove('open');
    this.scrim.classList.remove('open');
    this.openDrawerName = null;
    if (!fromBack) this.dropBack();
  }

  /** Android back button / gesture closes drawers and exits canvas-only mode. */
  private pushBack(fn: () => void): void {
    if (this.layout !== 'mobile') return;
    this.backStack.push(fn);
    history.pushState({ artOverlay: this.backStack.length }, '');
  }

  private dropBack(): void {
    if (!this.backStack.length) return;
    this.backStack.pop();
    this.ignorePop++;
    history.back();
  }

  private onPopState(): void {
    if (this.ignorePop > 0) {
      this.ignorePop--;
      return;
    }
    const fn = this.backStack.pop();
    if (!fn) return;
    if (this.openDrawerName) this.closeDrawer(true);
    else if (this.canvasOnly) {
      this.canvasOnly = false;
      this.root.classList.remove('canvas-only');
    } else fn();
  }

  // ------------------------------------------------------------ Status

  toast(message: string, error = false): void {
    this.toasts.show(message, error);
  }

  setBusy(on: boolean): void {
    this.busyEl.classList.toggle('on', on);
  }

  private updateTitle(): void {
    const e = this.editor;
    const d = e.doc;
    this.titleName.textContent = d.name;
    this.titleDims.textContent = `${d.width}×${d.height}`;
    this.titleDirty.classList.toggle('on', e.modified);
    document.title = `${e.modified ? '• ' : ''}${d.name} — Art`;
  }

  private updateUndo(): void {
    const h = this.editor.history;
    for (const b of this.undoBtns) {
      b.disabled = !h.canUndo;
      b.title = h.undoLabel ? `Undo ${h.undoLabel} (Ctrl+Z)` : 'Undo (Ctrl+Z)';
    }
    for (const b of this.redoBtns) {
      b.disabled = !h.canRedo;
      b.title = h.redoLabel ? `Redo ${h.redoLabel} (Ctrl+Shift+Z)` : 'Redo (Ctrl+Shift+Z)';
    }
    this.updateTitle();
  }

  private showZoomHud(): void {
    // Only during gestures; the desktop status bar always shows the zoom.
    if (this.input.busy) this.flashHud(zoomLabel(this.editor.view.zoom));
  }

  private flashHud(text: string): void {
    this.hud.textContent = text;
    this.hud.classList.add('show');
    clearTimeout(this.hudTimer);
    this.hudTimer = window.setTimeout(() => this.hud.classList.remove('show'), 900);
  }

  private async renameDocument(): Promise<void> {
    const name = await promptDialog('Rename', 'Document name', this.editor.doc.name, 'Rename');
    if (name && name.trim()) {
      this.editor.doc.name = name.trim();
      this.editor.markChanged();
      this.updateTitle();
    }
  }

  async storageInfo(): Promise<string> {
    try {
      const est = await navigator.storage?.estimate?.();
      const persisted = await navigator.storage?.persisted?.();
      const mb = (n?: number) => (n ? `${(n / 1024 / 1024).toFixed(1)} MB` : '?');
      const projects = await this.files.listLibrary();
      return `${projects.length} project${projects.length === 1 ? '' : 's'} stored · ${mb(est?.usage)} used of ${mb(est?.quota)} available · ${persisted ? 'protected from automatic cleanup' : 'the browser may clear storage when space is low — keep file backups'}.`;
    } catch {
      return 'Storage information is not available in this browser.';
    }
  }

  // ------------------------------------------------------------ Keyboard

  private onKeyDown(ev: KeyboardEvent): void {
    if (ev.defaultPrevented || dialogOpen() || document.querySelector('.popup-menu')) return;
    if (isTyping(ev.target)) return;
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'v') {
      // Let the browser fire the paste event (it carries the system clipboard).
      this.pasteAsLayerNext = ev.shiftKey;
      return;
    }
    const e = this.editor;
    if (e.tool.keyDown(ev)) {
      ev.preventDefault();
      return;
    }
    const action = this.actions.match(ev);
    if (!action) return;
    if (action.id === 'view.canvasOnly') {
      // Keep Tab for focus navigation when a control has focus.
      const a = document.activeElement;
      if (a && a !== document.body && a !== this.canvas) return;
    }
    if (ev.repeat && !['view.zoomIn', 'view.zoomOut', 'edit.undo', 'edit.redo', 'tool.sizeUp', 'tool.sizeDown', 'frame.prev', 'frame.next'].includes(action.id)) {
      ev.preventDefault();
      return;
    }
    ev.preventDefault();
    if (action.available && !action.available()) return;
    if (action.enabled && !action.enabled()) return;
    void action.run();
  }

  escape(): void {
    const e = this.editor;
    if (e.tool.busy) e.tool.cancel();
    else if (e.floating) e.cancelFloating();
    else if (e.doc.selection.active) e.deselect();
    else if (this.canvasOnly) this.toggleCanvasOnly(false);
  }

  adjustSize(dir: 1 | -1): void {
    const e = this.editor;
    const spec = e.tool.optionSpecs.find((s) => s.key === 'size' && s.type === 'slider');
    if (!spec || spec.type !== 'slider') return;
    const group = (e.options as unknown as Record<string, Record<string, number>>)[e.tool.optionsKey];
    const cur = group.size;
    const next = dir > 0 ? Math.max(cur + 1, Math.round(cur * 1.2)) : Math.min(cur - 1, Math.round(cur / 1.2));
    e.setOption(e.tool.optionsKey, 'size', Math.max(spec.min, Math.min(spec.max, next)));
    this.optionsBar.render();
    this.flashHud(`Size ${Math.round(group.size)}`);
  }

  setToolOpacity(v: number): void {
    const e = this.editor;
    if (!e.tool.optionSpecs.some((s) => s.key === 'opacity')) return;
    e.setOption(e.tool.optionsKey, 'opacity', v);
    this.optionsBar.render();
    this.flashHud(`Opacity ${Math.round(v * 100)}%`);
  }

  stepFrame(delta: number): void {
    const e = this.editor;
    const d = e.doc;
    e.stop();
    e.commitFloating();
    d.setActiveFrame((d.activeFrame + delta + d.frames.length) % d.frames.length);
  }

  // ----------------------------------------------------------- Clipboard

  async copy(merged: boolean): Promise<void> {
    const clip = this.editor.copy(merged);
    if (!clip) return;
    this.lastCopy = { w: clip.width, h: clip.height };
    this.editor.setStatusHint(`Copied ${clip.width}×${clip.height}`);
    await this.writeSystemClipboard(clip);
  }

  async cut(): Promise<void> {
    const clip = this.editor.cut();
    if (!clip) return;
    this.lastCopy = { w: clip.width, h: clip.height };
    await this.writeSystemClipboard(clip);
  }

  /** Also puts the pixels on the system clipboard as PNG, so other apps can paste them. */
  private async writeSystemClipboard(clip: { width: number; height: number; data: Uint8ClampedArray<ArrayBuffer> }): Promise<void> {
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') return;
      const blob = encodeImage({ width: clip.width, height: clip.height, data: clip.data }, 'png');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    } catch {
      // The internal clipboard still works; system clipboard access is optional.
    }
  }

  private async onPaste(ev: ClipboardEvent): Promise<void> {
    if (dialogOpen() || isTyping(ev.target)) return;
    const file = [...(ev.clipboardData?.items ?? [])].find((i) => i.kind === 'file' && i.type.startsWith('image/'))?.getAsFile();
    ev.preventDefault();
    const asLayer = this.pasteAsLayerNext;
    this.pasteAsLayerNext = false;
    await this.pasteImage(file ?? null, asLayer);
  }

  async pasteFromMenu(asLayer: boolean): Promise<void> {
    let blob: Blob | null = null;
    try {
      if (navigator.clipboard?.read) {
        for (const item of await navigator.clipboard.read()) {
          const type = item.types.find((t) => t.startsWith('image/'));
          if (type) {
            blob = await item.getType(type);
            break;
          }
        }
      }
    } catch {
      // Permission denied or unsupported: fall back to the internal clipboard.
    }
    await this.pasteImage(blob, asLayer);
  }

  private async pasteImage(blob: Blob | null, asLayer: boolean): Promise<void> {
    const e = this.editor;
    const internal = e.clipboard;
    if (blob) {
      try {
        const img = await decodeImage(blob);
        // Our own copy came back through the system clipboard: prefer the exact internal pixels.
        if (internal && this.lastCopy && this.lastCopy.w === img.width && this.lastCopy.h === img.height) e.paste(internal, asLayer);
        else e.paste({ width: img.width, height: img.height, data: img.data, x: 0, y: 0 }, asLayer);
        return;
      } catch {
        // fall through to internal
      }
    }
    if (internal) e.paste(internal, asLayer);
    else this.toast('Nothing to paste');
  }

  // --------------------------------------------------------------- Files

  showNewDialog(): void {
    newImageDialog(this);
  }

  newDocument(w: number, h: number, bg: NewBackground): Promise<void> {
    return this.files.newDocument(w, h, bg);
  }

  open(): Promise<void> {
    return this.files.open();
  }

  save(): Promise<void> {
    return this.files.save();
  }

  saveAsFile(): Promise<void> {
    return this.files.saveAsFile();
  }

  importAsLayer(): Promise<void> {
    return this.files.importAsLayer();
  }

  importSpriteSheet(): Promise<void> {
    return this.files.importSpriteSheet();
  }

  async showExport(): Promise<void> {
    this.editor.commitFloating();
    exportDialog(this, await webpEncodeSupported());
  }

  exportBaseName(): string {
    return this.editor.doc.name;
  }

  exportSize(s: ExportSettings): [number, number] {
    return this.files.exportSize(s);
  }

  runExport(s: ExportSettings, name: string, share: boolean): Promise<boolean> {
    return this.files.runExport(s, name, share);
  }

  canReExport(): boolean {
    return !!this.files.lastExport;
  }

  async reExport(): Promise<void> {
    if (!(await this.files.reExport())) void this.showExport();
  }

  async showProjects(): Promise<void> {
    let projects: ProjectMeta[] = [];
    try {
      await this.files.flushCurrent();
      projects = await this.files.listLibrary();
    } catch (err) {
      this.toast(`The project library is not available: ${err instanceof Error ? err.message : err}`, true);
    }
    projectsDialog(this, projects);
  }

  openFromLibrary(id: string): Promise<boolean> {
    return this.files.openFromLibrary(id);
  }

  downloadLibraryProject(id: string): Promise<void> {
    return this.files.downloadLibraryProject(id);
  }

  deleteLibraryProject(id: string): Promise<void> {
    return this.files.deleteLibraryProject(id);
  }

  showCanvasSize(): void {
    canvasSizeDialog(this);
  }

  showScaleImage(): void {
    scaleImageDialog(this);
  }

  showGridSettings(): void {
    gridDialog(this);
  }

  showSettings(): void {
    settingsDialog(this);
  }

  showShortcuts(): void {
    shortcutsDialog(this);
  }

  showAbout(): void {
    aboutDialog();
  }

  private setupDragDrop(): void {
    let depth = 0;
    const isFiles = (ev: DragEvent) => [...(ev.dataTransfer?.types ?? [])].includes('Files');
    window.addEventListener('dragenter', (ev) => {
      if (!isFiles(ev)) return;
      ev.preventDefault();
      depth++;
      this.root.classList.add('drop-target');
    });
    window.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (!depth) this.root.classList.remove('drop-target');
    });
    window.addEventListener('dragover', (ev) => {
      if (isFiles(ev)) ev.preventDefault();
    });
    window.addEventListener('drop', (ev) => {
      if (!isFiles(ev)) return;
      ev.preventDefault();
      depth = 0;
      this.root.classList.remove('drop-target');
      const file = ev.dataTransfer?.files?.[0];
      if (file) void this.files.openPicked({ file, handle: null });
    });
  }

  /** Opening files from the OS when installed as a PWA (File Handling API). */
  private setupLaunchQueue(): void {
    const lq = (window as unknown as { launchQueue?: { setConsumer(fn: (p: { files: FileSystemFileHandle[] }) => void): void } }).launchQueue;
    lq?.setConsumer(async (params) => {
      const handle = params.files?.[0];
      if (handle) void this.files.openPicked({ file: await handle.getFile(), handle });
    });
  }
}

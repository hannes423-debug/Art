import type { App } from './app';
import { compositeFrame, compositeSampled, sampleGrid } from './core/composite';
import { previewFrames, previewKey, renderStrip } from './core/thumbnail';
import { ArtDocument } from './core/document';
import { cropPixels, resizePixels } from './core/imageops';
import { Layer } from './core/layer';
import { paletteNameFromFile, parsePalette, parsePaletteBundle, toGpl, toHexList, toPaletteBundle } from './core/palette';
import { type Pixels, Surface, allocPixels } from './core/surface';
import type { DocumentInfo } from './editor';
import { type FileType, type PickedFile, downloadBlob, fileNameFor, hasFileSystemAccess, pickFiles, saveFileAs, shareFile, writeToHandle } from './io/files';
import { type ExportFormat, FORMAT_EXT, FORMAT_MIME, decodeImage, encodeAnimation, encodeImage, isAnimatedFormat, sniffType } from './io/image';
import { encodePNG } from './io/png';
import { PROJECT_EXT, type ProjectExtras, ProjectFormatError, bytesToBase64, deserializeProject, projectToJSON, serializeProject } from './io/project';
import {
  type ProjectMeta,
  type ThumbnailAnimation,
  deleteProject,
  getLastProjectId,
  listProjects,
  loadProject,
  newProjectId,
  requestPersistence,
  saveProject,
  setProjectAnimation,
  setLastProjectId,
} from './io/storage';
import { confirmDialog } from './ui/dialog';
import type { ExportSettings, NewBackground, SheetSlice } from './ui/dialogs';
import { spriteSheetDialog } from './ui/dialogs';

/** Longest side of the static library thumbnail. */
const THUMB_MAX = 160;
/** Longest side of one frame of an animated thumbnail. */
const ANIM_FRAME_MAX = 96;
/** At most this many frames in an animated thumbnail (longer animations are sampled). */
const ANIM_MAX_FRAMES = 48;

const IMAGE_TYPES: FileType = {
  description: 'Images',
  accept: { 'image/png': ['.png'], 'image/jpeg': ['.jpg', '.jpeg'], 'image/gif': ['.gif'], 'image/webp': ['.webp'], 'image/bmp': ['.bmp'] },
};
const PROJECT_TYPES: FileType = { description: 'Art project', accept: { 'application/json': [`.${PROJECT_EXT}`, '.json'] } };
const OPEN_TYPES: FileType = {
  description: 'Images and Art projects',
  accept: { ...IMAGE_TYPES.accept, 'application/json': [`.${PROJECT_EXT}`, '.json'] },
};

function baseName(fileName: string): string {
  return fileName.replace(/\.[a-z0-9]{2,8}$/i, '') || 'Untitled';
}

function errorMessage(err: unknown): string {
  if (err instanceof RangeError) return 'Not enough memory for an image this large.';
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Everything that moves documents in and out of the editor: autosave to the
 * local library, opening/importing files, saving project files and exporting
 * images. All of it works offline; nothing is ever uploaded.
 */
export class ProjectFiles {
  private readonly app: App;
  private timer = 0;
  private saving: Promise<boolean> | null = null;
  private warned = false;
  private persistAsked = false;
  private created = new Map<string, string>();
  /** Last export target (for "Export again"). */
  lastExport: { handle: FileSystemFileHandle; settings: ExportSettings; name: string } | null = null;

  constructor(app: App) {
    this.app = app;
    const e = app.editor;
    e.on('modified', () => this.schedule());
    const flush = () => {
      if (document.visibilityState === 'hidden' && e.modified) void this.autosave(true);
    };
    document.addEventListener('visibilitychange', flush);
    window.addEventListener('pagehide', () => {
      if (e.modified) void this.autosave(true);
    });
    // Only warn when something really is not stored yet (autosave usually got there first).
    window.addEventListener('beforeunload', (ev) => {
      if (!e.modified) return;
      void this.autosave(true);
      ev.preventDefault();
    });
  }

  private get editor() {
    return this.app.editor;
  }

  extras(): ProjectExtras {
    const e = this.editor;
    return {
      palette: e.palette,
      paletteName: e.paletteName,
      grid: e.settings.grid,
      created: e.info.projectId ? this.created.get(e.info.projectId) : undefined,
    };
  }

  // ----------------------------------------------------------- Autosave

  private schedule(): void {
    clearTimeout(this.timer);
    const e = this.editor;
    if (!e.modified) return;
    // Save quickly for typical sprite sizes; wait longer for big images (encoding costs more).
    const pixels = e.doc.width * e.doc.height * e.doc.layers.length * e.doc.frames.length;
    this.timer = window.setTimeout(() => void this.autosave(false), pixels > 2_000_000 ? 2500 : 800);
  }

  private async autosave(urgent: boolean): Promise<void> {
    const e = this.editor;
    if (!e.modified) return;
    if (!urgent && (e.floating || e.tool.busy || this.app.input.busy)) {
      this.schedule();
      return;
    }
    await this.saveToLibrary(false);
  }

  /** Saves the current document into the browser library. */
  async saveToLibrary(explicit: boolean): Promise<boolean> {
    while (this.saving) await this.saving;
    const run = this.doSave(explicit);
    this.saving = run;
    try {
      return await run;
    } finally {
      this.saving = null;
    }
  }

  private async doSave(explicit: boolean): Promise<boolean> {
    const e = this.editor;
    const doc = e.doc;
    const version = e.history.version;
    const untracked = e.untrackedChanges;
    const id = e.info.projectId ?? newProjectId();
    try {
      const data = await serializeProject(doc, this.extras(), (png) => new Blob([png as Uint8Array<ArrayBuffer>], { type: 'image/png' }));
      const created = this.created.get(id) ?? data.created;
      this.created.set(id, created);
      data.created = created;
      const meta: ProjectMeta = {
        id,
        name: doc.name,
        width: doc.width,
        height: doc.height,
        frames: doc.frames.length,
        layers: doc.layers.length,
        created,
        modified: data.modified,
        thumbnail: await this.thumbnail(doc),
        anim: await this.animatedThumbnail(doc).catch(() => undefined),
      };
      await saveProject(meta, data);
      if (e.doc !== doc) return true;
      e.info.projectId = id;
      setLastProjectId(id);
      void this.app.timelapse.flush();
      if (e.history.version === version && e.untrackedChanges === untracked) e.markSaved();
      if (!this.persistAsked) {
        this.persistAsked = true;
        void requestPersistence();
      }
      return true;
    } catch (err) {
      console.error('Saving to the browser library failed', err);
      if (explicit || !this.warned)
        this.app.toast(`Could not save in this browser (${errorMessage(err)}). Use “Save project as file” to keep your work.`, true);
      this.warned = true;
      return false;
    }
  }

  /** Static thumbnail: the active frame, scaled nearest-neighbour to fit 160 px (pixel art stays crisp). */
  private async thumbnail(doc: ArtDocument): Promise<Blob | null> {
    try {
      const k = Math.min(1, THUMB_MAX / Math.max(doc.width, doc.height));
      const w = Math.max(1, Math.round(doc.width * k));
      const h = Math.max(1, Math.round(doc.height * k));
      const data = compositeSampled(doc, doc.activeFrame, sampleGrid(w, doc.width), sampleGrid(h, doc.height));
      return new Blob([(await encodePNG(w, h, data)) as Uint8Array<ArrayBuffer>], { type: 'image/png' });
    } catch {
      return null;
    }
  }

  private animCache: { key: string; anim: ThumbnailAnimation } | null = null;

  /**
   * Animated preview: the animation the editor would play from the active
   * frame (its tag, in the tag's direction, or every frame) with each
   * frame's duration, as a strip of small frames. Rebuilt only when the
   * frames, cels, layers or timing change.
   */
  private async animatedThumbnail(doc: ArtDocument, useCache = true): Promise<ThumbnailAnimation | undefined> {
    const all = doc.thumbnailOrder(doc.activeFrame);
    if (all.length < 2) return undefined;
    const { order, durations } = previewFrames(doc, all, ANIM_MAX_FRAMES);
    const key = previewKey(doc, order, durations);
    if (useCache && this.animCache?.key === key) return this.animCache.anim;
    const strip = renderStrip(doc, order, ANIM_FRAME_MAX);
    const anim: ThumbnailAnimation = {
      strip: new Blob([(await encodePNG(strip.width, strip.height, strip.data)) as Uint8Array<ArrayBuffer>], { type: 'image/png' }),
      frameW: strip.frameW,
      frameH: strip.frameH,
      durations,
    };
    if (useCache) this.animCache = { key, anim };
    return anim;
  }

  /**
   * Builds the animated preview of a project saved before previews existed
   * (or saved with a different preview setting) and stores it with the
   * project. Returns it, or undefined for single-frame projects.
   */
  async upgradeLibraryThumbnail(id: string): Promise<ThumbnailAnimation | undefined> {
    const row = await loadProject(id);
    if (!row || (row.meta.frames ?? 1) < 2) return undefined;
    const { doc } = await deserializeProject(row.data);
    try {
      const anim = await this.animatedThumbnail(doc, false);
      if (anim) await setProjectAnimation(id, anim);
      return anim;
    } finally {
      doc.dispose();
    }
  }

  /**
   * Makes sure the current document is stored before switching away from it.
   * Returns false if it could not be saved and the user chose to keep it.
   */
  async flushCurrent(): Promise<boolean> {
    const e = this.editor;
    e.commitFloating();
    clearTimeout(this.timer);
    if (!e.modified) return true;
    if (await this.saveToLibrary(false)) return true;
    return confirmDialog(
      'Discard unsaved changes?',
      `“${e.doc.name}” could not be saved in this browser. Continue without it, or cancel and use “Save project as file” first.`,
      'Discard changes',
      true,
    );
  }

  async restoreLastSession(): Promise<boolean> {
    const id = getLastProjectId();
    if (!id) return false;
    try {
      return await this.openFromLibrary(id, true);
    } catch (err) {
      console.warn('Could not restore the last project', err);
      return false;
    }
  }

  async openFromLibrary(id: string, quiet = false): Promise<boolean> {
    if (this.editor.info.projectId === id) return true;
    const row = await loadProject(id);
    if (!row) {
      if (!quiet) this.app.toast('That project no longer exists', true);
      return false;
    }
    const { doc, extras } = await deserializeProject(row.data);
    if (!(await this.load(doc, extras, { projectId: id }))) return false;
    this.created.set(id, row.meta.created);
    setLastProjectId(id);
    return true;
  }

  async listLibrary(): Promise<ProjectMeta[]> {
    return listProjects();
  }

  async downloadLibraryProject(id: string): Promise<void> {
    const row = await loadProject(id);
    if (!row) return;
    const data = {
      ...row.data,
      layers: await Promise.all(
        row.data.layers.map(async (l) => ({
          ...l,
          cels: await Promise.all(
            l.cels.map(async (c) => (c instanceof Blob ? 'data:image/png;base64,' + bytesToBase64(new Uint8Array(await c.arrayBuffer())) : c)),
          ),
        })),
      ),
    };
    downloadBlob(new Blob([JSON.stringify(data)], { type: 'application/json' }), fileNameFor(row.meta.name, PROJECT_EXT));
  }

  async deleteLibraryProject(id: string): Promise<void> {
    await deleteProject(id);
    if (this.editor.info.projectId === id) {
      this.editor.info.projectId = null;
      this.editor.markChanged();
    }
    if (getLastProjectId() === id) setLastProjectId(this.editor.info.projectId);
  }

  // ------------------------------------------------------------ Loading

  private async load(doc: ArtDocument, extras: ProjectExtras | null, info: Partial<DocumentInfo>): Promise<boolean> {
    if (!(await this.flushCurrent())) {
      doc.dispose();
      return false;
    }
    const e = this.editor;
    e.setDocument(doc, info);
    if (extras) {
      if (extras.palette.length) e.adoptPalette(extras.palette, extras.paletteName ?? `${doc.name} palette`);
      e.updateSettings({ grid: extras.grid });
      if (doc.frames.length > 1 && !e.settings.showTimeline) this.app.toggleTimeline(true);
    }
    return true;
  }

  async newDocument(width: number, height: number, background: NewBackground): Promise<void> {
    const e = this.editor;
    const bg =
      background === 'transparent'
        ? null
        : background === 'white'
          ? { r: 255, g: 255, b: 255, a: 255 }
          : background === 'black'
            ? { r: 0, g: 0, b: 0, a: 255 }
            : e.bg;
    let doc: ArtDocument;
    try {
      doc = ArtDocument.createBlank(width, height, 'Untitled', bg);
    } catch (err) {
      this.app.toast(errorMessage(err), true);
      return;
    }
    if (!(await this.load(doc, null, {}))) return;
    setLastProjectId(null);
    this.app.lastNewSize = { w: width, h: height, bg: background };
  }

  async open(): Promise<void> {
    const files = await pickFiles([OPEN_TYPES]);
    if (files.length) await this.openPicked(files[0]);
  }

  async openPicked({ file, handle }: PickedFile): Promise<void> {
    this.app.setBusy(true);
    try {
      const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
      const type = sniffType(head);
      if (type === 'json' || file.name.toLowerCase().endsWith(`.${PROJECT_EXT}`)) {
        const { doc, extras } = await deserializeProject(await file.text());
        if (!doc.name || doc.name === 'Untitled') doc.name = baseName(file.name);
        if (await this.load(doc, extras, { projectHandle: handle && file.name.toLowerCase().endsWith(`.${PROJECT_EXT}`) ? handle : null }))
          this.app.toast(`Opened ${file.name}`);
        return;
      }
      const img = await decodeImage(file);
      const doc = ArtDocument.fromLayers(
        img.width,
        img.height,
        [new Layer('Layer 1', [new Surface(img.width, img.height, img.data)])],
        [{ duration: 100 }],
        baseName(file.name),
      );
      if (!(await this.load(doc, null, { imageHandle: handle }))) return;
      setLastProjectId(null);
      const fmt: ExportFormat | null = type === 'png' ? 'png' : type === 'jpeg' ? 'jpeg' : type === 'webp' ? 'webp' : null;
      this.lastExport = handle && fmt ? { handle, name: file.name, settings: { ...this.app.exportSettings, format: fmt, scale: 1, content: 'image' } } : null;
    } catch (err) {
      console.error(err);
      this.app.toast(err instanceof ProjectFormatError ? err.message : `Could not open ${file.name}: ${errorMessage(err)}`, true);
    } finally {
      this.app.setBusy(false);
    }
  }

  async importAsLayer(): Promise<void> {
    const files = await pickFiles([IMAGE_TYPES]);
    if (!files.length) return;
    try {
      const img = await decodeImage(files[0].file);
      const doc = this.editor.doc;
      if (img.width > doc.width || img.height > doc.height)
        this.app.toast('The image is larger than the canvas; parts outside will be cropped when applied (Image → Canvas size enlarges the canvas).');
      this.editor.paste({ width: img.width, height: img.height, data: img.data, x: 0, y: 0 }, true, baseName(files[0].file.name));
    } catch (err) {
      this.app.toast(`Could not import: ${errorMessage(err)}`, true);
    }
  }

  async importSpriteSheet(): Promise<void> {
    const files = await pickFiles([IMAGE_TYPES]);
    if (!files.length) return;
    const file = files[0].file;
    let img;
    try {
      img = await decodeImage(file);
    } catch (err) {
      this.app.toast(`Could not open ${file.name}: ${errorMessage(err)}`, true);
      return;
    }
    spriteSheetDialog(this.app, file.name, img, (s) => void this.sliceSheet(baseName(file.name), img, s));
  }

  private async sliceSheet(name: string, img: { width: number; height: number; data: Pixels }, s: SheetSlice): Promise<void> {
    const cels: Surface[] = [];
    for (let y = s.offsetY; y + s.frameH <= img.height; y += s.frameH + s.gapY) {
      for (let x = s.offsetX; x + s.frameW <= img.width; x += s.frameW + s.gapX) {
        const surf = new Surface(s.frameW, s.frameH, cropPixels(img.data, img.width, img.height, { x, y, w: s.frameW, h: s.frameH }));
        if (s.skipEmpty && surf.isBlank()) continue;
        cels.push(surf);
      }
    }
    if (!cels.length) {
      this.app.toast('No frames found with those settings', true);
      return;
    }
    if (cels.length > 1024) {
      this.app.toast('Too many frames (maximum 1024)', true);
      return;
    }
    const doc = ArtDocument.fromLayers(
      s.frameW,
      s.frameH,
      [new Layer('Layer 1', cels)],
      cels.map(() => ({ duration: 100 })),
      name,
    );
    if (!(await this.load(doc, null, {}))) return;
    setLastProjectId(null);
    this.app.toggleTimeline(true);
    this.app.toast(`Imported ${cels.length} frame${cels.length === 1 ? '' : 's'}`);
  }

  // ------------------------------------------------------------- Saving

  /** Ctrl+S: store in the library, and write the project file if one is open. */
  async save(): Promise<void> {
    const e = this.editor;
    e.commitFloating();
    const ok = await this.saveToLibrary(true);
    if (e.info.projectHandle) {
      try {
        const json = await projectToJSON(e.doc, this.extras());
        await writeToHandle(e.info.projectHandle, new Blob([json], { type: 'application/json' }));
        this.app.toast(`Saved ${e.info.projectHandle.name}`);
        return;
      } catch (err) {
        this.app.toast(`Could not write the project file: ${errorMessage(err)}`, true);
        return;
      }
    }
    if (ok) this.app.toast('Saved in this browser. Use “Save project as file” for a backup.');
  }

  async saveAsFile(): Promise<void> {
    const e = this.editor;
    e.commitFloating();
    try {
      const json = await projectToJSON(e.doc, this.extras());
      const res = await saveFileAs(new Blob([json], { type: 'application/json' }), fileNameFor(e.doc.name, PROJECT_EXT), [PROJECT_TYPES]);
      if (res.status === 'cancelled') return;
      if (res.status === 'saved') {
        e.info.projectHandle = res.handle;
        this.app.toast(`Saved ${res.handle.name}`);
      } else this.app.toast('Project file downloaded');
      void this.saveToLibrary(false);
    } catch (err) {
      this.app.toast(`Could not save: ${errorMessage(err)}`, true);
    }
  }

  // ---------------------------------------------------------- Exporting

  /** Renders the pixels to export according to the settings. */
  /** Frames to export for sheets and animations: all, or one tag's range (with its direction). */
  exportFrames(s: ExportSettings): number[] {
    const doc = this.editor.doc;
    const tag = s.tag >= 0 ? doc.tags[s.tag] : undefined;
    const from = tag ? tag.from : 0;
    const to = tag ? tag.to : doc.frames.length - 1;
    const out: number[] = [];
    for (let i = from; i <= to; i++) out.push(i);
    if (tag?.direction === 'reverse') out.reverse();
    else if (tag?.direction === 'pingpong' && s.content === 'animation') out.push(...out.slice(1, -1).reverse());
    return out;
  }

  renderExport(s: ExportSettings): {
    width: number;
    height: number;
    data: Pixels;
    frames?: { x: number; y: number; w: number; h: number; duration: number }[];
    /** Every frame, for animated formats. */
    animation?: { data: Pixels; duration: number }[];
  } {
    const doc = this.editor.doc;
    let width = doc.width;
    let height = doc.height;
    let data: Pixels;
    let frames: { x: number; y: number; w: number; h: number; duration: number }[] | undefined;
    if (s.content === 'layer') {
      data = doc.activeCel.data ? doc.activeCel.data.slice() : allocPixels(width, height);
    } else if (s.content === 'sheet' && doc.frames.length > 1) {
      const list = this.exportFrames(s);
      const n = list.length;
      const cols = Math.max(1, Math.min(n, s.columns || n));
      const rows = Math.ceil(n / cols);
      const pad = s.padding;
      width = cols * doc.width + (cols - 1) * pad;
      height = rows * doc.height + (rows - 1) * pad;
      data = allocPixels(width, height);
      frames = [];
      for (let i = 0; i < n; i++) {
        const fx = (i % cols) * (doc.width + pad);
        const fy = Math.floor(i / cols) * (doc.height + pad);
        const f = compositeFrame(doc, list[i]);
        for (let y = 0; y < doc.height; y++) data.set(f.subarray(y * doc.width * 4, (y + 1) * doc.width * 4), ((fy + y) * width + fx) * 4);
        frames.push({ x: fx, y: fy, w: doc.width, h: doc.height, duration: doc.frames[list[i]].duration });
      }
    } else {
      data = compositeFrame(doc, doc.activeFrame);
    }
    let animation: { data: Pixels; duration: number }[] | undefined;
    if (s.content === 'animation') animation = this.exportFrames(s).map((i) => ({ data: compositeFrame(doc, i), duration: doc.frames[i].duration }));
    if (s.scale !== 1) {
      const nw = Math.max(1, Math.round(width * s.scale));
      const nh = Math.max(1, Math.round(height * s.scale));
      const mode = s.scale > 1 ? 'nearest' : 'smooth';
      data = resizePixels(data, width, height, nw, nh, mode);
      animation = animation?.map((f) => ({ data: resizePixels(f.data, width, height, nw, nh, mode), duration: f.duration }));
      frames = frames?.map((f) => ({
        x: Math.round(f.x * s.scale),
        y: Math.round(f.y * s.scale),
        w: Math.round(f.w * s.scale),
        h: Math.round(f.h * s.scale),
        duration: f.duration,
      }));
      width = nw;
      height = nh;
    }
    return { width, height, data, frames, animation };
  }

  private encodeExport(out: ReturnType<ProjectFiles['renderExport']>, s: ExportSettings): Promise<Blob> {
    if (out.animation && isAnimatedFormat(s.format)) return encodeAnimation(out.width, out.height, out.animation, s.format);
    // Still formats only; an animated format without frames falls back to PNG.
    return encodeImage(out, isAnimatedFormat(s.format) ? 'png' : s.format, s.quality);
  }

  /** Tags for the sprite sheet JSON, with frame numbers relative to the exported frames. */
  private exportTags(s: ExportSettings): { name: string; from: number; to: number; direction: string; color: string }[] {
    const doc = this.editor.doc;
    const list = this.exportFrames(s);
    const first = list.length ? Math.min(...list) : 0;
    const last = list.length ? Math.max(...list) : 0;
    return doc.tags
      .filter((t) => t.to >= first && t.from <= last)
      .map((t) => ({ name: t.name, from: Math.max(t.from, first) - first, to: Math.min(t.to, last) - first, direction: t.direction, color: t.color }));
  }

  exportSize(s: ExportSettings): [number, number] {
    const doc = this.editor.doc;
    let w = doc.width;
    let h = doc.height;
    if (s.content === 'sheet' && doc.frames.length > 1) {
      const n = this.exportFrames(s).length;
      const cols = Math.max(1, Math.min(n, s.columns || n));
      const rows = Math.ceil(n / cols);
      w = cols * doc.width + (cols - 1) * s.padding;
      h = rows * doc.height + (rows - 1) * s.padding;
    }
    return [Math.max(1, Math.round(w * s.scale)), Math.max(1, Math.round(h * s.scale))];
  }

  async runExport(s: ExportSettings, name: string, share: boolean): Promise<boolean> {
    const e = this.editor;
    e.commitFloating();
    this.app.setBusy(true);
    try {
      const out = this.renderExport(s);
      const blob = await this.encodeExport(out, s);
      const fileName = fileNameFor(name || e.doc.name, FORMAT_EXT[s.format]);
      if (share) {
        await shareFile(blob, fileName);
        return true;
      }
      const res = await saveFileAs(blob, fileName, [
        {
          description: `${s.format === 'apng' ? 'Animated PNG' : s.format.toUpperCase()} image`,
          accept: { [FORMAT_MIME[s.format]]: [`.${FORMAT_EXT[s.format]}`] },
        },
      ]);
      if (res.status === 'cancelled') return false;
      if (res.status === 'saved') this.lastExport = { handle: res.handle, settings: { ...s }, name: res.handle.name };
      if (out.frames && s.json) {
        const meta = {
          frames: out.frames.map((f, i) => ({
            filename: `${baseName(fileName)} ${i}`,
            frame: { x: f.x, y: f.y, w: f.w, h: f.h },
            rotated: false,
            trimmed: false,
            spriteSourceSize: { x: 0, y: 0, w: f.w, h: f.h },
            sourceSize: { w: f.w, h: f.h },
            duration: f.duration,
          })),
          meta: {
            app: 'Art',
            version: __APP_VERSION__,
            image: fileName,
            format: 'RGBA8888',
            size: { w: out.width, h: out.height },
            scale: String(s.scale),
            // Same shape as Aseprite's JSON, relative to the exported frames.
            frameTags: this.exportTags(s),
          },
        };
        const jsonBlob = new Blob([JSON.stringify(meta, null, 2)], { type: 'application/json' });
        if (hasFileSystemAccess)
          await saveFileAs(jsonBlob, fileNameFor(fileName, 'json'), [{ description: 'JSON', accept: { 'application/json': ['.json'] } }]);
        else downloadBlob(jsonBlob, fileNameFor(fileName, 'json'));
      }
      this.app.toast(res.status === 'saved' ? `Exported ${res.handle.name}` : `Downloaded ${fileName}`);
      return true;
    } catch (err) {
      console.error(err);
      this.app.toast(`Export failed: ${errorMessage(err)}`, true);
      return false;
    } finally {
      this.app.setBusy(false);
    }
  }

  async reExport(): Promise<boolean> {
    const last = this.lastExport;
    if (!last) return false;
    const e = this.editor;
    e.commitFloating();
    try {
      const out = this.renderExport(last.settings);
      const blob = await this.encodeExport(out, last.settings);
      await writeToHandle(last.handle, blob);
      this.app.toast(`Exported ${last.name}`);
      return true;
    } catch (err) {
      this.app.toast(`Export failed: ${errorMessage(err)}`, true);
      return false;
    }
  }

  // ------------------------------------------------------------ Palettes

  async importPalette(): Promise<void> {
    const files = await pickFiles([{ description: 'Palettes', accept: { 'text/plain': ['.gpl', '.hex', '.txt', '.pal'], 'application/json': ['.json'] } }]);
    if (!files.length) return;
    const text = await files[0].file.text();
    const bundle = parsePaletteBundle(text);
    if (bundle) {
      // "My palettes" exported from another device.
      const added = this.editor.addCustomPalettes(bundle);
      const skipped = bundle.length - added;
      this.app.toast(
        bundle.length ? `Imported ${added} palette${added === 1 ? '' : 's'}${skipped ? ` (${skipped} already saved)` : ''}` : 'That palette file is empty',
        !bundle.length,
      );
      return;
    }
    const colors = parsePalette(text);
    if (!colors) {
      this.app.toast('No colors found in that file', true);
      return;
    }
    // Imported palettes are saved to the palette library, so they stay available.
    const name = paletteNameFromFile(text) ?? baseName(files[0].file.name);
    this.editor.createCustomPalette(name, colors);
    this.editor.markChanged();
    this.app.toast(`Imported “${name}” (${colors.length} colors)`);
  }

  /** Saves every palette in My palettes as one file (to move them to another device). */
  async exportPaletteBundle(): Promise<void> {
    const list = this.editor.customPalettes;
    if (!list.length) {
      this.app.toast('My palettes is empty: create, copy or import a palette first');
      return;
    }
    await saveFileAs(new Blob([toPaletteBundle(list)], { type: 'application/json' }), 'my-palettes.art-palettes.json', [
      { description: 'Palette collection', accept: { 'application/json': ['.json'] } },
    ]);
  }

  async exportPalette(format: 'gpl' | 'hex', name = this.editor.paletteName, colors = this.editor.palette): Promise<void> {
    const text = format === 'gpl' ? toGpl(colors, name) : toHexList(colors);
    await saveFileAs(new Blob([text], { type: 'text/plain' }), fileNameFor(name, format), [
      { description: 'Palette', accept: { 'text/plain': [`.${format}`] } },
    ]);
  }
}

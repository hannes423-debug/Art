import type { App } from './app';
import {
  addFrame,
  addLayer,
  clearPixels,
  cropTo,
  deleteFrame,
  deleteLayer,
  duplicateLayer,
  fillPixels,
  flattenImage,
  flipImage,
  flipLayer,
  linkWithPrevious,
  mergeDown,
  moveLayer,
  rotateImage,
  selectionFromAlpha,
  setLayerProps,
  trimImage,
  unlinkCel,
} from './ops';
import type { ToolId } from './tools/tool';
import { promptDialog } from './ui/dialog';
import type { IconName } from './ui/icons';

export interface Action {
  id: string;
  label: string;
  /** Key combos, e.g. 'mod+z' (mod = Ctrl, or ⌘ on Apple). The first is shown in menus. */
  keys?: string[];
  icon?: IconName;
  run: () => unknown;
  enabled?: () => boolean;
  checked?: () => boolean;
  /** Hidden entirely when false (e.g. a browser lacks the feature). */
  available?: () => boolean;
}

export interface MenuDef {
  id: string;
  label: string;
  items: string[];
}

/** Normalizes a keyboard event to the same combo format used in Action.keys. */
export function eventCombo(e: KeyboardEvent): string {
  let key = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();
  if (key === ' ') key = 'space';
  // With Alt (Option on macOS) e.key is a special character; use the physical key.
  if (e.altKey && /^Key[A-Z]$/.test(e.code)) key = e.code.slice(3).toLowerCase();
  if (e.altKey && /^Digit\d$/.test(e.code)) key = e.code.slice(5);
  if (e.altKey && e.code === 'Equal') key = '=';
  if (e.altKey && e.code === 'Minus') key = '-';
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('mod');
  if (e.altKey) parts.push('alt');
  // Shifted symbols ('+', '?', '{') already encode Shift in the character.
  if (e.shiftKey && !(key.length === 1 && !/[a-z0-9]/.test(key))) parts.push('shift');
  parts.push(key);
  return parts.join('+');
}

export class ActionRegistry {
  private map = new Map<string, Action>();
  private keys = new Map<string, Action>();

  add(...actions: Action[]): void {
    for (const a of actions) {
      this.map.set(a.id, a);
      for (const k of a.keys ?? []) this.keys.set(k, a);
    }
  }

  get(id: string): Action | undefined {
    return this.map.get(id);
  }

  all(): Action[] {
    return [...this.map.values()];
  }

  match(e: KeyboardEvent): Action | undefined {
    return this.keys.get(eventCombo(e));
  }

  run(id: string): void {
    const a = this.map.get(id);
    if (a && (!a.enabled || a.enabled())) void a.run();
  }
}

export const MENUS: MenuDef[] = [
  {
    id: 'file',
    label: 'File',
    items: [
      'file.new',
      'file.open',
      'file.projects',
      '-',
      'file.save',
      'file.saveAs',
      '-',
      'file.importLayer',
      'file.importSheet',
      '-',
      'file.export',
      'file.exportAnim',
      'file.reexport',
    ],
  },
  {
    id: 'edit',
    label: 'Edit',
    items: [
      'edit.undo',
      'edit.redo',
      '-',
      'edit.cut',
      'edit.copy',
      'edit.copyMerged',
      'edit.transform',
      'edit.paste',
      'edit.pasteLayer',
      '-',
      'edit.clear',
      'edit.fillFg',
      'edit.fillBg',
      'edit.replaceColor',
      '-',
      'app.settings',
    ],
  },
  {
    id: 'select',
    label: 'Select',
    items: [
      'select.all',
      'select.none',
      'select.invert',
      'select.alpha',
      'select.color',
      '-',
      'select.grow',
      'select.shrink',
      'select.border',
      'select.feather',
      'select.grow1',
      'select.shrink1',
      '-',
      'image.cropSel',
    ],
  },
  {
    id: 'image',
    label: 'Image',
    items: [
      'image.canvasSize',
      'image.scale',
      '-',
      'image.cropSel',
      'image.trim',
      '-',
      'image.toPalette',
      'colors.lockPalette',
      '-',
      'image.flipH',
      'image.flipV',
      'image.rotateCW',
      'image.rotateCCW',
      'image.rotate180',
      '-',
      'image.flatten',
    ],
  },
  {
    id: 'layer',
    label: 'Layer',
    items: [
      'layer.new',
      'layer.duplicate',
      'layer.rename',
      'layer.delete',
      '-',
      'layer.up',
      'layer.down',
      'layer.mergeDown',
      '-',
      'layer.alphaLock',
      'layer.flipH',
      'layer.flipV',
    ],
  },
  {
    id: 'frame',
    label: 'Frame',
    items: [
      'frame.new',
      'frame.duplicate',
      'frame.linked',
      'frame.delete',
      '-',
      'frame.link',
      'frame.unlink',
      'frame.tag',
      'frame.editTag',
      '-',
      'frame.prev',
      'frame.next',
      'frame.play',
      '-',
      'view.onion',
      'view.timeline',
      '-',
      'file.exportAnim',
    ],
  },
  {
    id: 'view',
    label: 'View',
    items: [
      'view.zoomIn',
      'view.zoomOut',
      'view.fit',
      'view.actual',
      '-',
      'view.rotateLeft',
      'view.rotateRight',
      'view.resetRotation',
      'view.flip',
      '-',
      'view.pixelGrid',
      'view.grid',
      'view.snap',
      'view.gridSettings',
      'view.smooth',
      '-',
      'view.symmetryX',
      'view.symmetryY',
      'view.symmetryAxis',
      '-',
      'view.tile',
      'view.tileX',
      'view.tileY',
      '-',
      'view.reference',
      'view.timeline',
      'view.panel',
      'view.canvasOnly',
      'view.fullscreen',
    ],
  },
  { id: 'help', label: 'Help', items: ['help.shortcuts', 'help.about'] },
];

const TOOL_KEYS: [ToolId, string[]][] = [
  ['brush', ['b']],
  ['pencil', ['p']],
  ['eraser', ['e']],
  ['shade', ['k']],
  ['line', ['l']],
  ['rect', ['u']],
  ['ellipse', ['o']],
  ['fill', ['g']],
  ['gradient', ['shift+g']],
  ['text', ['t']],
  ['picker', ['i']],
  ['select-rect', ['s']],
  ['lasso', ['q']],
  ['wand', ['w']],
  ['move', ['m', 'v']],
  ['hand', ['h']],
];

export function createActions(app: App): ActionRegistry {
  const r = new ActionRegistry();
  const e = app.editor;
  const doc = () => e.doc;
  const hist = () => e.history;
  const hasSel = () => e.doc.selection.active;
  const multiFrame = () => e.doc.frames.length > 1;
  const editable = () => {
    if (!e.canEditPixels()) return false;
    return true;
  };

  r.add(
    // File
    { id: 'file.new', label: 'New image…', keys: ['mod+alt+n'], icon: 'plus', run: () => app.showNewDialog() },
    { id: 'file.open', label: 'Open…', keys: ['mod+o'], icon: 'open', run: () => app.open() },
    { id: 'file.projects', label: 'Recent projects…', icon: 'layers', run: () => app.showProjects() },
    { id: 'file.save', label: 'Save', keys: ['mod+s'], icon: 'save', run: () => app.save() },
    { id: 'file.saveAs', label: 'Save project as file…', keys: ['mod+shift+s'], icon: 'download', run: () => app.saveAsFile() },
    { id: 'file.importLayer', label: 'Import image as layer…', icon: 'image', run: () => app.importAsLayer() },
    { id: 'file.importSheet', label: 'Import sprite sheet…', icon: 'film', run: () => app.importSpriteSheet() },
    { id: 'file.export', label: 'Export image…', keys: ['mod+e'], icon: 'share', run: () => app.showExport() },
    { id: 'file.exportAnim', label: 'Export animation (GIF/APNG)…', icon: 'film', run: () => app.showExport('animation') },
    {
      id: 'file.reexport',
      label: 'Export again',
      keys: ['mod+shift+e'],
      run: () => app.reExport(),
      enabled: () => app.canReExport(),
    },

    // Edit
    { id: 'edit.undo', label: 'Undo', keys: ['mod+z'], icon: 'undo', run: () => e.history.undo(), enabled: () => e.history.canUndo || !!e.floating },
    { id: 'edit.redo', label: 'Redo', keys: ['mod+shift+z', 'mod+y'], icon: 'redo', run: () => e.history.redo(), enabled: () => e.history.canRedo },
    { id: 'edit.cut', label: 'Cut', keys: ['mod+x'], run: () => app.cut() },
    { id: 'edit.copy', label: 'Copy', keys: ['mod+c'], run: () => app.copy(false) },
    { id: 'edit.copyMerged', label: 'Copy merged', keys: ['mod+shift+c'], run: () => app.copy(true) },
    { id: 'edit.transform', label: 'Transform (scale, rotate)', keys: ['shift+t'], run: () => e.startTransform() },
    { id: 'edit.paste', label: 'Paste', run: () => app.pasteFromMenu(false) },
    { id: 'edit.pasteLayer', label: 'Paste as new layer', run: () => app.pasteFromMenu(true) },
    {
      id: 'edit.clear',
      label: 'Clear',
      keys: ['delete', 'backspace'],
      run: () => {
        if (e.floating) e.cancelFloating();
        else if (editable()) clearPixels(doc(), hist());
      },
    },
    {
      id: 'edit.fillFg',
      label: 'Fill with foreground',
      keys: ['alt+backspace', 'alt+delete'],
      run: () => editable() && fillPixels(doc(), hist(), e.fg, doc().activeLayer.alphaLocked),
    },
    {
      id: 'edit.fillBg',
      label: 'Fill with background',
      keys: ['mod+backspace'],
      run: () => editable() && fillPixels(doc(), hist(), e.bg, doc().activeLayer.alphaLocked),
    },
    {
      id: 'edit.replaceColor',
      label: 'Replace color…',
      keys: ['shift+r'],
      run: () => app.showReplaceColor(),
    },
    { id: 'app.settings', label: 'Settings…', icon: 'settings', run: () => app.showSettings() },

    // Select
    { id: 'select.all', label: 'Select all', keys: ['mod+a'], run: () => e.selectAll() },
    { id: 'select.none', label: 'Deselect', keys: ['mod+d', 'mod+shift+a'], run: () => e.deselect(), enabled: hasSel },
    { id: 'select.invert', label: 'Invert selection', keys: ['mod+shift+i'], run: () => e.invertSelection() },
    { id: 'select.alpha', label: 'Select layer content', run: () => selectionFromAlpha(doc(), hist()) },
    { id: 'select.grow', label: 'Grow selection…', run: () => app.showModifySelection('grow'), enabled: hasSel },
    { id: 'select.shrink', label: 'Shrink selection…', run: () => app.showModifySelection('shrink'), enabled: hasSel },
    { id: 'select.border', label: 'Border selection…', run: () => app.showModifySelection('border'), enabled: hasSel },
    { id: 'select.feather', label: 'Feather selection…', run: () => app.showModifySelection('feather'), enabled: hasSel },
    { id: 'select.color', label: 'Select by color…', run: () => app.showSelectColor() },
    {
      id: 'select.grow1',
      label: 'Grow by 1px',
      keys: ['mod+alt+='],
      run: () => e.modifySelection({ kind: 'grow', radius: 1, shape: 'square' }),
      enabled: hasSel,
    },
    {
      id: 'select.shrink1',
      label: 'Shrink by 1px',
      keys: ['mod+alt+-'],
      run: () => e.modifySelection({ kind: 'shrink', radius: 1, shape: 'square', fromCanvasEdge: true }),
      enabled: hasSel,
    },

    // Image
    { id: 'image.canvasSize', label: 'Canvas size…', run: () => app.showCanvasSize() },
    { id: 'image.scale', label: 'Scale image…', run: () => app.showScaleImage() },
    { id: 'image.cropSel', label: 'Crop to selection', icon: 'crop', run: () => cropTo(doc(), hist(), doc().selection.bounds!), enabled: hasSel },
    { id: 'image.trim', label: 'Trim transparent edges', run: () => trimImage(doc(), hist()) || e.toast('The image is empty') },
    { id: 'image.toPalette', label: 'Map colors to palette…', run: () => app.showMapToPalette() },
    {
      id: 'colors.lockPalette',
      label: 'Lock colors to palette',
      run: () => e.setPaletteLock(!e.settings.paletteLock),
      checked: () => e.settings.paletteLock,
    },
    { id: 'image.flipH', label: 'Flip image horizontally', run: () => flipImage(doc(), hist(), true) },
    { id: 'image.flipV', label: 'Flip image vertically', run: () => flipImage(doc(), hist(), false) },
    { id: 'image.rotateCW', label: 'Rotate 90° clockwise', run: () => rotateImage(doc(), hist(), 'cw') },
    { id: 'image.rotateCCW', label: 'Rotate 90° counter-clockwise', run: () => rotateImage(doc(), hist(), 'ccw') },
    { id: 'image.rotate180', label: 'Rotate 180°', run: () => rotateImage(doc(), hist(), '180') },
    { id: 'image.flatten', label: 'Flatten image', run: () => flattenImage(doc(), hist()), enabled: () => doc().layers.length > 1 },

    // Layer
    { id: 'layer.new', label: 'New layer', keys: ['shift+n'], icon: 'plus', run: () => addLayer(doc(), hist()) },
    { id: 'layer.duplicate', label: 'Duplicate layer', keys: ['mod+j'], icon: 'duplicate', run: () => duplicateLayer(doc(), hist()) },
    {
      id: 'layer.rename',
      label: 'Rename layer…',
      run: async () => {
        const l = doc().activeLayer;
        const name = await promptDialog('Rename layer', 'Name', l.name, 'Rename');
        if (name && name.trim() && name.trim() !== l.name) setLayerProps(doc(), hist(), l, { name: name.trim() }, 'Rename layer');
      },
    },
    {
      id: 'layer.delete',
      label: 'Delete layer',
      icon: 'trash',
      run: () => deleteLayer(doc(), hist()) || e.toast('A document needs at least one layer'),
      enabled: () => doc().layers.length > 1,
    },
    { id: 'layer.up', label: 'Move layer up', keys: ['mod+]'], run: () => moveLayer(doc(), hist(), doc().activeLayer, doc().activeLayerIndex + 1) },
    { id: 'layer.down', label: 'Move layer down', keys: ['mod+['], run: () => moveLayer(doc(), hist(), doc().activeLayer, doc().activeLayerIndex - 1) },
    {
      id: 'layer.mergeDown',
      label: 'Merge down',
      icon: 'merge-down',
      run: () => {
        const problem = mergeDown(doc(), hist());
        if (problem) e.toast(problem);
      },
      enabled: () => doc().activeLayerIndex > 0,
    },
    {
      id: 'layer.alphaLock',
      label: 'Lock alpha',
      run: () => setLayerProps(doc(), hist(), doc().activeLayer, { alphaLocked: !doc().activeLayer.alphaLocked }, 'Lock alpha'),
      checked: () => doc().activeLayer.alphaLocked,
    },
    { id: 'layer.flipH', label: 'Flip layer horizontally', run: () => editable() && flipLayer(doc(), hist(), true) },
    { id: 'layer.flipV', label: 'Flip layer vertically', run: () => editable() && flipLayer(doc(), hist(), false) },

    // Frames
    { id: 'frame.new', label: 'New frame', keys: ['alt+n'], run: () => addFrame(doc(), hist(), false) },
    { id: 'frame.duplicate', label: 'Duplicate frame', keys: ['alt+d'], run: () => addFrame(doc(), hist(), true) },
    { id: 'frame.linked', label: 'New linked frame', keys: ['alt+l'], run: () => addFrame(doc(), hist(), 'linked') },
    {
      id: 'frame.link',
      label: 'Link cel with previous frame',
      run: () => {
        const err = linkWithPrevious(doc(), hist());
        if (err) e.toast(err);
      },
      enabled: () => doc().activeFrame > 0,
    },
    {
      id: 'frame.unlink',
      label: 'Unlink cel',
      run: () => unlinkCel(doc(), hist()),
      enabled: () => doc().isLinked(doc().activeLayer, doc().activeFrame),
    },
    { id: 'frame.tag', label: 'New tag…', run: () => app.showTagDialog(null) },
    {
      id: 'frame.editTag',
      label: 'Edit tag of this frame…',
      run: () => app.showTagDialog(doc().tags.indexOf(doc().tagAt(doc().activeFrame)!)),
      enabled: () => !!doc().tagAt(doc().activeFrame),
    },
    { id: 'frame.delete', label: 'Delete frame', run: () => deleteFrame(doc(), hist()), enabled: multiFrame },
    { id: 'frame.prev', label: 'Previous frame', keys: [','], run: () => app.stepFrame(-1), enabled: multiFrame },
    { id: 'frame.next', label: 'Next frame', keys: ['.'], run: () => app.stepFrame(1), enabled: multiFrame },
    { id: 'frame.play', label: 'Play animation', run: () => (e.playing ? e.stop() : e.play()), checked: () => e.playing, enabled: multiFrame },

    // View
    { id: 'view.zoomIn', label: 'Zoom in', keys: ['+', '=', 'mod+=', 'mod++'], icon: 'zoom-in', run: () => e.zoomBy(1) },
    { id: 'view.zoomOut', label: 'Zoom out', keys: ['-', 'mod+-'], icon: 'zoom-out', run: () => e.zoomBy(-1) },
    { id: 'view.fit', label: 'Fit to screen', keys: ['mod+0', '0'], icon: 'fit', run: () => e.fitView() },
    { id: 'view.actual', label: 'Actual pixels (100%)', keys: ['mod+1', '1'], run: () => e.actualPixels() },
    { id: 'view.rotateLeft', label: 'Rotate view left', keys: ['4'], icon: 'rotate-ccw', run: () => e.rotateViewBy(-15) },
    { id: 'view.rotateRight', label: 'Rotate view right', keys: ['6'], icon: 'rotate-cw', run: () => e.rotateViewBy(15) },
    { id: 'view.resetRotation', label: 'Reset rotation', keys: ['5'], run: () => e.resetRotation(), enabled: () => e.view.rotation !== 0 },
    { id: 'view.flip', label: 'Mirror view', keys: ['shift+h'], icon: 'flip', run: () => e.flipView(), checked: () => e.view.flipX },
    {
      id: 'view.pixelGrid',
      label: 'Pixel grid (when zoomed in)',
      run: () => e.updateSettings({ pixelGrid: !e.settings.pixelGrid }),
      checked: () => e.settings.pixelGrid,
    },
    {
      id: 'view.grid',
      label: 'Show grid',
      keys: ["mod+'"],
      icon: 'grid',
      run: () => e.updateSettings({ grid: { ...e.settings.grid, enabled: !e.settings.grid.enabled } }),
      checked: () => e.settings.grid.enabled,
    },
    {
      id: 'view.snap',
      label: 'Snap to grid',
      keys: ["mod+shift+'", 'mod+shift+"'],
      run: () => e.updateSettings({ snapToGrid: !e.settings.snapToGrid }),
      checked: () => e.settings.snapToGrid,
    },
    { id: 'view.gridSettings', label: 'Grid settings…', run: () => app.showGridSettings() },
    {
      id: 'view.smooth',
      label: 'Smooth zoom (not pixel-crisp)',
      run: () => e.updateSettings({ smooth: !e.settings.smooth }),
      checked: () => e.settings.smooth,
    },
    {
      id: 'view.symmetryX',
      label: 'Symmetry: mirror left ↔ right',
      keys: ['alt+x'],
      run: () => {
        const m = e.options.symmetry.mode;
        e.setSymmetry({ mode: m === 'x' ? 'off' : m === 'y' ? 'xy' : m === 'xy' ? 'y' : 'x' });
        if (e.options.symmetry.mode !== 'off' && !e.toolUsesSymmetry()) e.setTool('pencil');
      },
      checked: () => e.options.symmetry.mode === 'x' || e.options.symmetry.mode === 'xy',
    },
    {
      id: 'view.symmetryY',
      label: 'Symmetry: mirror top ↔ bottom',
      keys: ['alt+y'],
      run: () => {
        const m = e.options.symmetry.mode;
        e.setSymmetry({ mode: m === 'y' ? 'off' : m === 'x' ? 'xy' : m === 'xy' ? 'x' : 'y' });
        if (e.options.symmetry.mode !== 'off' && !e.toolUsesSymmetry()) e.setTool('pencil');
      },
      checked: () => e.options.symmetry.mode === 'y' || e.options.symmetry.mode === 'xy',
    },
    {
      id: 'view.reference',
      label: 'Reference image…',
      keys: ['alt+r'],
      icon: 'image',
      run: () => app.toggleReference(),
      checked: () => app.reference.visible,
    },
    { id: 'view.symmetryAxis', label: 'Symmetry settings…', run: () => app.showSymmetryAxis() },
    {
      id: 'view.tile',
      label: 'Tile preview',
      keys: ['alt+t'],
      run: () => e.updateSettings({ tileMode: e.settings.tileMode === 'both' ? 'off' : 'both' }),
      checked: () => e.settings.tileMode === 'both',
    },
    {
      id: 'view.tileX',
      label: 'Tile preview: horizontal only',
      run: () => e.updateSettings({ tileMode: e.settings.tileMode === 'x' ? 'off' : 'x' }),
      checked: () => e.settings.tileMode === 'x',
    },
    {
      id: 'view.tileY',
      label: 'Tile preview: vertical only',
      run: () => e.updateSettings({ tileMode: e.settings.tileMode === 'y' ? 'off' : 'y' }),
      checked: () => e.settings.tileMode === 'y',
    },
    { id: 'view.onion', label: 'Onion skin', run: () => e.updateSettings({ onionSkin: !e.settings.onionSkin }), checked: () => e.settings.onionSkin },
    {
      id: 'view.timeline',
      label: 'Frames panel',
      keys: ['mod+shift+f'],
      icon: 'film',
      run: () => app.toggleTimeline(),
      checked: () => e.settings.showTimeline,
    },
    {
      id: 'view.panel',
      label: 'Side panel',
      keys: ['f7'],
      icon: 'panel',
      run: () => app.toggleSidePanel(),
      checked: () => e.settings.sidePanel,
      available: () => app.layout === 'desktop',
    },
    { id: 'view.canvasOnly', label: 'Canvas only', keys: ['tab'], icon: 'focus', run: () => app.toggleCanvasOnly(), checked: () => app.canvasOnly },
    {
      id: 'view.fullscreen',
      label: 'Fullscreen',
      keys: ['f'],
      icon: 'fullscreen',
      run: () => app.toggleFullscreen(),
      checked: () => !!document.fullscreenElement,
      available: () => !!document.fullscreenEnabled,
    },

    // Help
    { id: 'help.shortcuts', label: 'Keyboard shortcuts & gestures', keys: ['?', 'f1'], run: () => app.showShortcuts() },
    { id: 'help.about', label: 'About Art', run: () => app.showAbout() },

    // Hidden (keyboard-only) actions
    { id: 'colors.swap', label: 'Swap colors', keys: ['x'], run: () => e.swapColors() },
    { id: 'colors.reset', label: 'Default colors', keys: ['d'], run: () => e.resetColors() },
    { id: 'tool.sizeDown', label: 'Decrease size', keys: ['['], run: () => app.adjustSize(-1) },
    { id: 'tool.sizeUp', label: 'Increase size', keys: [']'], run: () => app.adjustSize(1) },
    { id: 'app.escape', label: 'Cancel', keys: ['escape'], run: () => app.escape() },
    { id: 'app.enter', label: 'Apply', keys: ['enter'], run: () => e.commitFloating() },
  );
  for (const [id, keys] of TOOL_KEYS) {
    r.add({ id: `tool.${id}`, label: e.tools[id].label, keys, run: () => e.setTool(id) });
  }
  r.add({ id: 'tool.ellipseSelect', label: 'Ellipse select', keys: ['shift+s'], run: () => e.setTool('select-ellipse') });
  for (let n = 1; n <= 9; n++) {
    r.add({ id: `tool.opacity${n}`, label: `Opacity ${n * 10}%`, keys: [`alt+${n}`], run: () => app.setToolOpacity(n / 10) });
  }
  r.add({ id: 'tool.opacity10', label: 'Opacity 100%', keys: ['alt+0'], run: () => app.setToolOpacity(1) });
  return r;
}

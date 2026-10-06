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
  mergeDown,
  moveLayer,
  rotateImage,
  selectionFromAlpha,
  setLayerProps,
  trimImage,
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
    items: ['file.new', 'file.open', 'file.projects', '-', 'file.save', 'file.saveAs', '-', 'file.importLayer', 'file.importSheet', '-', 'file.export', 'file.reexport'],
  },
  {
    id: 'edit',
    label: 'Edit',
    items: ['edit.undo', 'edit.redo', '-', 'edit.cut', 'edit.copy', 'edit.copyMerged', 'edit.paste', 'edit.pasteLayer', '-', 'edit.clear', 'edit.fillFg', 'edit.fillBg', '-', 'app.settings'],
  },
  { id: 'select', label: 'Select', items: ['select.all', 'select.none', 'select.invert', 'select.alpha', '-', 'image.cropSel'] },
  {
    id: 'image',
    label: 'Image',
    items: ['image.canvasSize', 'image.scale', '-', 'image.cropSel', 'image.trim', '-', 'image.flipH', 'image.flipV', 'image.rotateCW', 'image.rotateCCW', 'image.rotate180', '-', 'image.flatten'],
  },
  {
    id: 'layer',
    label: 'Layer',
    items: ['layer.new', 'layer.duplicate', 'layer.rename', 'layer.delete', '-', 'layer.up', 'layer.down', 'layer.mergeDown', '-', 'layer.alphaLock', 'layer.flipH', 'layer.flipV'],
  },
  {
    id: 'frame',
    label: 'Frame',
    items: ['frame.new', 'frame.duplicate', 'frame.delete', '-', 'frame.prev', 'frame.next', 'frame.play', '-', 'view.onion', 'view.timeline'],
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
  ['line', ['l']],
  ['rect', ['u']],
  ['ellipse', ['o']],
  ['fill', ['g']],
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
    { id: 'edit.fillFg', label: 'Fill with foreground', keys: ['alt+backspace', 'alt+delete'], run: () => editable() && fillPixels(doc(), hist(), e.fg, doc().activeLayer.alphaLocked) },
    { id: 'edit.fillBg', label: 'Fill with background', keys: ['mod+backspace'], run: () => editable() && fillPixels(doc(), hist(), e.bg, doc().activeLayer.alphaLocked) },
    { id: 'app.settings', label: 'Settings…', icon: 'settings', run: () => app.showSettings() },

    // Select
    { id: 'select.all', label: 'Select all', keys: ['mod+a'], run: () => e.selectAll() },
    { id: 'select.none', label: 'Deselect', keys: ['mod+d', 'mod+shift+a'], run: () => e.deselect(), enabled: hasSel },
    { id: 'select.invert', label: 'Invert selection', keys: ['mod+shift+i'], run: () => e.invertSelection() },
    { id: 'select.alpha', label: 'Select layer content', run: () => selectionFromAlpha(doc(), hist()) },

    // Image
    { id: 'image.canvasSize', label: 'Canvas size…', run: () => app.showCanvasSize() },
    { id: 'image.scale', label: 'Scale image…', run: () => app.showScaleImage() },
    { id: 'image.cropSel', label: 'Crop to selection', icon: 'crop', run: () => cropTo(doc(), hist(), doc().selection.bounds!), enabled: hasSel },
    { id: 'image.trim', label: 'Trim transparent edges', run: () => trimImage(doc(), hist()) || e.toast('The image is empty') },
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
    { id: 'layer.delete', label: 'Delete layer', icon: 'trash', run: () => deleteLayer(doc(), hist()) || e.toast('A document needs at least one layer'), enabled: () => doc().layers.length > 1 },
    { id: 'layer.up', label: 'Move layer up', keys: ['mod+]'], run: () => moveLayer(doc(), hist(), doc().activeLayer, doc().activeLayerIndex + 1) },
    { id: 'layer.down', label: 'Move layer down', keys: ['mod+['], run: () => moveLayer(doc(), hist(), doc().activeLayer, doc().activeLayerIndex - 1) },
    { id: 'layer.mergeDown', label: 'Merge down', icon: 'merge-down', run: () => mergeDown(doc(), hist()) || e.toast('There is no layer below'), enabled: () => doc().activeLayerIndex > 0 },
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
    { id: 'view.pixelGrid', label: 'Pixel grid (when zoomed in)', run: () => e.updateSettings({ pixelGrid: !e.settings.pixelGrid }), checked: () => e.settings.pixelGrid },
    {
      id: 'view.grid',
      label: 'Show grid',
      keys: ["mod+'"],
      icon: 'grid',
      run: () => e.updateSettings({ grid: { ...e.settings.grid, enabled: !e.settings.grid.enabled } }),
      checked: () => e.settings.grid.enabled,
    },
    { id: 'view.snap', label: 'Snap to grid', keys: ["mod+shift+'", 'mod+shift+"'], run: () => e.updateSettings({ snapToGrid: !e.settings.snapToGrid }), checked: () => e.settings.snapToGrid },
    { id: 'view.gridSettings', label: 'Grid settings…', run: () => app.showGridSettings() },
    { id: 'view.smooth', label: 'Smooth zoom (not pixel-crisp)', run: () => e.updateSettings({ smooth: !e.settings.smooth }), checked: () => e.settings.smooth },
    { id: 'view.onion', label: 'Onion skin', run: () => e.updateSettings({ onionSkin: !e.settings.onionSkin }), checked: () => e.settings.onionSkin },
    { id: 'view.timeline', label: 'Frames panel', keys: ['mod+shift+f'], icon: 'film', run: () => app.toggleTimeline(), checked: () => e.settings.showTimeline },
    { id: 'view.panel', label: 'Side panel', keys: ['f7'], icon: 'panel', run: () => app.toggleSidePanel(), checked: () => e.settings.sidePanel, available: () => app.layout === 'desktop' },
    { id: 'view.canvasOnly', label: 'Canvas only', keys: ['tab'], icon: 'focus', run: () => app.toggleCanvasOnly(), checked: () => app.canvasOnly },
    { id: 'view.fullscreen', label: 'Fullscreen', keys: ['f'], icon: 'fullscreen', run: () => app.toggleFullscreen(), checked: () => !!document.fullscreenElement, available: () => !!document.fullscreenEnabled },

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

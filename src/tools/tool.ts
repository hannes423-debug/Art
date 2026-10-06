import type { Editor } from '../editor';
import type { Overlay } from '../render/renderer';
import type { Viewport } from '../render/viewport';

export type ToolId =
  | 'brush'
  | 'pencil'
  | 'eraser'
  | 'line'
  | 'rect'
  | 'ellipse'
  | 'fill'
  | 'picker'
  | 'select-rect'
  | 'select-ellipse'
  | 'lasso'
  | 'wand'
  | 'move'
  | 'hand';

/** A pointer sample in both document and screen space. */
export interface ToolPointer {
  /** Document coordinates (fractional). */
  x: number;
  y: number;
  /** Screen coordinates relative to the canvas element (CSS px). */
  sx: number;
  sy: number;
  /** 0..1. Real pressure for pens, 1 otherwise. */
  pressure: number;
  pointerType: 'mouse' | 'pen' | 'touch';
  /** 0 = primary, 2 = secondary (right mouse button). */
  button: number;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  time: number;
}

/** Declarative description of a tool option; rendered by the options bar and the mobile sheet. */
export type OptionSpec =
  | { type: 'slider'; key: string; label: string; min: number; max: number; step?: number; unit?: string; percent?: boolean; log?: boolean }
  | { type: 'toggle'; key: string; label: string; title?: string }
  | { type: 'choice'; key: string; label: string; choices: { value: string; label: string; title?: string }[] };

export abstract class Tool implements Overlay {
  abstract readonly id: ToolId;
  abstract readonly label: string;
  /** Single-key shortcut shown in tooltips. */
  readonly shortcut: string = '';
  /** Key into editor.options holding this tool's settings. */
  readonly optionsKey: string = '';
  readonly optionSpecs: OptionSpec[] = [];
  /** CSS cursor while hovering the canvas. */
  cursor = 'crosshair';
  /** Paint tools use the secondary color on right-click. */
  readonly paints: boolean = false;
  /** Alt+click temporarily picks a color instead. */
  readonly altPicks: boolean = false;
  /** Tools that modify pixels of the active layer (blocked on hidden layers). */
  readonly editsPixels: boolean = false;

  protected readonly editor: Editor;
  /** Last hover/drag position, for cursor overlays. */
  protected hoverPoint: ToolPointer | null = null;

  constructor(editor: Editor) {
    this.editor = editor;
  }

  /** True while a drag/stroke is in progress. */
  get busy(): boolean {
    return false;
  }

  down(_p: ToolPointer): void {}
  move(_p: ToolPointer): void {}
  up(_p: ToolPointer): void {}
  /** Abort the current interaction without leaving changes (e.g. a pinch started). */
  cancel(): void {}
  hover(p: ToolPointer | null): void {
    const had = this.hoverPoint !== null || p !== null;
    this.hoverPoint = p;
    if (had && this.hasCursorOverlay()) this.editor.renderer.requestRender();
  }
  activate(): void {}
  deactivate(): void {
    this.hoverPoint = null;
  }
  /** Return true if the key was handled. */
  keyDown(_e: KeyboardEvent): boolean {
    return false;
  }
  protected hasCursorOverlay(): boolean {
    return false;
  }
  drawOverlay(_ctx: CanvasRenderingContext2D, _view: Viewport): void {}
}

/** Options shared by the drawing tools. Persisted in settings. */
export interface ToolOptions {
  brush: { size: number; opacity: number; hardness: number; pressureSize: boolean; pressureOpacity: boolean; smoothing: number };
  pencil: { size: number; opacity: number; pixelPerfect: boolean; round: boolean };
  eraser: { size: number; opacity: number; hardness: number; pressureSize: boolean; pressureOpacity: boolean; pixel: boolean; smoothing: number };
  shape: { size: number; opacity: number; fill: boolean; antialias: boolean };
  fill: { tolerance: number; contiguous: boolean; sampleMerged: boolean; opacity: number };
  picker: { sampleMerged: boolean };
  select: { mode: 'replace' | 'add' | 'subtract' | 'intersect' };
  wand: { tolerance: number; contiguous: boolean; sampleMerged: boolean };
}

export function defaultToolOptions(): ToolOptions {
  return {
    brush: { size: 8, opacity: 1, hardness: 0.8, pressureSize: true, pressureOpacity: false, smoothing: 0 },
    pencil: { size: 1, opacity: 1, pixelPerfect: false, round: false },
    eraser: { size: 8, opacity: 1, hardness: 1, pressureSize: false, pressureOpacity: false, pixel: true, smoothing: 0 },
    shape: { size: 1, opacity: 1, fill: false, antialias: false },
    fill: { tolerance: 0, contiguous: true, sampleMerged: false, opacity: 1 },
    picker: { sampleMerged: true },
    select: { mode: 'replace' },
    wand: { tolerance: 0, contiguous: true, sampleMerged: false },
  };
}

export const SELECT_MODE_CHOICES = [
  { value: 'replace', label: 'Replace', title: 'New selection' },
  { value: 'add', label: 'Add', title: 'Add to selection (Shift)' },
  { value: 'subtract', label: 'Sub', title: 'Subtract from selection (Alt)' },
  { value: 'intersect', label: 'Int', title: 'Intersect with selection (Shift+Alt)' },
];

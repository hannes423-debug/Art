import { Surface } from './surface';

/**
 * Blend modes. Names map to canvas composite operations for display and to
 * the exact compositing math in composite.ts for export. New modes can be
 * added in both places.
 */
export type BlendMode = 'normal' | 'multiply' | 'screen' | 'add';

export const BLEND_MODES: { id: BlendMode; label: string; canvasOp: GlobalCompositeOperation }[] = [
  { id: 'normal', label: 'Normal', canvasOp: 'source-over' },
  { id: 'multiply', label: 'Multiply', canvasOp: 'multiply' },
  { id: 'screen', label: 'Screen', canvasOp: 'screen' },
  { id: 'add', label: 'Additive', canvasOp: 'lighter' },
];

export function canvasOpFor(mode: BlendMode): GlobalCompositeOperation {
  return BLEND_MODES.find((m) => m.id === mode)?.canvasOp ?? 'source-over';
}

let nextLayerId = 1;

/**
 * A raster layer. Each layer owns one cel (surface) per animation frame;
 * `cels[frameIndex]`. Documents start with a single frame.
 */
export class Layer {
  readonly id = nextLayerId++;
  name: string;
  visible = true;
  /** 0..1 */
  opacity = 1;
  blendMode: BlendMode = 'normal';
  /** When set, painting only changes color and keeps existing alpha. */
  alphaLocked = false;
  /** Id of the group this layer belongs to (members of a group are adjacent), or null. */
  group: number | null = null;
  cels: Surface[];

  constructor(name: string, cels: Surface[]) {
    this.name = name;
    this.cels = cels;
  }

  static blank(name: string, width: number, height: number, frameCount: number): Layer {
    const cels: Surface[] = [];
    for (let i = 0; i < frameCount; i++) cels.push(new Surface(width, height));
    return new Layer(name, cels);
  }

  /** Deep copy with fresh surfaces. */
  clone(name = this.name): Layer {
    // Linked cels (the same surface in several frames) stay linked in the copy.
    const copies = new Map<Surface, Surface>();
    const l = new Layer(
      name,
      this.cels.map((c) => {
        let copy = copies.get(c);
        if (!copy) copies.set(c, (copy = c.clone()));
        return copy;
      }),
    );
    l.visible = this.visible;
    l.opacity = this.opacity;
    l.blendMode = this.blendMode;
    l.alphaLocked = this.alphaLocked;
    l.group = this.group;
    return l;
  }
}

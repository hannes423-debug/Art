import { describe, expect, it } from 'vitest';
import { ArtDocument } from '../../src/core/document';
import { MoveSession } from '../../src/tools/move-session';

/** 4×2 block of distinct colors at (2,3) on a 12×12 layer. */
function setup() {
  const d = ArtDocument.createBlank(12, 12);
  const data = d.activeCel.ensureData();
  for (let y = 0; y < 2; y++) for (let x = 0; x < 4; x++) data.set([x * 60, y * 120, 7, 255], ((3 + y) * 12 + 2 + x) * 4);
  const mask = new Uint8Array(144);
  for (let y = 3; y < 5; y++) mask.fill(255, y * 12 + 2, y * 12 + 6);
  d.selection.combine(mask, { x: 2, y: 3, w: 4, h: 2 }, 'replace');
  const s = MoveSession.lift(d, d.activeCel)!;
  return { d, s, px: (x: number, y: number) => d.activeCel.getPixel(x, y) };
}

describe('free transform', () => {
  it('scales up 2× with crisp nearest-neighbour pixels around the center', () => {
    const { d, s, px } = setup();
    s.setTransform({ sx: 2, sy: 2 });
    expect(s.rect).toEqual({ x: 0, y: 2, w: 8, h: 4 });
    // Each source pixel becomes a 2×2 block.
    expect(px(0, 2)).toEqual([0, 0, 7, 255]);
    expect(px(1, 3)).toEqual([0, 0, 7, 255]);
    expect(px(2, 2)).toEqual([60, 0, 7, 255]);
    expect(px(7, 5)).toEqual([180, 120, 7, 255]);
    expect(d.selection.bounds).toEqual({ x: 0, y: 2, w: 8, h: 4 });
    expect(s.commit()).not.toBeNull();
  });

  it('rotates 90° exactly and flips without losing pixels', () => {
    const { s, px } = setup();
    s.setTransform({ angle: Math.PI / 2 });
    // 4×2 → 2×4 box centered on the same point (4, 4).
    expect(s.rect).toEqual({ x: 3, y: 2, w: 2, h: 4 });
    // Clockwise: the top-left source pixel ends up top-right.
    expect(px(4, 2)).toEqual([0, 0, 7, 255]);
    expect(px(3, 2)).toEqual([0, 120, 7, 255]);
    expect(px(4, 5)).toEqual([180, 0, 7, 255]);
    s.setTransform({ angle: 0, sx: -1 });
    expect(px(2, 3)).toEqual([180, 0, 7, 255]);
    expect(px(5, 3)).toEqual([0, 0, 7, 255]);
  });

  it('cancel restores the original pixels and selection', () => {
    const { d, s, px } = setup();
    s.setTransform({ sx: 1.5, sy: 3, angle: 0.4 }, 1.25, -0.5);
    s.cancel();
    expect(px(2, 3)).toEqual([0, 0, 7, 255]);
    expect(px(0, 0)).toEqual([0, 0, 0, 0]);
    expect(d.selection.bounds).toEqual({ x: 2, y: 3, w: 4, h: 2 });
  });
});

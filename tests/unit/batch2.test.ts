import { describe, expect, it } from 'vitest';
import { ArtDocument } from '../../src/core/document';
import { History } from '../../src/core/history';
import { PaintSession } from '../../src/core/paint';
import { nearestColorFinder } from '../../src/core/palette';
import { bayerThreshold } from '../../src/core/raster';
import { colorMask, mapToPalette } from '../../src/ops';

const black = { r: 0, g: 0, b: 0, a: 255 };
const white = { r: 255, g: 255, b: 255, a: 255 };

describe('palette helpers', () => {
  it('finds the nearest palette color', () => {
    const near = nearestColorFinder([black, white, { r: 255, g: 0, b: 0, a: 255 }]);
    expect(near(10, 10, 10)).toBe(0x000000);
    expect(near(240, 230, 250)).toBe(0xffffff);
    expect(near(200, 30, 20)).toBe(0xff0000);
  });

  it('Bayer thresholds cover 0..1 evenly over an 8×8 block', () => {
    const v: number[] = [];
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) v.push(bayerThreshold(x, y));
    expect(new Set(v).size).toBe(64);
    expect(Math.min(...v)).toBeCloseTo(0.5 / 64);
    expect(Math.max(...v)).toBeCloseTo(63.5 / 64);
  });

  it('palette lock snaps blended paint to palette colors', () => {
    const d = ArtDocument.createBlank(4, 1, 'T', white);
    const near = nearestColorFinder([black, white, { r: 128, g: 128, b: 128, a: 255 }]);
    const s = new PaintSession(d, d.activeCel, { color: black, opacity: 0.4, mode: 'paint', alphaLock: false, snap: near });
    s.span(0, 0, 1);
    s.commit('t');
    // 40% black over white is (153,153,153) → nearest palette gray.
    expect(d.activeCel.getPixel(0, 0)).toEqual([128, 128, 128, 255]);
    expect(d.activeCel.getPixel(3, 0)).toEqual([255, 255, 255, 255]);
  });
});

describe('map to palette', () => {
  it('maps colors exactly, keeps alpha, and is one undo step', () => {
    const d = ArtDocument.createBlank(3, 1);
    d.activeCel.ensureData().set([20, 20, 20, 255, 230, 240, 250, 100, 0, 0, 0, 0]);
    const h = new History();
    expect(mapToPalette(d, h, [black, white], { allLayers: false, allFrames: false, dither: false })).toBe(2);
    expect(d.activeCel.getPixel(0, 0)).toEqual([0, 0, 0, 255]);
    expect(d.activeCel.getPixel(1, 0)).toEqual([255, 255, 255, 100]);
    expect(d.activeCel.getPixel(2, 0)).toEqual([0, 0, 0, 0]);
    h.undo();
    expect(d.activeCel.getPixel(0, 0)).toEqual([20, 20, 20, 255]);
  });

  it('dithers a mid gray into a black/white checker mix', () => {
    const d = ArtDocument.createBlank(8, 8, 'T', { r: 128, g: 128, b: 128, a: 255 });
    mapToPalette(d, new History(), [black, white], { allLayers: false, allFrames: false, dither: true });
    let whites = 0;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) if (d.activeCel.getPixel(x, y)[0] === 255) whites++;
    expect(whites).toBeGreaterThanOrEqual(28);
    expect(whites).toBeLessThanOrEqual(36);
    // Exact palette colors never dither.
    const e = ArtDocument.createBlank(8, 8, 'T', white);
    expect(mapToPalette(e, new History(), [black, white], { allLayers: false, allFrames: false, dither: true })).toBe(0);
  });
});

describe('select by color and feather', () => {
  it('selects all pixels of a color with tolerance', () => {
    const d = ArtDocument.createBlank(4, 2);
    d.activeCel.ensureData().set([255, 0, 0, 255, 250, 0, 0, 255, 0, 0, 0, 0], 0);
    d.activeCel.ensureData().set([255, 0, 0, 255], 4 * 7);
    const exact = colorMask(d, { r: 255, g: 0, b: 0, a: 255 }, 0, false);
    expect(exact.bounds).toEqual({ x: 0, y: 0, w: 4, h: 2 });
    expect([...exact.mask]).toEqual([255, 0, 0, 0, 0, 0, 0, 255]);
    const loose = colorMask(d, { r: 255, g: 0, b: 0, a: 255 }, 5, false);
    expect(loose.mask[1]).toBe(255);
  });

  it('feathers the selection edge into a soft ramp', () => {
    const d = ArtDocument.createBlank(40, 1);
    const m = new Uint8Array(40);
    m.fill(255, 10, 30);
    d.selection.combine(m, { x: 10, y: 0, w: 20, h: 1 }, 'replace');
    d.selection.modify({ kind: 'feather', radius: 6 });
    const v = (x: number) => d.selection.valueAt(x, 0);
    expect(v(20)).toBeGreaterThan(200);
    expect(v(10)).toBeGreaterThan(80);
    expect(v(10)).toBeLessThan(180);
    for (let x = 4; x < 20; x++) expect(v(x + 1)).toBeGreaterThanOrEqual(v(x));
    expect(v(2)).toBe(0);
    // A selection that reaches the canvas edge stays solid there.
    const all = ArtDocument.createBlank(12, 12);
    all.selection.selectAll();
    all.selection.modify({ kind: 'feather', radius: 6 });
    for (const [x, y] of [
      [0, 0],
      [11, 5],
      [6, 11],
    ])
      expect(all.selection.valueAt(x, y)).toBe(255);
  });
});

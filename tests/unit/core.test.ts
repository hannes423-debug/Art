import { describe, expect, it } from 'vitest';
import { parseHex, toHex, rgbToHsv, hsvToRgb } from '../../src/core/color';
import { blendPixel, compositeFrame } from '../../src/core/composite';
import { ArtDocument } from '../../src/core/document';
import { History } from '../../src/core/history';
import { cropPixels, flipHorizontal, resizePixels, rotate90 } from '../../src/core/imageops';
import { Layer } from '../../src/core/layer';
import { bresenham, ellipseOutline, ellipseSpans, fillPolygon, floodFill } from '../../src/core/raster';
import { Selection } from '../../src/core/selection';
import { Surface } from '../../src/core/surface';
import { TileRecorder } from '../../src/core/tiles';

describe('color', () => {
  it('parses and formats hex', () => {
    expect(parseHex('#ff8000')).toEqual({ r: 255, g: 128, b: 0, a: 255 });
    expect(parseHex('f80')).toEqual({ r: 255, g: 136, b: 0, a: 255 });
    expect(parseHex('#11223344')).toEqual({ r: 17, g: 34, b: 51, a: 68 });
    expect(parseHex('nope')).toBeNull();
    expect(toHex({ r: 1, g: 2, b: 3, a: 255 })).toBe('#010203');
    expect(toHex({ r: 1, g: 2, b: 3, a: 4 })).toBe('#01020304');
  });

  it('round-trips through HSV', () => {
    for (const c of [
      { r: 255, g: 0, b: 0, a: 255 },
      { r: 12, g: 200, b: 99, a: 255 },
      { r: 128, g: 128, b: 128, a: 255 },
    ]) {
      expect(hsvToRgb(rgbToHsv(c))).toEqual(c);
    }
  });
});

describe('raster', () => {
  it('draws connected Bresenham lines including both endpoints', () => {
    const pts: [number, number][] = [];
    bresenham(0, 0, 5, 2, (x, y) => pts.push([x, y]));
    expect(pts[0]).toEqual([0, 0]);
    expect(pts.at(-1)).toEqual([5, 2]);
    for (let i = 1; i < pts.length; i++) {
      expect(Math.abs(pts[i][0] - pts[i - 1][0])).toBeLessThanOrEqual(1);
      expect(Math.abs(pts[i][1] - pts[i - 1][1])).toBeLessThanOrEqual(1);
    }
  });

  it('keeps ellipses inside their rect and symmetric', () => {
    for (const [w, h] of [
      [1, 1],
      [2, 2],
      [3, 3],
      [5, 4],
      [8, 8],
      [16, 9],
      [2, 7],
    ]) {
      const set = new Set<string>();
      ellipseOutline(10, 20, 10 + w - 1, 20 + h - 1, (x, y) => {
        expect(x).toBeGreaterThanOrEqual(10);
        expect(x).toBeLessThanOrEqual(10 + w - 1);
        expect(y).toBeGreaterThanOrEqual(20);
        expect(y).toBeLessThanOrEqual(20 + h - 1);
        set.add(`${x},${y}`);
      });
      // touches all four sides
      const xs = [...set].map((s) => +s.split(',')[0]);
      const ys = [...set].map((s) => +s.split(',')[1]);
      expect(Math.min(...xs)).toBe(10);
      expect(Math.max(...xs)).toBe(10 + w - 1);
      expect(Math.min(...ys)).toBe(20);
      expect(Math.max(...ys)).toBe(20 + h - 1);
      for (const s of set) {
        const [x, y] = s.split(',').map(Number);
        expect(set.has(`${10 + w - 1 - (x - 10)},${y}`)).toBe(true);
        expect(set.has(`${x},${20 + h - 1 - (y - 20)}`)).toBe(true);
      }
      let rows = 0;
      ellipseSpans(10, 20, 10 + w - 1, 20 + h - 1, () => rows++);
      expect(rows).toBe(h);
    }
  });

  it('fills polygons at pixel centers', () => {
    const out = new Uint8Array(10 * 10);
    const r = fillPolygon(
      [
        { x: 2, y: 2 },
        { x: 6, y: 2 },
        { x: 6, y: 5 },
        { x: 2, y: 5 },
      ],
      10,
      10,
      out,
    );
    expect(r).toEqual({ x: 2, y: 2, w: 4, h: 3 });
    expect(out.reduce((s, v) => s + (v ? 1 : 0), 0)).toBe(12);
  });

  it('flood fills contiguous regions with tolerance', () => {
    const w = 4;
    const h = 3;
    const d = new Uint8ClampedArray(w * h * 4);
    const set = (x: number, y: number, c: number[]) => d.set(c, (y * w + x) * 4);
    // A vertical red wall at x=2 splits the image.
    for (let y = 0; y < h; y++) set(2, y, [255, 0, 0, 255]);
    set(0, 0, [5, 0, 0, 3]); // nearly transparent, within tolerance 5 of transparent
    const mask = new Uint8Array(w * h);
    const r = floodFill(d, w, h, 1, 1, 5, true, mask);
    expect(r).toEqual({ x: 0, y: 0, w: 2, h: 3 });
    expect(Array.from(mask)).toEqual([255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0]);
    const mask2 = new Uint8Array(w * h);
    floodFill(d, w, h, 1, 1, 0, false, mask2);
    expect(mask2[0]).toBe(0); // alpha 3 differs with tolerance 0
    expect(mask2[3]).toBe(255); // non-contiguous reaches the right side
  });
});

describe('selection', () => {
  const rectMask = (w: number, h: number, x: number, y: number, rw: number, rh: number) => {
    const m = new Uint8Array(w * h);
    for (let j = y; j < y + rh; j++) m.fill(255, j * w + x, j * w + x + rw);
    return m;
  };

  it('combines masks with all modes', () => {
    const s = new Selection(10, 10);
    s.combine(rectMask(10, 10, 0, 0, 4, 4), null, 'replace');
    expect(s.bounds).toEqual({ x: 0, y: 0, w: 4, h: 4 });
    s.combine(rectMask(10, 10, 2, 2, 4, 4), null, 'add');
    expect(s.bounds).toEqual({ x: 0, y: 0, w: 6, h: 6 });
    s.combine(rectMask(10, 10, 0, 0, 6, 3), null, 'subtract');
    expect(s.bounds).toEqual({ x: 0, y: 3, w: 6, h: 3 });
    s.combine(rectMask(10, 10, 4, 0, 6, 10), null, 'intersect');
    expect(s.bounds).toEqual({ x: 4, y: 3, w: 2, h: 3 });
    s.combine(rectMask(10, 10, 0, 0, 1, 1), null, 'intersect');
    expect(s.active).toBe(false);
  });

  it('round-trips state and resizes with offset', () => {
    const s = new Selection(8, 8);
    s.combine(rectMask(8, 8, 1, 1, 2, 2), null, 'replace');
    const st = s.getState()!;
    s.clear();
    s.setState(st);
    expect(s.bounds).toEqual({ x: 1, y: 1, w: 2, h: 2 });
    s.resize(4, 4, -1, -1);
    expect(s.bounds).toEqual({ x: 0, y: 0, w: 2, h: 2 });
    s.invert();
    expect(s.valueAt(0, 0)).toBe(0);
    expect(s.valueAt(3, 3)).toBe(255);
  });
});

describe('history + tile patches', () => {
  it('undoes and redoes pixel edits by swapping tiles', () => {
    const surf = new Surface(130, 70);
    const rec = new TileRecorder(surf);
    const area = { x: 60, y: 60, w: 10, h: 5 };
    rec.record(area);
    const d = surf.ensureData();
    for (let y = area.y; y < area.y + area.h; y++) for (let x = area.x; x < area.x + area.w; x++) d.set([1, 2, 3, 255], (y * 130 + x) * 4);
    const after = d.slice();
    const changes: unknown[] = [];
    const patch = rec.finish('Paint', (_s, r) => changes.push(r))!;
    expect(patch).not.toBeNull();
    // Only tiles actually changed are kept: (0,0) (1,0) (0,1) (1,1) — all intersect area.
    expect(patch.tiles.length).toBe(4);
    const h = new History();
    h.push(patch);
    h.undo();
    expect(surf.data!.every((v) => v === 0)).toBe(true);
    h.redo();
    expect(Array.from(surf.data!)).toEqual(Array.from(after));
    expect(changes.length).toBe(2);
  });

  it('returns null for edits that changed nothing', () => {
    const surf = new Surface(10, 10);
    const rec = new TileRecorder(surf);
    rec.record({ x: 0, y: 0, w: 10, h: 10 });
    expect(rec.finish('Nothing', () => {})).toBeNull();
  });

  it('enforces step limits', () => {
    const h = new History(3);
    let n = 0;
    for (let i = 0; i < 5; i++) h.push({ label: `${i}`, bytes: 1, undo: () => n--, redo: () => n++ });
    expect(h.undoCount).toBe(3);
    expect(h.undoLabel).toBe('4');
  });
});

describe('compositing', () => {
  it('blends normal mode like source-over', () => {
    const dst = new Uint8ClampedArray([0, 0, 255, 255]);
    blendPixel(dst, 0, 255, 0, 0, 0.5, 'normal');
    expect(Array.from(dst)).toEqual([128, 0, 128, 255]);
    const empty = new Uint8ClampedArray(4);
    blendPixel(empty, 0, 10, 20, 30, 0.4, 'normal');
    expect(Array.from(empty)).toEqual([10, 20, 30, 102]);
  });

  it('multiplies and screens', () => {
    const m = new Uint8ClampedArray([255, 128, 0, 255]);
    blendPixel(m, 0, 128, 128, 128, 1, 'multiply');
    expect(Array.from(m)).toEqual([128, 64, 0, 255]);
    const s = new Uint8ClampedArray([0, 128, 255, 255]);
    blendPixel(s, 0, 128, 128, 128, 1, 'screen');
    expect(Array.from(s)).toEqual([128, 192, 255, 255]);
  });

  it('composites visible layers bottom-to-top with opacity', () => {
    const doc = ArtDocument.createBlank(2, 1, 'T', { r: 0, g: 0, b: 0, a: 255 });
    const top = Layer.blank('Top', 2, 1, 1);
    top.cels[0].replace(2, 1, new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 0]));
    top.opacity = 0.5;
    doc.insertLayer(top, 1);
    expect(Array.from(compositeFrame(doc, 0))).toEqual([128, 128, 128, 255, 0, 0, 0, 255]);
    top.visible = false;
    expect(Array.from(compositeFrame(doc, 0))).toEqual([0, 0, 0, 255, 0, 0, 0, 255]);
  });
});

describe('image ops', () => {
  const img = new Uint8ClampedArray([
    // 3x2
    1, 0, 0, 255, 2, 0, 0, 255, 3, 0, 0, 255,
    4, 0, 0, 255, 5, 0, 0, 255, 6, 0, 0, 255,
  ]);
  const reds = (d: Uint8ClampedArray) => Array.from(d).filter((_, i) => i % 4 === 0);

  it('flips and rotates', () => {
    expect(reds(flipHorizontal(img, 3, 2))).toEqual([3, 2, 1, 6, 5, 4]);
    expect(reds(rotate90(img, 3, 2, true))).toEqual([4, 1, 5, 2, 6, 3]);
    expect(reds(rotate90(img, 3, 2, false))).toEqual([3, 6, 2, 5, 1, 4]);
  });

  it('crops with out-of-bounds areas transparent', () => {
    const c = cropPixels(img, 3, 2, { x: 2, y: 1, w: 2, h: 2 });
    expect(Array.from(c)).toEqual([6, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('scales with nearest neighbour exactly', () => {
    const up = resizePixels(img, 3, 2, 6, 4, 'nearest');
    expect(reds(up)).toEqual([1, 1, 2, 2, 3, 3, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 4, 4, 5, 5, 6, 6]);
    const down = resizePixels(up, 6, 4, 3, 2, 'nearest');
    expect(Array.from(down)).toEqual(Array.from(img));
  });

  it('smooth scaling does not darken transparent edges', () => {
    const src = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 0]);
    const out = resizePixels(src, 2, 1, 4, 1, 'smooth');
    for (let i = 0; i < out.length; i += 4) if (out[i + 3] > 0) expect(out[i]).toBe(255);
  });
});

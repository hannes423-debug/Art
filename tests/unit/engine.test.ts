import { describe, expect, it } from 'vitest';
import { eventCombo } from '../../src/actions';
import { ArtDocument } from '../../src/core/document';
import { History } from '../../src/core/history';
import { Layer } from '../../src/core/layer';
import { PaintSession } from '../../src/core/paint';
import { parsePalette, toGpl, toHexList } from '../../src/core/palette';
import { deserializeProject, projectToJSON } from '../../src/io/project';
import { Viewport } from '../../src/render/viewport';

const red = { r: 255, g: 0, b: 0, a: 255 };

function doc(w = 16, h = 16): ArtDocument {
  return ArtDocument.createBlank(w, h);
}

describe('PaintSession', () => {
  it('keeps uniform opacity where dabs overlap within one stroke', () => {
    const d = doc();
    const s = new PaintSession(d, d.activeCel, { color: red, opacity: 0.5, mode: 'paint', alphaLock: false });
    for (let i = 0; i < 10; i++) s.dabSoft(8, 8, 3, 1, 1);
    s.apply();
    expect(d.activeCel.getPixel(8, 8)).toEqual([255, 0, 0, 128]);
    s.commit('Brush');
  });

  it('produces one undo patch that restores the original pixels', () => {
    const d = doc();
    const h = new History();
    const s = new PaintSession(d, d.activeCel, { color: red, opacity: 1, mode: 'paint', alphaLock: false });
    s.dabPixel(3, 3, 3, false);
    const patch = s.commit('Pencil')!;
    h.push(patch);
    expect(d.activeCel.getPixel(2, 2)).toEqual([255, 0, 0, 255]);
    h.undo();
    expect(d.activeCel.getPixel(2, 2)).toEqual([0, 0, 0, 0]);
    h.redo();
    expect(d.activeCel.getPixel(4, 4)).toEqual([255, 0, 0, 255]);
  });

  it('erases to fully transparent pixels and clears their color', () => {
    const d = ArtDocument.createBlank(8, 8, 'T', { r: 10, g: 20, b: 30, a: 255 });
    const s = new PaintSession(d, d.activeCel, { color: red, opacity: 1, mode: 'erase', alphaLock: false });
    s.dabPixel(1, 1, 1, false);
    s.commit('Erase');
    expect(d.activeCel.getPixel(1, 1)).toEqual([0, 0, 0, 0]);
    expect(d.activeCel.getPixel(2, 2)).toEqual([10, 20, 30, 255]);
  });

  it('respects the selection and alpha lock', () => {
    const d = doc(8, 8);
    const mask = new Uint8Array(64);
    mask[0] = 255;
    d.selection.combine(mask, { x: 0, y: 0, w: 1, h: 1 }, 'replace');
    const s = new PaintSession(d, d.activeCel, { color: red, opacity: 1, mode: 'paint', alphaLock: false });
    for (let y = 0; y < 8; y++) s.span(y, 0, 7);
    s.commit('Fill');
    expect(d.activeCel.getPixel(0, 0)).toEqual([255, 0, 0, 255]);
    expect(d.activeCel.getPixel(1, 0)).toEqual([0, 0, 0, 0]);
    d.selection.clear();
    const s2 = new PaintSession(d, d.activeCel, { color: { r: 0, g: 0, b: 255, a: 255 }, opacity: 1, mode: 'paint', alphaLock: true });
    for (let y = 0; y < 8; y++) s2.span(y, 0, 7);
    s2.commit('Recolor');
    expect(d.activeCel.getPixel(0, 0)).toEqual([0, 0, 255, 255]);
    expect(d.activeCel.getPixel(1, 0)).toEqual([0, 0, 0, 0]);
  });

  it('cancel restores everything and allows a new session', () => {
    const d = doc();
    const s = new PaintSession(d, d.activeCel, { color: red, opacity: 1, mode: 'paint', alphaLock: false });
    s.dabSoft(5, 5, 4, 0.5, 1);
    s.apply();
    s.cancel();
    expect(d.activeCel.isBlank()).toBe(true);
    const s2 = new PaintSession(d, d.activeCel, { color: red, opacity: 1, mode: 'paint', alphaLock: false });
    expect(s2.commit('Nothing')).toBeNull();
  });
});

describe('project format', () => {
  it('round-trips layers, frames, properties and exact pixels', async () => {
    const d = ArtDocument.createBlank(5, 3, 'hero');
    const top = Layer.blank('Top', 5, 3, 1);
    top.opacity = 0.5;
    top.blendMode = 'multiply';
    top.alphaLocked = true;
    top.visible = false;
    top.cels[0].ensureData().set([1, 2, 3, 4], 0);
    d.insertLayer(top, 1);
    d.insertFrame(1, { duration: 80 }, [d.layers[0].cels[0].clone(), top.cels[0].clone()]);
    const json = await projectToJSON(d, { palette: [red], grid: { enabled: true, width: 8, height: 4 } });
    const parsed = JSON.parse(json);
    expect(parsed.format).toBe('art-project');
    expect(parsed.layers).toHaveLength(2);
    expect(parsed.layers[0].cels).toEqual([null, null]);
    const { doc: back, extras } = await deserializeProject(json);
    expect([back.width, back.height, back.name]).toEqual([5, 3, 'hero']);
    expect(back.frames.map((f) => f.duration)).toEqual([100, 80]);
    const l = back.layers[1];
    expect([l.name, l.opacity, l.blendMode, l.alphaLocked, l.visible]).toEqual(['Top', 0.5, 'multiply', true, false]);
    expect(l.cels[0].getPixel(0, 0)).toEqual([1, 2, 3, 4]);
    expect(l.cels[1].getPixel(0, 0)).toEqual([1, 2, 3, 4]);
    expect(extras.grid).toEqual({ enabled: true, width: 8, height: 4 });
    expect(extras.palette).toEqual([red]);
  });

  it('rejects files that are not Art projects or are from the future', async () => {
    await expect(deserializeProject('{"hello": 1}')).rejects.toThrow(/not an Art project/);
    await expect(deserializeProject('{"format":"art-project","version":99,"width":1,"height":1,"layers":[]}')).rejects.toThrow(/newer version/);
    await expect(deserializeProject('nope')).rejects.toThrow(/not valid JSON/);
  });
});

describe('palettes', () => {
  it('parses GIMP, hex and Paint.NET palettes and writes them back', () => {
    const gpl = 'GIMP Palette\nName: test\nColumns: 4\n#\n255   0   0\tred\n  0 128 255\tblue\n';
    expect(parsePalette(gpl)).toEqual([red, { r: 0, g: 128, b: 255, a: 255 }]);
    expect(parsePalette('; comment\nff0000\n#00ff00\n')).toEqual([red, { r: 0, g: 255, b: 0, a: 255 }]);
    expect(parsePalette('FFFF0000\n')).toEqual([red]);
    expect(parsePalette('JASC-PAL\n0100\n2\n255 0 0\n0 0 255\n')).toEqual([red, { r: 0, g: 0, b: 255, a: 255 }]);
    expect(parsePalette('nothing here')).toBeNull();
    expect(parsePalette(toGpl([red]))).toEqual([red]);
    expect(parsePalette(toHexList([red]))).toEqual([red]);
  });
});

describe('viewport', () => {
  it('maps document and screen coordinates consistently under zoom, rotation and flip', () => {
    const v = new Viewport();
    v.width = 800;
    v.height = 600;
    v.fit(64, 32);
    v.rotateAt(123, 77, 0.7);
    v.toggleFlip();
    v.zoomAt(300, 200, v.zoom * 1.7);
    for (const [x, y] of [
      [0, 0],
      [10.5, 3.25],
      [64, 32],
    ]) {
      const s = v.docToScreen(x, y);
      const d = v.screenToDoc(s.x, s.y);
      expect(d.x).toBeCloseTo(x, 9);
      expect(d.y).toBeCloseTo(y, 9);
    }
  });

  it('keeps the point under the cursor fixed while zooming and rotating', () => {
    const v = new Viewport();
    v.width = 800;
    v.height = 600;
    v.fit(100, 100);
    const before = v.screenToDoc(250, 140);
    v.zoomAt(250, 140, v.zoom * 3);
    v.rotateAt(250, 140, 1.1);
    const after = v.screenToDoc(250, 140);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });

  it('fits with whole-number zoom for crisp pixels', () => {
    const v = new Viewport();
    v.width = 1000;
    v.height = 700;
    v.fit(32, 32);
    expect(Number.isInteger(v.zoom)).toBe(true);
    const c = v.docToScreen(16, 16);
    expect(c.x).toBeCloseTo(500);
    expect(c.y).toBeCloseTo(350);
  });
});

describe('keyboard shortcuts', () => {
  const ev = (key: string, mods: Partial<KeyboardEvent> = {}, code = '') =>
    ({ key, code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods }) as KeyboardEvent;

  it('normalizes key combos across platforms and layouts', () => {
    expect(eventCombo(ev('z', { ctrlKey: true }))).toBe('mod+z');
    expect(eventCombo(ev('z', { metaKey: true }))).toBe('mod+z');
    expect(eventCombo(ev('Z', { ctrlKey: true, shiftKey: true }))).toBe('mod+shift+z');
    expect(eventCombo(ev('+', { shiftKey: true }))).toBe('+');
    expect(eventCombo(ev('?', { shiftKey: true }))).toBe('?');
    // macOS Option+N types "˜"; the physical key is used instead.
    expect(eventCombo(ev('˜', { altKey: true }, 'KeyN'))).toBe('alt+n');
    expect(eventCombo(ev('Delete'))).toBe('delete');
    // Option+= / Option+- type other characters on macOS.
    expect(eventCombo(ev('≠', { metaKey: true, altKey: true }, 'Equal'))).toBe('mod+alt+=');
    expect(eventCombo(ev('–', { ctrlKey: true, altKey: true }, 'Minus'))).toBe('mod+alt+-');
  });
});

describe('layer operations', () => {
  it('merges down exactly, refuses hidden layers, and undoes cleanly', async () => {
    const { mergeDown, addLayer } = await import('../../src/ops');
    const d = ArtDocument.createBlank(2, 1, 'T', { r: 0, g: 0, b: 255, a: 255 });
    const h = new History();
    const top = addLayer(d, h);
    top.cels[0].ensureData().set([255, 0, 0, 255], 0);
    top.opacity = 0.5;
    top.visible = false;
    expect(mergeDown(d, h)).toMatch(/Show the layer/);
    top.visible = true;
    expect(mergeDown(d, h)).toBeNull();
    expect(d.layers).toHaveLength(1);
    expect(d.activeCel.getPixel(0, 0)).toEqual([128, 0, 128, 255]);
    expect(d.activeCel.getPixel(1, 0)).toEqual([0, 0, 255, 255]);
    h.undo();
    expect(d.layers).toHaveLength(2);
    expect(d.layers[0].cels[0].getPixel(0, 0)).toEqual([0, 0, 255, 255]);
    expect(d.layers[1].cels[0].getPixel(0, 0)).toEqual([255, 0, 0, 255]);
    d.setActiveLayer(d.layers[0]);
    expect(mergeDown(d, h)).toMatch(/no layer below/);
  });
});

describe('selection grow / shrink / border', () => {
  /** Selects the rectangle (x, y, w, h) on a blank document. */
  function rectSel(dw: number, dh: number, x: number, y: number, w: number, hh: number) {
    const d = doc(dw, dh);
    const mask = new Uint8Array(dw * dh);
    for (let yy = y; yy < y + hh; yy++) mask.fill(255, yy * dw + x, yy * dw + x + w);
    d.selection.combine(mask, { x, y, w, h: hh }, 'replace');
    return d.selection;
  }
  const count = (s: { mask: Uint8Array | null }) => (s.mask ? s.mask.reduce((n, v) => n + (v ? 1 : 0), 0) : 0);

  it('grows with square or round corners', () => {
    const sq = rectSel(16, 16, 5, 5, 4, 4);
    sq.modify({ kind: 'grow', radius: 2, shape: 'square' });
    expect(sq.bounds).toEqual({ x: 3, y: 3, w: 8, h: 8 });
    expect(count(sq)).toBe(64);
    const round = rectSel(16, 16, 5, 5, 4, 4);
    round.modify({ kind: 'grow', radius: 2, shape: 'round' });
    expect(round.bounds).toEqual({ x: 3, y: 3, w: 8, h: 8 });
    // The far corners are more than 2px away from the rectangle.
    expect(round.valueAt(3, 3)).toBe(0);
    expect(round.valueAt(4, 4)).toBe(255);
    expect(round.valueAt(3, 6)).toBe(255);
  });

  it('grows a single pixel into a plus with radius 1', () => {
    const s = rectSel(5, 5, 2, 2, 1, 1);
    s.modify({ kind: 'grow', radius: 1, shape: 'round' });
    expect(count(s)).toBe(5);
    expect(s.valueAt(1, 1)).toBe(0);
    expect(s.valueAt(2, 1)).toBe(255);
  });

  it('shrinks, optionally away from the canvas edge, and can empty the selection', () => {
    const a = rectSel(8, 8, 0, 0, 8, 8);
    a.modify({ kind: 'shrink', radius: 1, shape: 'square', fromCanvasEdge: true });
    expect(a.bounds).toEqual({ x: 1, y: 1, w: 6, h: 6 });
    const b = rectSel(8, 8, 0, 0, 8, 8);
    b.modify({ kind: 'shrink', radius: 1, shape: 'square', fromCanvasEdge: false });
    expect(b.bounds).toEqual({ x: 0, y: 0, w: 8, h: 8 });
    const c = rectSel(8, 8, 2, 2, 3, 3);
    c.modify({ kind: 'shrink', radius: 2, shape: 'round', fromCanvasEdge: true });
    expect(c.active).toBe(false);
  });

  it('selects a 1px outline outside or inside', () => {
    const out = rectSel(10, 10, 3, 3, 4, 4);
    out.modify({ kind: 'border', radius: 1, shape: 'square', side: 'outside' });
    expect(count(out)).toBe(36 - 16);
    expect(out.valueAt(4, 4)).toBe(0);
    expect(out.valueAt(2, 2)).toBe(255);
    const inner = rectSel(10, 10, 3, 3, 4, 4);
    inner.modify({ kind: 'border', radius: 1, shape: 'square', side: 'inside' });
    expect(count(inner)).toBe(16 - 4);
    expect(inner.valueAt(3, 3)).toBe(255);
    expect(inner.valueAt(4, 4)).toBe(0);
  });

  it('is one undo step in the editor history', async () => {
    const { changeSelection } = await import('../../src/ops');
    const d = doc(8, 8);
    const h = new History();
    changeSelection(d, h, 'Select all', () => d.selection.selectAll());
    changeSelection(d, h, 'Shrink selection', () => d.selection.modify({ kind: 'shrink', radius: 2, shape: 'square', fromCanvasEdge: true }));
    expect(d.selection.bounds).toEqual({ x: 2, y: 2, w: 4, h: 4 });
    h.undo();
    expect(d.selection.bounds).toEqual({ x: 0, y: 0, w: 8, h: 8 });
  });
});

describe('mask morphology matches the brute-force definition', () => {
  it('for random masks, both shapes, grow and shrink', async () => {
    const { growMask, shrinkMask } = await import('../../src/core/morphology');
    const { computeMaskBounds } = await import('../../src/core/selection');
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const W = 23;
    const H = 17;
    for (let trial = 0; trial < 30; trial++) {
      const m = new Uint8Array(W * H);
      for (let i = 0; i < m.length; i++) m[i] = rand() < 0.35 ? 255 : 0;
      const b = computeMaskBounds(m, W, H, null);
      if (!b) continue;
      const r = 1 + (trial % 5);
      for (const shape of ['round', 'square'] as const) {
        const inside = (dx: number, dy: number) => (shape === 'square' ? Math.max(Math.abs(dx), Math.abs(dy)) <= r : dx * dx + dy * dy <= r * r);
        const at = (x: number, y: number, outside: number) => (x < 0 || y < 0 || x >= W || y >= H ? outside : m[y * W + x]);
        const grown = growMask(m, W, H, b, r, shape);
        const edge = trial % 2 === 0;
        const shrunk = shrinkMask(m, W, H, b, r, shape, edge);
        for (let y = 0; y < H; y++)
          for (let x = 0; x < W; x++) {
            let any = false;
            let all = true;
            for (let dy = -r; dy <= r; dy++)
              for (let dx = -r; dx <= r; dx++) {
                if (!inside(dx, dy)) continue;
                if (at(x + dx, y + dy, 0)) any = true;
                if (!at(x + dx, y + dy, edge ? 0 : 255)) all = false;
              }
            expect(grown[y * W + x], `grow ${shape} r=${r} at ${x},${y}`).toBe(any ? 255 : 0);
            expect(shrunk[y * W + x], `shrink ${shape} r=${r} at ${x},${y}`).toBe(all ? 255 : 0);
          }
      }
    }
  });
});

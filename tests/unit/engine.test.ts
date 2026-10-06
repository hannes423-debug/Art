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
  });
});

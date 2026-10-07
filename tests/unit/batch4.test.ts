import { describe, expect, it } from 'vitest';
import { ArtDocument } from '../../src/core/document';
import { History } from '../../src/core/history';
import { PaintSession } from '../../src/core/paint';
import { deserializeProject, projectToJSON } from '../../src/io/project';
import { addFrame, deleteFrame, linkWithPrevious, setTags, unlinkCel } from '../../src/ops';

const red = { r: 255, g: 0, b: 0, a: 255 };
const extras = { palette: [], grid: { enabled: false, width: 16, height: 16 } };

function threeFrames(): { d: ArtDocument; h: History } {
  const d = ArtDocument.createBlank(4, 4);
  const h = new History();
  addFrame(d, h, 'empty');
  addFrame(d, h, 'empty');
  return { d, h };
}

describe('tags', () => {
  it('follow frame inserts and deletes, and undo restores them exactly', () => {
    const { d, h } = threeFrames();
    setTags(d, h, [{ name: 'walk', from: 1, to: 2, color: '#5aa9ff', direction: 'forward' }]);
    // Insert before the tag: it shifts.
    d.setActiveFrame(0);
    addFrame(d, h, 'empty');
    expect([d.tags[0].from, d.tags[0].to]).toEqual([2, 3]);
    // Insert after the tag's last frame (while on it): the tag grows.
    d.setActiveFrame(3);
    addFrame(d, h, 'empty');
    expect([d.tags[0].from, d.tags[0].to]).toEqual([2, 4]);
    h.undo();
    expect([d.tags[0].from, d.tags[0].to]).toEqual([2, 3]);
    // Deleting every frame of a tag removes it; undo brings it back.
    d.setActiveFrame(2);
    deleteFrame(d, h);
    d.setActiveFrame(2);
    deleteFrame(d, h);
    expect(d.tags).toEqual([]);
    h.undo();
    h.undo();
    expect(d.tags).toEqual([{ name: 'walk', from: 2, to: 3, color: '#5aa9ff', direction: 'forward' }]);
  });
});

describe('linked cels', () => {
  it('share pixels between frames until unlinked', () => {
    const d = ArtDocument.createBlank(4, 4);
    const h = new History();
    addFrame(d, h, 'linked');
    expect(d.activeFrame).toBe(1);
    expect(d.isLinked(d.activeLayer, 1)).toBe(true);
    const s = new PaintSession(d, d.activeCel, { color: red, opacity: 1, mode: 'paint', alphaLock: false });
    s.dabPixel(1, 1, 1, false);
    h.push(s.commit('Pencil')!);
    expect(d.activeLayer.cels[0].getPixel(1, 1)).toEqual([255, 0, 0, 255]);
    expect(unlinkCel(d, h)).toBe(true);
    expect(d.isLinked(d.activeLayer, 1)).toBe(false);
    expect(d.activeCel.getPixel(1, 1)).toEqual([255, 0, 0, 255]);
    h.undo();
    expect(d.isLinked(d.activeLayer, 1)).toBe(true);
    // Link a separate frame with the previous one.
    addFrame(d, h, 'empty');
    expect(linkWithPrevious(d, h)).toBeNull();
    expect(d.activeLayer.cels[2]).toBe(d.activeLayer.cels[1]);
    expect(linkWithPrevious(d, h)).toMatch(/already linked/);
    expect(d.framesOf(d.activeLayer.cels[0])).toEqual([0, 1, 2]);
  });

  it('round-trip through the project format (version 2 only when linked)', async () => {
    const d = ArtDocument.createBlank(2, 2);
    const h = new History();
    d.activeCel.ensureData().set([1, 2, 3, 255]);
    addFrame(d, h, 'duplicate');
    let parsed = JSON.parse(await projectToJSON(d, extras));
    expect(parsed.version).toBe(1);
    addFrame(d, h, 'linked');
    setTags(d, h, [{ name: 'idle', from: 1, to: 2, color: '#ff6b6b', direction: 'pingpong' }]);
    const json = await projectToJSON(d, extras);
    parsed = JSON.parse(json);
    expect(parsed.version).toBe(2);
    expect(parsed.layers[0].cels[2]).toEqual({ link: 1 });
    const { doc } = await deserializeProject(json);
    const l = doc.layers[0];
    expect(l.cels[2]).toBe(l.cels[1]);
    expect(l.cels[1]).not.toBe(l.cels[0]);
    expect(l.cels[2].getPixel(0, 0)).toEqual([1, 2, 3, 255]);
    expect(doc.tags).toEqual([{ name: 'idle', from: 1, to: 2, color: '#ff6b6b', direction: 'pingpong' }]);
    // Bad links are rejected.
    parsed.layers[0].cels[0] = { link: 2 };
    await expect(deserializeProject(JSON.stringify(parsed))).rejects.toThrow(/invalid frame/);
  });
});

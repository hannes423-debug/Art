import { describe, expect, it } from 'vitest';
import { compositeFrame } from '../../src/core/composite';
import { ArtDocument } from '../../src/core/document';
import { History } from '../../src/core/history';
import { Layer } from '../../src/core/layer';
import { deserializeProject, projectToJSON } from '../../src/io/project';
import { addLayer, deleteGroup, groupLayer, mergeDown, mergeGroup, moveLayer, setGroupProps, stepLayer, ungroup } from '../../src/ops';

/** Bottom layer blue; two opaque red layers above (A, B). */
function setup() {
  const d = ArtDocument.createBlank(1, 1, 'T', { r: 0, g: 0, b: 255, a: 255 });
  const h = new History();
  for (const name of ['A', 'B']) {
    const l = Layer.blank(name, 1, 1, 1);
    l.cels[0].ensureData().set([255, 0, 0, 255]);
    d.insertLayer(l, d.layers.length);
  }
  return { d, h, [0]: d.layers[0], A: d.layers[1], B: d.layers[2] };
}

describe('layer groups', () => {
  it('composite the group on its own, then apply the group opacity', () => {
    const { d, h, A, B } = setup();
    d.setActiveLayer(A);
    expect(groupLayer(d, h)).toBeNull();
    d.setActiveLayer(B);
    stepLayer(d, h, -1); // B joins A's group
    expect(B.group).toBe(A.group);
    setGroupProps(d, h, A.group!, { opacity: 0.5 });
    // Isolated: red over red is still red at 100%, then 50% over blue → purple.
    expect([...compositeFrame(d, 0)]).toEqual([128, 0, 128, 255]);
    setGroupProps(d, h, A.group!, { visible: false });
    expect([...compositeFrame(d, 0)]).toEqual([0, 0, 255, 255]);
  });

  it('move layers into and out of groups step by step, with undo', () => {
    const { d, h, A, B } = setup();
    d.setActiveLayer(A);
    groupLayer(d, h);
    const g = A.group!;
    // B is above the group: stepping down joins it, stepping up leaves it.
    d.setActiveLayer(B);
    stepLayer(d, h, -1);
    expect(B.group).toBe(g);
    stepLayer(d, h, 1);
    expect(B.group).toBeNull();
    // A at the bottom edge of the group leaves it first, then moves.
    d.setActiveLayer(A);
    stepLayer(d, h, -1);
    expect(A.group).toBeNull();
    expect(d.layers.indexOf(A)).toBe(1);
    h.undo();
    expect(A.group).toBe(g);
    // A new layer added above a grouped layer joins the group.
    const n = addLayer(d, h);
    expect(n.group).toBe(g);
    // Dropping a layer between two members joins; elsewhere it leaves.
    moveLayer(d, h, B, 1);
    expect(d.layers.map((l) => l.name)).toEqual(['Background', 'B', 'A', n.name]);
    expect(B.group).toBeNull();
    moveLayer(d, h, B, 2);
    expect(B.group).toBe(g);
  });

  it('merge, ungroup, delete and merge-down rules', () => {
    const { d, h, A, B } = setup();
    d.setActiveLayer(A);
    groupLayer(d, h);
    expect(mergeDown(d, h)).toMatch(/different group/);
    d.setActiveLayer(B);
    stepLayer(d, h, -1);
    setGroupProps(d, h, A.group!, { opacity: 0.5 });
    mergeGroup(d, h, A.group!);
    expect(d.layers).toHaveLength(2);
    expect(d.layers[1].group).toBeNull();
    expect(d.layers[1].cels[0].getPixel(0, 0)).toEqual([255, 0, 0, 128]);
    h.undo();
    expect(d.layers).toHaveLength(3);
    ungroup(d, h, A.group!);
    expect([A.group, B.group]).toEqual([null, null]);
    h.undo();
    expect(deleteGroup(d, h, A.group!)).toBeNull();
    expect(d.layers.map((l) => l.name)).toEqual(['Background']);
    h.undo();
    expect(d.layers).toHaveLength(3);
  });

  it('round-trip through the project format as version 3', async () => {
    const { d, h, A, B } = setup();
    d.setActiveLayer(B);
    groupLayer(d, h);
    setGroupProps(d, h, B.group!, { name: 'Hat', opacity: 0.25, collapsed: true });
    const json = await projectToJSON(d, { palette: [], grid: { enabled: false, width: 8, height: 8 } });
    const parsed = JSON.parse(json);
    expect(parsed.version).toBe(3);
    const { doc } = await deserializeProject(json);
    expect(doc.layers.map((l) => l.group === null)).toEqual([true, true, false]);
    expect(doc.groups).toEqual([{ id: B.group, name: 'Hat', visible: true, opacity: 0.25, collapsed: true }]);
    expect(A.group).toBeNull();
    // Non-adjacent members are repaired on load.
    parsed.layers[0].group = B.group;
    const { doc: fixed } = await deserializeProject(parsed);
    expect(fixed.layers.map((l) => l.group)).toEqual([B.group, null, null]);
  });
});

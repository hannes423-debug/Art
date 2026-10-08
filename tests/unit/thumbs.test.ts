import { describe, expect, it } from 'vitest';
import { compositeFrame, compositeSampled, sampleGrid } from '../../src/core/composite';
import { ArtDocument } from '../../src/core/document';
import { History } from '../../src/core/history';
import { Layer } from '../../src/core/layer';
import { addFrame, setTags } from '../../src/ops';
import { crispSize } from '../../src/ui/thumb-animator';

describe('thumbnail sampling', () => {
  it('nearest-neighbour samples equal the full composite at those pixels (groups, opacity, blend modes)', () => {
    let seed = 11;
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const d = ArtDocument.createBlank(13, 9);
    for (let n = 0; n < 3; n++) {
      const l = Layer.blank(`L${n}`, 13, 9, 1);
      const data = l.cels[0].ensureData();
      for (let i = 0; i < data.length; i++) data[i] = rand() < 0.3 ? 0 : Math.floor(rand() * 256);
      l.opacity = 0.4 + 0.2 * n;
      l.blendMode = (['normal', 'multiply', 'screen'] as const)[n];
      d.insertLayer(l, d.layers.length);
    }
    d.groups.push({ id: 1, name: 'G', visible: true, opacity: 0.7, collapsed: false });
    d.layers[1].group = 1;
    d.layers[2].group = 1;
    const full = compositeFrame(d, 0);
    const xs = sampleGrid(5, 13);
    const ys = sampleGrid(4, 9);
    const s = compositeSampled(d, 0, xs, ys);
    for (let j = 0; j < 4; j++)
      for (let i = 0; i < 5; i++) {
        const a = (ys[j] * 13 + xs[i]) * 4;
        expect([...s.subarray((j * 5 + i) * 4, (j * 5 + i) * 4 + 4)]).toEqual([...full.subarray(a, a + 4)]);
      }
  });

  it('sample grids hit pixel centers and never interpolate', () => {
    expect([...sampleGrid(4, 4)]).toEqual([0, 1, 2, 3]);
    expect([...sampleGrid(2, 8)]).toEqual([2, 6]);
    expect([...sampleGrid(8, 2)]).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
  });

  it('display sizes use whole-number zoom for small sprites and keep the aspect ratio', () => {
    expect(crispSize(16, 16, 96)).toEqual({ w: 96, h: 96 });
    expect(crispSize(24, 12, 96)).toEqual({ w: 96, h: 48 });
    expect(crispSize(50, 20, 96)).toEqual({ w: 50, h: 20 });
    expect(crispSize(192, 96, 96)).toEqual({ w: 96, h: 48 });
  });
});

describe('default animation for previews', () => {
  it('is the tag around the active frame in its direction, else every frame', () => {
    const d = ArtDocument.createBlank(1, 1);
    const h = new History();
    for (let i = 0; i < 4; i++) addFrame(d, h, 'empty');
    expect(d.animationOrder(0)).toEqual([0, 1, 2, 3, 4]);
    setTags(d, h, [
      { name: 'idle', from: 0, to: 1, color: '#5aa9ff', direction: 'forward' },
      { name: 'walk', from: 2, to: 4, color: '#ff6b6b', direction: 'pingpong' },
    ]);
    expect(d.animationOrder(0)).toEqual([0, 1]);
    expect(d.animationOrder(3)).toEqual([2, 3, 4, 3]);
  });
});

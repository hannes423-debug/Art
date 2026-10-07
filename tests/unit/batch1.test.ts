import { describe, expect, it } from 'vitest';
import { ArtDocument } from '../../src/core/document';
import { History } from '../../src/core/history';
import { Layer } from '../../src/core/layer';
import { PaintSession } from '../../src/core/paint';
import { encodeGIF, lzwEncode } from '../../src/io/gif';
import { decodePNG, encodeAPNG } from '../../src/io/png';
import { replaceColor } from '../../src/ops';

const red = { r: 255, g: 0, b: 0, a: 255 };

/** Minimal GIF LZW decoder for checking the encoder. */
function lzwDecode(bytes: Uint8Array, pos: number, count: number): { out: number[]; end: number } {
  const minCode = bytes[pos++];
  const data: number[] = [];
  while (bytes[pos]) {
    const n = bytes[pos++];
    for (let i = 0; i < n; i++) data.push(bytes[pos++]);
  }
  pos++;
  const clear = 1 << minCode;
  const eoi = clear + 1;
  let size = minCode + 1;
  let dict: number[][] = [];
  const reset = () => {
    dict = [];
    for (let i = 0; i < clear; i++) dict[i] = [i];
    dict[clear] = [];
    dict[eoi] = [];
    size = minCode + 1;
  };
  reset();
  const out: number[] = [];
  let bit = 0;
  let prev: number[] | null = null;
  const read = () => {
    let v = 0;
    for (let i = 0; i < size; i++, bit++) v |= ((data[bit >> 3] >> (bit & 7)) & 1) << i;
    return v;
  };
  for (;;) {
    const code = read();
    if (code === clear) {
      reset();
      prev = null;
      continue;
    }
    if (code === eoi) break;
    let entry: number[];
    if (code < dict.length) entry = dict[code];
    else entry = [...prev!, prev![0]];
    out.push(...entry);
    if (prev) dict.push([...prev, entry[0]]);
    prev = entry;
    if (dict.length === 1 << size && size < 12) size++;
  }
  expect(out.length).toBe(count);
  return { out, end: pos };
}

describe('GIF encoder', () => {
  it('LZW round-trips long and repetitive index streams', () => {
    let seed = 3;
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (const [len, colors] of [
      [1, 2],
      [100, 4],
      [20000, 16],
      [70000, 256],
    ]) {
      const idx = new Uint8Array(len);
      for (let i = 0; i < len; i++) idx[i] = i % 7 === 0 ? Math.floor(rand() * colors) : idx[Math.max(0, i - 1)];
      const minCode = Math.max(2, Math.ceil(Math.log2(colors)));
      const { out } = lzwDecode(lzwEncode(idx, minCode), 0, len);
      expect(out).toEqual([...idx]);
    }
  });

  it('writes a looping animation with transparency and per-frame delays', () => {
    const w = 3;
    const h = 2;
    const f1 = new Uint8ClampedArray(w * h * 4);
    f1.set([255, 0, 0, 255], 0);
    const f2 = new Uint8ClampedArray(w * h * 4);
    f2.set([0, 0, 255, 255], 4 * 5);
    const gif = encodeGIF(w, h, [
      { data: f1, duration: 100 },
      { data: f2, duration: 250 },
    ]);
    expect(String.fromCharCode(...gif.subarray(0, 6))).toBe('GIF89a');
    expect(gif[6] | (gif[7] << 8)).toBe(3);
    const text = String.fromCharCode(...gif);
    expect(text).toContain('NETSCAPE2.0');
    // Find both graphic control blocks and image data.
    const delays: number[] = [];
    const frames: number[][] = [];
    let p = text.indexOf('NETSCAPE2.0') + 11 + 5;
    while (gif[p] !== 0x3b) {
      expect(gif[p]).toBe(0x21);
      expect(gif[p + 1]).toBe(0xf9);
      delays.push(gif[p + 4] | (gif[p + 5] << 8));
      p += 8;
      expect(gif[p]).toBe(0x2c);
      p += 10;
      const r = lzwDecode(gif, p, w * h);
      frames.push(r.out);
      p = r.end;
    }
    expect(delays).toEqual([10, 25]);
    // Palette: index 0 transparent, then red and blue.
    const pal = (i: number) => [...gif.subarray(13 + i * 3, 16 + i * 3)];
    expect(pal(frames[0][0])).toEqual([255, 0, 0]);
    expect(frames[0].slice(1)).toEqual([0, 0, 0, 0, 0]);
    expect(pal(frames[1][5])).toEqual([0, 0, 255]);
  });

  it('reduces images with many colors to a 255-color palette', () => {
    const w = 64;
    const h = 64;
    const d = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) d.set([i & 255, (i >> 4) & 255, (i * 7) & 255, 255], i * 4);
    const gif = encodeGIF(w, h, [{ data: d, duration: 100 }]);
    expect(gif[10] & 7).toBe(7); // 256-entry table
    expect(gif.at(-1)).toBe(0x3b);
  });
});

describe('APNG encoder', () => {
  it('writes acTL, fcTL and fdAT chunks; the default image is frame 1', async () => {
    const f1 = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 0, 0]);
    const f2 = new Uint8ClampedArray([0, 255, 0, 128, 0, 0, 255, 255]);
    const bytes = await encodeAPNG(2, 1, [
      { data: f1, duration: 80 },
      { data: f2, duration: 120 },
    ]);
    const types: string[] = [];
    let p = 8;
    let seq: number[] = [];
    const dv = new DataView(bytes.buffer, bytes.byteOffset);
    while (p < bytes.length) {
      const len = dv.getUint32(p);
      const type = String.fromCharCode(...bytes.subarray(p + 4, p + 8));
      types.push(type);
      if (type === 'fcTL' || type === 'fdAT') seq.push(dv.getUint32(p + 8));
      if (type === 'acTL') expect([dv.getUint32(p + 8), dv.getUint32(p + 12)]).toEqual([2, 0]);
      if (type === 'fcTL') expect(dv.getUint16(p + 8 + 20)).toBeGreaterThan(0);
      p += 12 + len;
    }
    expect(types.filter((t) => ['acTL', 'fcTL', 'IDAT', 'fdAT'].includes(t))).toEqual(['acTL', 'fcTL', 'IDAT', 'fcTL', 'fdAT']);
    expect(seq).toEqual([0, 1, 2]);
    const first = await decodePNG(bytes);
    expect([...first.data]).toEqual([...f1]);
  });
});

describe('symmetry and tile wrapping', () => {
  it('wraps coverage across the canvas edges in tile mode', () => {
    const d = ArtDocument.createBlank(8, 8);
    const s = new PaintSession(d, d.activeCel, { color: red, opacity: 1, mode: 'paint', alphaLock: false });
    s.wrapX = true;
    s.wrapY = true;
    s.dabPixel(8, 3, 3, false); // covers x 7..9 → 7, 0, 1
    s.span(6, 6, 9); // 6, 7, 0, 1
    s.dabPixel(-1, -1, 1, false); // → (7, 7)
    s.commit('t');
    const on = (x: number, y: number) => d.activeCel.getPixel(x, y)[3] === 255;
    expect([on(7, 3), on(0, 3), on(1, 3), on(2, 3), on(6, 3)]).toEqual([true, true, true, false, false]);
    expect([on(6, 6), on(7, 6), on(0, 6), on(1, 6), on(2, 6)]).toEqual([true, true, true, true, false]);
    expect(on(7, 7)).toBe(true);
  });
});

describe('replace color', () => {
  it('replaces within tolerance, on all layers and frames, as one undo step', () => {
    const d = ArtDocument.createBlank(4, 1, 'T', { r: 250, g: 0, b: 0, a: 255 });
    const top = Layer.blank('Top', 4, 1, 1);
    top.cels[0].ensureData().set([255, 0, 0, 255, 0, 0, 255, 255]);
    d.insertLayer(top, 1);
    const h = new History();
    const blue = { r: 0, g: 0, b: 255, a: 255 };
    const white = { r: 255, g: 255, b: 255, a: 255 };
    expect(replaceColor(d, h, { from: red, to: white, tolerance: 0, allLayers: false, allFrames: false })).toBe(1);
    h.undo();
    expect(top.cels[0].getPixel(0, 0)).toEqual([255, 0, 0, 255]);
    expect(replaceColor(d, h, { from: red, to: white, tolerance: 8, allLayers: true, allFrames: false })).toBe(5);
    expect(d.layers[0].cels[0].getPixel(3, 0)).toEqual([255, 255, 255, 255]);
    expect(top.cels[0].getPixel(1, 0)).toEqual([0, 0, 255, 255]);
    expect(h.undoCount).toBe(1);
    h.undo();
    expect(d.layers[0].cels[0].getPixel(3, 0)).toEqual([250, 0, 0, 255]);
    // Transparent → color fills the empty pixels; color → transparent clears to (0,0,0,0).
    expect(replaceColor(d, h, { from: { r: 0, g: 0, b: 0, a: 0 }, to: blue, tolerance: 0, allLayers: false, allFrames: false })).toBe(2);
    expect(top.cels[0].getPixel(3, 0)).toEqual([0, 0, 255, 255]);
    replaceColor(d, h, { from: blue, to: { r: 9, g: 9, b: 9, a: 0 }, tolerance: 0, allLayers: false, allFrames: false });
    expect(top.cels[0].getPixel(1, 0)).toEqual([0, 0, 0, 0]);
  });
});

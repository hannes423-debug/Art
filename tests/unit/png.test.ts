import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { crc32, decodePNG, encodePNG, isPNG } from '../../src/io/png';

function randomImage(w: number, h: number, seed = 1): Uint8ClampedArray {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) >> 8) & 255;
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < d.length; i++) d[i] = rnd();
  return d;
}

function canonical(d: Uint8ClampedArray): Uint8ClampedArray {
  const c = d.slice();
  for (let i = 0; i < c.length; i += 4) if (c[i + 3] === 0) c[i] = c[i + 1] = c[i + 2] = 0;
  return c;
}

/** Lists chunk types, asserting every chunk CRC is valid (as libpng would). */
function chunkTypes(png: Uint8Array): string[] {
  const types: string[] = [];
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let p = 8;
  while (p < png.length) {
    const len = dv.getUint32(p);
    types.push(String.fromCharCode(...png.subarray(p + 4, p + 8)));
    expect(dv.getUint32(p + 8 + len)).toBe(crc32(png, p + 4, p + 8 + len));
    p += 12 + len;
  }
  return types;
}

/** Builds a PNG from raw (already filtered) scanline bytes using Node's zlib. */
function buildPNG(w: number, h: number, bitDepth: number, colorType: number, raw: Uint8Array, extra: [string, Uint8Array][] = [], interlace = 0): Uint8Array {
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[12] = interlace;
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    ...extra.map(([t, d]) => chunk(t, d)),
    chunk('IDAT', new Uint8Array(deflateSync(raw))),
    chunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

describe('PNG codec', () => {
  it('computes the standard CRC32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('round-trips random RGBA exactly, including semi-transparent pixels', async () => {
    for (const [w, h] of [
      [1, 1],
      [7, 3],
      [64, 64],
      [33, 17],
    ]) {
      const d = randomImage(w, h, w * 31 + h);
      const png = await encodePNG(w, h, d);
      expect(isPNG(png)).toBe(true);
      expect(chunkTypes(png)[0]).toBe('IHDR');
      const img = await decodePNG(png);
      expect(img.width).toBe(w);
      expect(img.height).toBe(h);
      expect(Array.from(img.data)).toEqual(Array.from(canonical(d)));
    }
  });

  it('keeps hidden colors of transparent pixels when canonicalization is off', async () => {
    const d = new Uint8ClampedArray([10, 20, 30, 0, 200, 100, 50, 128]);
    const png = await encodePNG(2, 1, d, { canonicalizeTransparent: false, allowPalette: false });
    const img = await decodePNG(png);
    expect(Array.from(img.data)).toEqual(Array.from(d));
  });

  it('uses an indexed palette with packed bit depth for few colors', async () => {
    const w = 13;
    const h = 5;
    const colors = [
      [0, 0, 0, 0],
      [255, 0, 0, 255],
      [0, 128, 255, 77],
    ];
    const d = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) d.set(colors[(i * 7) % 3], i * 4);
    const png = await encodePNG(w, h, d);
    expect(chunkTypes(png)).toEqual(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);
    expect(png[24]).toBe(2); // bit depth: 3 colors -> 2 bits
    expect(png[25]).toBe(3); // color type: palette
    const img = await decodePNG(png);
    expect(Array.from(img.data)).toEqual(Array.from(d));
  });

  it('writes opaque images without alpha', async () => {
    const w = 20;
    const h = 20;
    const d = randomImage(w, h, 5);
    for (let i = 3; i < d.length; i += 4) d[i] = 255;
    const png = await encodePNG(w, h, d);
    expect(png[25]).toBe(2); // RGB
    const img = await decodePNG(png);
    expect(Array.from(img.data)).toEqual(Array.from(d));
  });

  it('decodes 16-bit RGBA', async () => {
    // 2x1: pixel0 = (0x1234,0xffff,0x0000,0x8080) pixel1 = (0xffff,0,0x7f7f,0xffff)
    const raw = new Uint8Array([0, 0x12, 0x34, 0xff, 0xff, 0, 0, 0x80, 0x80, 0xff, 0xff, 0, 0, 0x7f, 0x7f, 0xff, 0xff]);
    const img = await decodePNG(buildPNG(2, 1, 16, 6, raw));
    expect(Array.from(img.data)).toEqual([0x12, 255, 0, 0x80, 255, 0, 0x7f, 255]);
  });

  it('decodes 2-bit grayscale with tRNS color key', async () => {
    // 4 pixels: values 0,1,2,3 packed into one byte; tRNS marks value 2 transparent.
    const raw = new Uint8Array([0, 0b00011011]);
    const img = await decodePNG(buildPNG(4, 1, 2, 0, raw, [['tRNS', new Uint8Array([0, 2])]]));
    expect(Array.from(img.data)).toEqual([0, 0, 0, 255, 85, 85, 85, 255, 170, 170, 170, 0, 255, 255, 255, 255]);
  });

  it('decodes Adam7-interlaced RGB', async () => {
    const w = 5;
    const h = 5;
    const pixel = (x: number, y: number) => [x * 50, y * 50, (x + y) * 20];
    const passes = [
      [0, 0, 8, 8],
      [4, 0, 8, 8],
      [0, 4, 4, 8],
      [2, 0, 4, 4],
      [0, 2, 2, 4],
      [1, 0, 2, 2],
      [0, 1, 1, 2],
    ];
    const bytes: number[] = [];
    for (const [x0, y0, dx, dy] of passes) {
      for (let y = y0; y < h; y += dy) {
        const row: number[] = [];
        for (let x = x0; x < w; x += dx) row.push(...pixel(x, y));
        if (row.length) bytes.push(0, ...row);
      }
    }
    const img = await decodePNG(buildPNG(w, h, 8, 2, new Uint8Array(bytes), [], 1));
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        expect(Array.from(img.data.subarray(o, o + 4))).toEqual([...pixel(x, y), 255]);
      }
    }
  });

  it('decodes all filter types written by another encoder (sub/up/avg/paeth)', async () => {
    const w = 4;
    const h = 4;
    const src = randomImage(w, h, 99);
    // Encode manually with filter = row index % 5 to cover every filter.
    const bpp = 4;
    const rowBytes = w * 4;
    const raw: number[] = [];
    for (let y = 0; y < h + 1; y++) {
      const yy = y % h;
      const f = y % 5;
      raw.push(f);
      for (let i = 0; i < rowBytes; i++) {
        const cur = src[yy * rowBytes + i];
        const a = i >= bpp ? src[yy * rowBytes + i - bpp] : 0;
        const b = yy > 0 || y > 0 ? (y > 0 ? src[((y - 1) % h) * rowBytes + i] : 0) : 0;
        const c = i >= bpp && y > 0 ? src[((y - 1) % h) * rowBytes + i - bpp] : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pae = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        const pred = [0, a, b, (a + b) >> 1, pae][f];
        raw.push((cur - pred) & 255);
      }
    }
    const img = await decodePNG(buildPNG(w, h + 1, 8, 6, new Uint8Array(raw)));
    for (let y = 0; y < h + 1; y++) {
      const yy = y % h;
      expect(Array.from(img.data.subarray(y * rowBytes, (y + 1) * rowBytes))).toEqual(Array.from(src.subarray(yy * rowBytes, (yy + 1) * rowBytes)));
    }
  });

  it('rejects non-PNG data', async () => {
    await expect(decodePNG(new Uint8Array([1, 2, 3]))).rejects.toThrow();
  });
});

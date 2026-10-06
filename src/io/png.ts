import { type Pixels, allocPixels } from '../core/surface';

/**
 * A small, exact PNG encoder/decoder.
 *
 * Why not canvas.toBlob()/drawImage()? Browsers store canvas pixels with
 * premultiplied alpha, which silently alters the color of semi-transparent
 * pixels on every round trip, and they may apply color management to
 * decoded images. A sprite editor must preserve pixels exactly, so PNG is
 * handled here and zlib (de)compression uses the native
 * CompressionStream/DecompressionStream APIs.
 */

export interface RawImage {
  width: number;
  height: number;
  data: Pixels;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

let crcTable: Uint32Array | null = null;

export function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = crcTable[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function hasCompressionStreams(): boolean {
  return typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';
}

async function transform(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const piped = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(piped).arrayBuffer());
}

export function zlibCompress(data: Uint8Array): Promise<Uint8Array> {
  return transform(data, new CompressionStream('deflate'));
}

export function zlibDecompress(data: Uint8Array): Promise<Uint8Array> {
  return transform(data, new DecompressionStream('deflate'));
}

export function isPNG(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  for (let i = 0; i < 8; i++) if (bytes[i] !== SIGNATURE[i]) return false;
  return true;
}

// ---------------------------------------------------------------- Encoder

export interface EncodeOptions {
  /** Store fully transparent pixels as (0,0,0,0) so they compress well. Default true. */
  canonicalizeTransparent?: boolean;
  /** Use an indexed palette when the image has at most 256 colors. Default true. */
  allowPalette?: boolean;
}

export async function encodePNG(width: number, height: number, rgba: Uint8ClampedArray, opts: EncodeOptions = {}): Promise<Uint8Array> {
  if (rgba.length !== width * height * 4) throw new Error('encodePNG: data length mismatch');
  const canon = opts.canonicalizeTransparent !== false;
  const n = width * height;

  // Analyze the image to choose the most compact lossless color type.
  let hasAlpha = false;
  let gray = true;
  let paletteOK = opts.allowPalette !== false;
  const colors = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const a = rgba[o + 3];
    let r = rgba[o];
    let g = rgba[o + 1];
    let b = rgba[o + 2];
    if (a === 0 && canon) r = g = b = 0;
    if (a !== 255) hasAlpha = true;
    if (gray && (r !== g || g !== b)) gray = false;
    if (paletteOK) {
      const key = ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
      if (!colors.has(key)) {
        if (colors.size >= 256) {
          paletteOK = false;
          colors.clear();
        } else colors.set(key, colors.size);
      }
    }
  }

  let colorType: number;
  let bitDepth = 8;
  if (paletteOK && colors.size <= 16) colorType = 3;
  else if (gray && !hasAlpha) colorType = 0;
  else if (paletteOK) colorType = 3;
  else if (gray) colorType = 4;
  else if (!hasAlpha) colorType = 2;
  else colorType = 6;

  const chunks: Uint8Array[] = [];
  let raw: Uint8Array;

  if (colorType === 3) {
    // Translucent entries first so tRNS stays short.
    const keys = [...colors.keys()].sort((p, q) => {
      const pa = (p & 255) === 255 ? 1 : 0;
      const qa = (q & 255) === 255 ? 1 : 0;
      return pa - qa || colors.get(p)! - colors.get(q)!;
    });
    keys.forEach((k, i) => colors.set(k, i));
    const count = keys.length;
    bitDepth = count <= 2 ? 1 : count <= 4 ? 2 : count <= 16 ? 4 : 8;
    const plte = new Uint8Array(count * 3);
    let trnsLen = 0;
    keys.forEach((k, i) => {
      plte[i * 3] = k >>> 24;
      plte[i * 3 + 1] = (k >>> 16) & 255;
      plte[i * 3 + 2] = (k >>> 8) & 255;
      if ((k & 255) !== 255) trnsLen = i + 1;
    });
    const rowBytes = Math.ceil((width * bitDepth) / 8);
    raw = new Uint8Array((rowBytes + 1) * height);
    for (let y = 0; y < height; y++) {
      const rowStart = y * (rowBytes + 1) + 1; // filter byte 0 (None) is already zero
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4;
        const a = rgba[o + 3];
        const key = a === 0 && canon ? 0 : ((rgba[o] << 24) | (rgba[o + 1] << 16) | (rgba[o + 2] << 8) | a) >>> 0;
        const idx = colors.get(key)!;
        if (bitDepth === 8) raw[rowStart + x] = idx;
        else {
          const bit = x * bitDepth;
          raw[rowStart + (bit >> 3)] |= idx << (8 - bitDepth - (bit & 7));
        }
      }
    }
    chunks.push(makeChunk('PLTE', plte));
    if (trnsLen > 0) {
      const trns = new Uint8Array(trnsLen);
      for (let i = 0; i < trnsLen; i++) trns[i] = keys[i] & 255;
      chunks.push(makeChunk('tRNS', trns));
    }
  } else {
    const channels = colorType === 0 ? 1 : colorType === 4 ? 2 : colorType === 2 ? 3 : 4;
    const rowBytes = width * channels;
    raw = new Uint8Array((rowBytes + 1) * height);
    let prev = new Uint8Array(rowBytes);
    let cur = new Uint8Array(rowBytes);
    const candidates = [0, 1, 2, 3, 4].map(() => new Uint8Array(rowBytes));
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4;
        const a = rgba[o + 3];
        const zero = a === 0 && canon;
        const r = zero ? 0 : rgba[o];
        const p = x * channels;
        if (colorType === 0) cur[p] = r;
        else if (colorType === 4) {
          cur[p] = r;
          cur[p + 1] = a;
        } else {
          cur[p] = r;
          cur[p + 1] = zero ? 0 : rgba[o + 1];
          cur[p + 2] = zero ? 0 : rgba[o + 2];
          if (colorType === 6) cur[p + 3] = a;
        }
      }
      const best = chooseFilter(cur, prev, channels, candidates);
      const off = y * (rowBytes + 1);
      raw[off] = best;
      raw.set(candidates[best], off + 1);
      [prev, cur] = [cur, prev];
    }
  }

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // no interlace

  const idat = await zlibCompress(raw);
  const parts = [new Uint8Array(SIGNATURE), makeChunk('IHDR', ihdr), ...chunks, makeChunk('IDAT', idat), makeChunk('IEND', new Uint8Array(0))];
  return concat(parts);
}

/** Applies all five PNG filters and returns the index of the one with the smallest signed-sum heuristic. */
function chooseFilter(cur: Uint8Array, prev: Uint8Array, bpp: number, out: Uint8Array[]): number {
  const n = cur.length;
  let bestSum = Infinity;
  let best = 0;
  for (let f = 0; f < 5; f++) {
    const o = out[f];
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v: number;
      switch (f) {
        case 0:
          v = cur[i];
          break;
        case 1:
          v = cur[i] - a;
          break;
        case 2:
          v = cur[i] - b;
          break;
        case 3:
          v = cur[i] - ((a + b) >> 1);
          break;
        default:
          v = cur[i] - paeth(a, b, c);
      }
      v &= 255;
      o[i] = v;
      sum += v < 128 ? v : 256 - v;
      if (sum >= bestSum) break;
    }
    // A filter that stopped early can never be the winner, so the winner's buffer is complete.
    if (sum < bestSum) {
      bestSum = sum;
      best = f;
    }
  }
  return best;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function makeChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

// ---------------------------------------------------------------- Decoder

const ADAM7: [number, number, number, number][] = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export async function decodePNG(bytes: Uint8Array): Promise<RawImage> {
  if (!isPNG(bytes)) throw new Error('Not a PNG file');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = 0;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  while (pos + 8 <= bytes.length) {
    const len = dv.getUint32(pos);
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const start = pos + 8;
    const end = start + len;
    if (end > bytes.length) throw new Error('Truncated PNG file');
    const chunk = bytes.subarray(start, end);
    if (type === 'IHDR') {
      width = dv.getUint32(start);
      height = dv.getUint32(start + 4);
      bitDepth = bytes[start + 8];
      colorType = bytes[start + 9];
      interlace = bytes[start + 12];
      if (bytes[start + 10] !== 0 || bytes[start + 11] !== 0) throw new Error('Unsupported PNG compression/filter method');
    } else if (type === 'PLTE') palette = chunk;
    else if (type === 'tRNS') trns = chunk;
    else if (type === 'IDAT') idat.push(chunk);
    else if (type === 'IEND') break;
    pos = end + 4;
  }
  const channels = CHANNELS[colorType];
  if (!width || !height || !channels) throw new Error('Invalid PNG header');
  const validDepths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
  if (!validDepths[colorType].includes(bitDepth)) throw new Error('Invalid PNG bit depth');
  if (colorType === 3 && !palette) throw new Error('PNG palette missing');
  if (width * height > 8192 * 8192) throw new Error('PNG image too large');

  const data = await zlibDecompress(concat(idat));
  const out = allocPixels(width, height);
  const bitsPP = channels * bitDepth;
  const bpp = Math.max(1, bitsPP >> 3);
  const maxVal = (1 << bitDepth) - 1;

  // tRNS for gray / RGB: a single color key (16-bit samples).
  let keyGray = -1;
  let keyR = -1;
  let keyG = -1;
  let keyB = -1;
  if (trns && colorType === 0 && trns.length >= 2) keyGray = (trns[0] << 8) | trns[1];
  if (trns && colorType === 2 && trns.length >= 6) {
    keyR = (trns[0] << 8) | trns[1];
    keyG = (trns[2] << 8) | trns[3];
    keyB = (trns[4] << 8) | trns[5];
  }

  const to8 = (v: number): number => (bitDepth === 16 ? Math.round(v / 257) : bitDepth === 8 ? v : Math.round((v * 255) / maxVal));

  let offset = 0;
  const passes = interlace ? ADAM7 : ([[0, 0, 1, 1]] as [number, number, number, number][]);
  for (const [x0, y0, dx, dy] of passes) {
    const pw = Math.ceil((width - x0) / dx);
    const ph = Math.ceil((height - y0) / dy);
    if (pw <= 0 || ph <= 0) continue;
    const rowBytes = Math.ceil((pw * bitsPP) / 8);
    let prev = new Uint8Array(rowBytes);
    let cur = new Uint8Array(rowBytes);
    for (let r = 0; r < ph; r++) {
      if (offset + 1 + rowBytes > data.length) throw new Error('PNG image data is incomplete');
      const ft = data[offset];
      cur.set(data.subarray(offset + 1, offset + 1 + rowBytes));
      offset += 1 + rowBytes;
      unfilter(ft, cur, prev, bpp);
      const y = y0 + r * dy;
      const sample = (i: number): number => {
        if (bitDepth === 8) return cur[i];
        if (bitDepth === 16) return (cur[i * 2] << 8) | cur[i * 2 + 1];
        const bit = i * bitDepth;
        return (cur[bit >> 3] >> (8 - bitDepth - (bit & 7))) & maxVal;
      };
      for (let i = 0; i < pw; i++) {
        const o = (y * width + x0 + i * dx) * 4;
        const s = i * channels;
        switch (colorType) {
          case 0: {
            const v = sample(s);
            const g = to8(v);
            out[o] = out[o + 1] = out[o + 2] = g;
            out[o + 3] = v === keyGray ? 0 : 255;
            break;
          }
          case 2: {
            const rv = sample(s);
            const gv = sample(s + 1);
            const bv = sample(s + 2);
            out[o] = to8(rv);
            out[o + 1] = to8(gv);
            out[o + 2] = to8(bv);
            out[o + 3] = rv === keyR && gv === keyG && bv === keyB ? 0 : 255;
            break;
          }
          case 3: {
            const idx = sample(s);
            const p = idx * 3;
            if (palette && p + 2 < palette.length) {
              out[o] = palette[p];
              out[o + 1] = palette[p + 1];
              out[o + 2] = palette[p + 2];
              out[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
            }
            break;
          }
          case 4: {
            const g = to8(sample(s));
            out[o] = out[o + 1] = out[o + 2] = g;
            out[o + 3] = to8(sample(s + 1));
            break;
          }
          default: {
            out[o] = to8(sample(s));
            out[o + 1] = to8(sample(s + 1));
            out[o + 2] = to8(sample(s + 2));
            out[o + 3] = to8(sample(s + 3));
          }
        }
      }
      [prev, cur] = [cur, prev];
    }
  }
  return { width, height, data: out };
}

function unfilter(ft: number, cur: Uint8Array, prev: Uint8Array, bpp: number): void {
  const n = cur.length;
  switch (ft) {
    case 0:
      return;
    case 1:
      for (let i = bpp; i < n; i++) cur[i] += cur[i - bpp];
      return;
    case 2:
      for (let i = 0; i < n; i++) cur[i] += prev[i];
      return;
    case 3:
      for (let i = 0; i < n; i++) cur[i] += ((i >= bpp ? cur[i - bpp] : 0) + prev[i]) >> 1;
      return;
    case 4:
      for (let i = 0; i < n; i++) cur[i] += paeth(i >= bpp ? cur[i - bpp] : 0, prev[i], i >= bpp ? prev[i - bpp] : 0);
      return;
    default:
      throw new Error(`Invalid PNG filter type ${ft}`);
  }
}

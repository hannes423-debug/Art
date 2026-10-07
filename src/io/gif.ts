/**
 * Animated GIF encoder (GIF89a).
 *
 * All frames share one global palette. Images with at most 255 colors are
 * stored exactly; larger ones are reduced with median cut. Pixels with
 * alpha below 128 become the transparent index (GIF has 1-bit alpha).
 */

export interface GifFrame {
  data: Uint8ClampedArray;
  /** Display time in milliseconds. */
  duration: number;
}

const TRANSPARENT = 0;

/** Builds a palette of at most `max` RGB colors (packed 0xRRGGBB) for the opaque pixels of all frames. */
export function buildPalette(frames: Uint8ClampedArray[], max = 255): number[] {
  const counts = new Map<number, number>();
  for (const d of frames) {
    for (let o = 0; o < d.length; o += 4) {
      if (d[o + 3] < 128) continue;
      const k = (d[o] << 16) | (d[o + 1] << 8) | d[o + 2];
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  if (counts.size <= max) return [...counts.keys()];
  return medianCut(counts, max);
}

/** Median cut over a color histogram. */
function medianCut(counts: Map<number, number>, max: number): number[] {
  type Box = { colors: number[]; weights: number[] };
  const all: Box = { colors: [], weights: [] };
  for (const [c, n] of counts) {
    all.colors.push(c);
    all.weights.push(n);
  }
  const channel = (c: number, ch: number) => (c >> (16 - ch * 8)) & 255;
  const range = (b: Box): [number, number] => {
    let best = 0;
    let bestCh = 0;
    for (let ch = 0; ch < 3; ch++) {
      let lo = 255;
      let hi = 0;
      for (const c of b.colors) {
        const v = channel(c, ch);
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (hi - lo > best) {
        best = hi - lo;
        bestCh = ch;
      }
    }
    return [best, bestCh];
  };
  const boxes: Box[] = [all];
  while (boxes.length < max) {
    // Split the box with the widest color range (ties: most pixels).
    let idx = -1;
    let bestScore = 0;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].colors.length < 2) continue;
      const [r] = range(boxes[i]);
      const total = boxes[i].weights.reduce((a, b) => a + b, 0);
      const score = r * Math.log2(total + 1);
      if (score > bestScore) {
        bestScore = score;
        idx = i;
      }
    }
    if (idx < 0) break;
    const b = boxes[idx];
    const [, ch] = range(b);
    const order = b.colors.map((_, i) => i).sort((p, q) => channel(b.colors[p], ch) - channel(b.colors[q], ch));
    const total = b.weights.reduce((a, c) => a + c, 0);
    let acc = 0;
    let cut = 1;
    for (let i = 0; i < order.length - 1; i++) {
      acc += b.weights[order[i]];
      if (acc >= total / 2) {
        cut = i + 1;
        break;
      }
      cut = i + 1;
    }
    const pick = (ids: number[]): Box => ({ colors: ids.map((i) => b.colors[i]), weights: ids.map((i) => b.weights[i]) });
    boxes.splice(idx, 1, pick(order.slice(0, cut)), pick(order.slice(cut)));
  }
  return boxes.map((b) => {
    let r = 0;
    let g = 0;
    let bl = 0;
    let n = 0;
    b.colors.forEach((c, i) => {
      const w = b.weights[i];
      r += channel(c, 0) * w;
      g += channel(c, 1) * w;
      bl += channel(c, 2) * w;
      n += w;
    });
    return (Math.round(r / n) << 16) | (Math.round(g / n) << 8) | Math.round(bl / n);
  });
}

/** Maps RGBA pixels to palette indices (index 0 = transparent, palette entry i = index i + 1). */
export function indexPixels(data: Uint8ClampedArray, palette: number[]): Uint8Array {
  const exact = new Map<number, number>();
  palette.forEach((c, i) => exact.set(c, i + 1));
  const cache = new Map<number, number>();
  const out = new Uint8Array(data.length / 4);
  for (let i = 0, o = 0; o < data.length; i++, o += 4) {
    if (data[o + 3] < 128) {
      out[i] = TRANSPARENT;
      continue;
    }
    const k = (data[o] << 16) | (data[o + 1] << 8) | data[o + 2];
    let idx = exact.get(k) ?? cache.get(k);
    if (idx === undefined) {
      let best = Infinity;
      idx = 1;
      for (let p = 0; p < palette.length; p++) {
        const c = palette[p];
        const dr = ((c >> 16) & 255) - data[o];
        const dg = ((c >> 8) & 255) - data[o + 1];
        const db = (c & 255) - data[o + 2];
        // Weighted distance roughly matching perceived brightness.
        const d = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
        if (d < best) {
          best = d;
          idx = p + 1;
        }
      }
      cache.set(k, idx);
    }
    out[i] = idx;
  }
  return out;
}

class ByteWriter {
  private buf = new Uint8Array(1 << 16);
  length = 0;
  private ensure(n: number): void {
    if (this.length + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.length + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
  }
  byte(b: number): void {
    this.ensure(1);
    this.buf[this.length++] = b & 255;
  }
  u16(v: number): void {
    this.byte(v);
    this.byte(v >> 8);
  }
  bytes(b: ArrayLike<number>): void {
    this.ensure(b.length);
    this.buf.set(b, this.length);
    this.length += b.length;
  }
  ascii(s: string): void {
    for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i));
  }
  result(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

/** GIF LZW compression of an index stream, written as data sub-blocks. */
export function lzwEncode(indices: Uint8Array, minCodeSize: number, w: ByteWriter | null = null): Uint8Array {
  const out = w ?? new ByteWriter();
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let codeSize = minCodeSize + 1;
  let next = eoi + 1;
  let dict = new Map<number, number>();
  const block: number[] = [];
  let bitBuf = 0;
  let bitCount = 0;
  const flushBlock = () => {
    if (!block.length) return;
    out.byte(block.length);
    out.bytes(block);
    block.length = 0;
  };
  const emit = (code: number) => {
    bitBuf |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      block.push(bitBuf & 255);
      if (block.length === 255) flushBlock();
      bitBuf >>>= 8;
      bitCount -= 8;
    }
  };
  out.byte(minCodeSize);
  emit(clear);
  if (indices.length) {
    let prefix = indices[0];
    for (let i = 1; i < indices.length; i++) {
      const k = indices[i];
      const key = (prefix << 8) | k;
      const found = dict.get(key);
      if (found !== undefined) {
        prefix = found;
        continue;
      }
      emit(prefix);
      if (next < 4096) {
        dict.set(key, next++);
        // The decoder grows its code size one code later than the encoder adds it.
        if (next > 1 << codeSize && codeSize < 12) codeSize++;
      } else {
        emit(clear);
        dict = new Map();
        codeSize = minCodeSize + 1;
        next = eoi + 1;
      }
      prefix = k;
    }
    emit(prefix);
  }
  emit(eoi);
  if (bitCount > 0) block.push(bitBuf & 255);
  flushBlock();
  out.byte(0); // block terminator
  return w ? new Uint8Array(0) : out.result();
}

/** Encodes frames as a looping animated GIF. */
export function encodeGIF(width: number, height: number, frames: GifFrame[], loop = true): Uint8Array {
  const palette = buildPalette(
    frames.map((f) => f.data),
    255,
  );
  const entries = palette.length + 1;
  let bits = 1;
  while (1 << bits < entries) bits++;
  const tableSize = 1 << bits;
  const w = new ByteWriter();
  w.ascii('GIF89a');
  w.u16(width);
  w.u16(height);
  w.byte(0x80 | ((bits - 1) << 4) | (bits - 1)); // global color table
  w.byte(TRANSPARENT); // background color index
  w.byte(0); // pixel aspect ratio
  for (let i = 0; i < tableSize; i++) {
    const c = i === 0 || i > palette.length ? 0 : palette[i - 1];
    w.byte(c >> 16);
    w.byte(c >> 8);
    w.byte(c);
  }
  if (loop && frames.length > 1) {
    w.bytes([0x21, 0xff, 0x0b]);
    w.ascii('NETSCAPE2.0');
    w.bytes([0x03, 0x01, 0x00, 0x00, 0x00]); // loop forever
  }
  const minCodeSize = Math.max(2, bits);
  for (const f of frames) {
    // Graphic control: restore to background (so transparent areas clear), transparent index 0.
    w.bytes([0x21, 0xf9, 0x04, (2 << 2) | 1]);
    w.u16(Math.max(2, Math.round(f.duration / 10)));
    w.byte(TRANSPARENT);
    w.byte(0);
    // Image descriptor: full frame, no local color table.
    w.byte(0x2c);
    w.u16(0);
    w.u16(0);
    w.u16(width);
    w.u16(height);
    w.byte(0);
    lzwEncode(indexPixels(f.data, palette), minCodeSize, w);
  }
  w.byte(0x3b);
  return w.result();
}

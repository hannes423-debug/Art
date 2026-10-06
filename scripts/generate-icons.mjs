// Generates the app icons (pixel-art pencil) as PNG and SVG.
// Usage: node scripts/generate-icons.mjs   (no dependencies)
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const OUT = new URL('../public/icons/', import.meta.url);
mkdirSync(OUT, { recursive: true });

const N = 16;
const COLORS = {
  K: [20, 22, 27], // outline
  P: [232, 106, 138], // eraser
  p: [190, 74, 108],
  M: [196, 204, 216], // ferrule
  m: [140, 150, 166],
  H: [255, 226, 122], // body highlight
  Y: [247, 197, 72], // body
  y: [214, 150, 40], // body shade
  W: [236, 205, 162], // wood
  L: [52, 56, 66], // lead
  B: [90, 169, 255], // drawn stroke
  b: [47, 127, 224],
};
const BG = [33, 38, 46];
const BG_EDGE = [44, 51, 62];

// Pencil along the anti-diagonal x + y = 15: s = x + y selects the band, t = x - y the position.
const art = Array.from({ length: N }, () => Array(N).fill('.'));
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    const s = x + y;
    const t = x - y;
    if (s < 14 || s > 16) continue;
    let c = '.';
    if (t >= 8 && t <= 11) c = s === 16 ? 'p' : 'P';
    else if (t >= 6 && t <= 7) c = s === 16 ? 'm' : 'M';
    else if (t >= -4 && t <= 5) c = s === 14 ? 'H' : s === 15 ? 'Y' : 'y';
    else if (t >= -6 && t <= -5) c = 'W';
    else if (t === -7 && s === 15) c = 'W';
    else if (t === -9 && s === 15) c = 'L';
    else if (t === -8 && s !== 15) c = s === 14 ? 'W' : '.';
    art[y][x] = c;
  }
}
// The drawn stroke: a smooth curve under the tip.
for (const [x, y] of [
  [0, 13],
  [1, 14],
  [2, 14],
  [3, 14],
  [4, 15],
  [5, 15],
  [6, 15],
  [7, 15],
  [8, 14],
  [9, 14],
  [10, 13],
  [11, 13],
])
  art[y][x] = x < 4 ? 'b' : 'B';
// Auto outline around the pencil (not the stroke).
const isPencil = (x, y) => x >= 0 && y >= 0 && x < N && y < N && 'PpMmHYyWL'.includes(art[y][x]);
const outline = [];
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    if (art[y][x] !== '.') continue;
    if (isPencil(x - 1, y) || isPencil(x + 1, y) || isPencil(x, y - 1) || isPencil(x, y + 1)) outline.push([x, y]);
  }
}
for (const [x, y] of outline) art[y][x] = 'K';

// ---------------------------------------------------------------- PNG encoder
const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Renders the icon. `radius` is the corner radius as a fraction of size
 * (0 = square, full bleed); `scale` is device pixels per art pixel.
 */
function render(size, scale, radius, opaque = false) {
  const buf = Buffer.alloc(size * size * 4);
  const r = radius * size;
  const off = Math.round((size - N * scale) / 2);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Rounded-square background with anti-aliased corners (4×4 supersampling).
      let cov = 1;
      if (r > 0) {
        let inside = 0;
        for (let sy = 0; sy < 4; sy++) {
          for (let sx = 0; sx < 4; sx++) {
            const px = x + (sx + 0.5) / 4;
            const py = y + (sy + 0.5) / 4;
            const cx = Math.min(Math.max(px, r), size - r);
            const cy = Math.min(Math.max(py, r), size - r);
            if ((px - cx) ** 2 + (py - cy) ** 2 <= r * r) inside++;
          }
        }
        cov = inside / 16;
      }
      if (opaque) cov = 1;
      // Subtle vertical gradient.
      const g = y / size;
      let col = BG.map((c, i) => Math.round(c + (BG_EDGE[i] - c) * (1 - g) * 0.6));
      const ax = Math.floor((x - off) / scale);
      const ay = Math.floor((y - off) / scale);
      if (ax >= 0 && ay >= 0 && ax < N && ay < N && art[ay][ax] !== '.') col = COLORS[art[ay][ax]];
      const o = (y * size + x) * 4;
      buf[o] = col[0];
      buf[o + 1] = col[1];
      buf[o + 2] = col[2];
      buf[o + 3] = Math.round(cov * 255);
    }
  }
  return png(size, size, buf);
}

const write = (name, data) => writeFileSync(new URL(name, OUT), data);
write('icon-192.png', render(192, 10, 0.22));
write('icon-512.png', render(512, 26, 0.22));
// Maskable: full-bleed background, artwork inside the 80% safe zone.
write('icon-maskable-512.png', render(512, 20, 0));
// iOS adds its own rounded corners and ignores transparency.
write('apple-touch-icon.png', render(180, 10, 0, true));
write('favicon-32.png', render(32, 2, 0.18));

// SVG (favicon & "any size" icon): one rect per pixel.
const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
let rects = '';
for (let y = 0; y < N; y++)
  for (let x = 0; x < N; x++) if (art[y][x] !== '.') rects += `<rect x="${x + 2}" y="${y + 2}" width="1" height="1" fill="${hex(COLORS[art[y][x]])}"/>`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" shape-rendering="crispEdges"><rect width="20" height="20" rx="4.4" fill="${hex(BG)}" shape-rendering="geometricPrecision"/>${rects}</svg>\n`;
write('icon.svg', svg);
console.log('Icons written to public/icons/');
console.log(art.map((r) => r.join('')).join('\n'));

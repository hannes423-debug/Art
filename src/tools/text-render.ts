import type { RGBA } from '../core/color';
import { type TextAlign, type TextImage, renderPixelText } from '../core/pixel-font';

export type TextFont = 'pixel' | 'sans-serif' | 'serif' | 'monospace';

export interface TextStyle {
  font: TextFont;
  /** Pixel font: scale factor. Other fonts: size in pixels. */
  size: number;
  bold: boolean;
  /** Smooth edges (system fonts). Off: every pixel is fully on or off. */
  antialias: boolean;
  align: TextAlign;
}

/** Renders text to straight RGBA pixels in `color`, trimmed to the inked area plus a 1px margin. */
export function renderText(text: string, style: TextStyle, color: RGBA): TextImage | null {
  if (!text.trim()) return null;
  if (style.font === 'pixel') return renderPixelText(text, color, Math.max(1, Math.round(style.size)), style.align);
  const size = Math.max(4, Math.min(400, Math.round(style.size)));
  const lines = text.replace(/\r/g, '').split('\n');
  const font = `${style.bold ? 'bold ' : ''}${size}px ${style.font}`;
  const measure = document.createElement('canvas').getContext('2d')!;
  measure.font = font;
  const lineH = Math.ceil(size * 1.25);
  const widths = lines.map((l) => Math.ceil(measure.measureText(l).width));
  const pad = Math.ceil(size * 0.5);
  const w = Math.max(1, Math.max(...widths) + pad * 2);
  const h = lineH * lines.length + pad * 2;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.font = font;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#fff';
  lines.forEach((l, i) => {
    const x = style.align === 'left' ? pad : style.align === 'center' ? (w - widths[i]) / 2 : w - pad - widths[i];
    ctx.fillText(l, x, pad + i * lineH + size);
  });
  // Use only the coverage (alpha) and apply the exact color, so no premultiplication artifacts.
  const src = ctx.getImageData(0, 0, w, h).data;
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = src[(y * w + x) * 4 + 3];
      if (!style.antialias) a = a >= 128 ? 255 : 0;
      if (!a) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  const tw = x1 - x0 + 1;
  const th = y1 - y0 + 1;
  const data = new Uint8ClampedArray(tw * th * 4);
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      let a = src[((y + y0) * w + x + x0) * 4 + 3];
      if (!style.antialias) a = a >= 128 ? 255 : 0;
      if (!a) continue;
      const o = (y * tw + x) * 4;
      data[o] = color.r;
      data[o + 1] = color.g;
      data[o + 2] = color.b;
      data[o + 3] = Math.round((a * color.a) / 255);
    }
  }
  c.width = c.height = 0;
  return { width: tw, height: th, data };
}

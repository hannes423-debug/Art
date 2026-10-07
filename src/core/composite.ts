import type { ArtDocument } from './document';
import { type Rect, clipRect } from './geometry';
import type { BlendMode, Layer } from './layer';
import { type Pixels, allocPixels } from './surface';

/**
 * Exact (non-premultiplied, float) compositing used for export, merging and
 * merged color sampling. The on-screen view uses canvas compositing with
 * equivalent formulas (W3C Compositing and Blending), so what you see is
 * what you export.
 */

/**
 * Composites `src` (srcW×srcH) onto `dst` (dstW×dstH) with its top-left at
 * (dx, dy), clipped to the destination.
 */
export function blendImage(
  dst: Uint8ClampedArray,
  dstW: number,
  dstH: number,
  src: Uint8ClampedArray,
  srcW: number,
  srcH: number,
  dx: number,
  dy: number,
  opacity = 1,
  mode: BlendMode = 'normal',
): void {
  const area = clipRect({ x: dx, y: dy, w: srcW, h: srcH }, dstW, dstH);
  if (!area || opacity <= 0) return;
  for (let y = area.y; y < area.y + area.h; y++) {
    let o = (y * dstW + area.x) * 4;
    let s = ((y - dy) * srcW + (area.x - dx)) * 4;
    for (let x = 0; x < area.w; x++, o += 4, s += 4) {
      const sa8 = src[s + 3];
      if (sa8 === 0) continue;
      blendPixel(dst, o, src[s], src[s + 1], src[s + 2], (sa8 / 255) * opacity, mode);
    }
  }
}

/** Blends one non-premultiplied source pixel (alpha `sa` in 0..1) into dst at byte offset `o`. */
export function blendPixel(dst: Uint8ClampedArray, o: number, sr: number, sg: number, sb: number, sa: number, mode: BlendMode): void {
  if (sa <= 0) return;
  const da = dst[o + 3] / 255;
  if (da === 0) {
    dst[o] = sr;
    dst[o + 1] = sg;
    dst[o + 2] = sb;
    dst[o + 3] = sa * 255;
    return;
  }
  const dr = dst[o];
  const dg = dst[o + 1];
  const db = dst[o + 2];
  if (mode === 'add') {
    // Porter-Duff "plus" (canvas 'lighter'): add premultiplied colors.
    const oa = Math.min(1, sa + da);
    dst[o] = Math.min(255, sr * sa + dr * da) / oa;
    dst[o + 1] = Math.min(255, sg * sa + dg * da) / oa;
    dst[o + 2] = Math.min(255, sb * sa + db * da) / oa;
    dst[o + 3] = oa * 255;
    return;
  }
  let cr = sr;
  let cg = sg;
  let cb = sb;
  if (mode === 'multiply') {
    cr = (1 - da) * sr + (da * sr * dr) / 255;
    cg = (1 - da) * sg + (da * sg * dg) / 255;
    cb = (1 - da) * sb + (da * sb * db) / 255;
  } else if (mode === 'screen') {
    cr = (1 - da) * sr + da * (sr + dr - (sr * dr) / 255);
    cg = (1 - da) * sg + da * (sg + dg - (sg * dg) / 255);
    cb = (1 - da) * sb + da * (sb + db - (sb * db) / 255);
  }
  const k = da * (1 - sa);
  const oa = sa + k;
  dst[o] = (cr * sa + dr * k) / oa;
  dst[o + 1] = (cg * sa + dg * k) / oa;
  dst[o + 2] = (cb * sa + db * k) / oa;
  dst[o + 3] = oa * 255;
}

export interface CompositeOptions {
  /** Region to composite; defaults to the whole document. */
  rect?: Rect;
  /** Restrict to these layers (still composited in document order). */
  layers?: Layer[];
  /** Include hidden layers. */
  includeHidden?: boolean;
}

/**
 * Flattens the visible layers of a frame into a new RGBA buffer of size
 * rect.w × rect.h. A layer group is composited on its own first and the
 * result blended with the group's opacity.
 */
export function compositeFrame(doc: ArtDocument, frame: number, opts: CompositeOptions = {}): Pixels {
  const rect = opts.rect ?? { x: 0, y: 0, w: doc.width, h: doc.height };
  const out = allocPixels(rect.w, rect.h);
  const layers = doc.layers;
  const blendLayer = (dst: Pixels, layer: Layer) => {
    if (opts.layers && !opts.layers.includes(layer)) return;
    if (!layer.visible && !opts.includeHidden) return;
    const cel = layer.cels[frame];
    if (!cel?.data || layer.opacity <= 0) return;
    blendImage(dst, rect.w, rect.h, cel.data, doc.width, doc.height, -rect.x, -rect.y, layer.opacity, layer.blendMode);
  };
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    const group = doc.groupOf(layer);
    if (!group) {
      blendLayer(out, layer);
      continue;
    }
    let j = i;
    while (j + 1 < layers.length && layers[j + 1].group === layer.group) j++;
    if ((group.visible || opts.includeHidden) && group.opacity > 0) {
      const tmp = allocPixels(rect.w, rect.h);
      for (let k = i; k <= j; k++) blendLayer(tmp, layers[k]);
      blendImage(out, rect.w, rect.h, tmp, rect.w, rect.h, 0, 0, group.opacity, 'normal');
    }
    i = j;
  }
  return out;
}

/** Color of the flattened image at a pixel. */
export function sampleComposite(doc: ArtDocument, frame: number, x: number, y: number): [number, number, number, number] {
  if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) return [0, 0, 0, 0];
  const p = compositeFrame(doc, frame, { rect: { x, y, w: 1, h: 1 } });
  return [p[0], p[1], p[2], p[3]];
}

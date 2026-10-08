import { compositeSampled, sampleGrid } from './composite';
import type { ArtDocument } from './document';
import { type Pixels, allocPixels } from './surface';

/** The frames (and their durations) of an animation preview, at most `maxFrames` long. */
export function previewFrames(doc: ArtDocument, order: number[], maxFrames: number): { order: number[]; durations: number[] } {
  let durations = order.map((f) => doc.frames[f].duration);
  if (order.length <= maxFrames) return { order, durations };
  // Keep the timing: each kept frame shows for the frames it stands for.
  const keep: number[] = [];
  const dur: number[] = [];
  const step = order.length / maxFrames;
  for (let i = 0; i < maxFrames; i++) {
    const a = Math.floor(i * step);
    const b = Math.floor((i + 1) * step);
    keep.push(order[a]);
    dur.push(durations.slice(a, b).reduce((x, y) => x + y, 0));
  }
  durations = dur;
  return { order: keep, durations };
}

/**
 * Renders the given frames side by side, each scaled nearest-neighbour to
 * fit `maxSide` (never enlarged; displays zoom by whole numbers).
 */
export function renderStrip(
  doc: ArtDocument,
  order: number[],
  maxSide: number,
): { data: Pixels; width: number; height: number; frameW: number; frameH: number } {
  const k = Math.min(1, maxSide / Math.max(doc.width, doc.height));
  const fw = Math.max(1, Math.round(doc.width * k));
  const fh = Math.max(1, Math.round(doc.height * k));
  const xs = sampleGrid(fw, doc.width);
  const ys = sampleGrid(fh, doc.height);
  const W = fw * order.length;
  const data = allocPixels(W, fh);
  order.forEach((f, i) => {
    const px = compositeSampled(doc, f, xs, ys);
    for (let y = 0; y < fh; y++) data.set(px.subarray(y * fw * 4, (y + 1) * fw * 4), (y * W + i * fw) * 4);
  });
  return { data, width: W, height: fh, frameW: fw, frameH: fh };
}

/** Key that changes whenever the preview of these frames would look different. */
export function previewKey(doc: ArtDocument, order: number[], durations: number[]): string {
  return [
    doc.width,
    doc.height,
    order.join('.'),
    durations.join('.'),
    doc.groups.map((g) => `${g.id}:${g.visible}:${g.opacity}`).join(','),
    doc.layers
      .map((l) => `${l.id}:${l.visible}:${l.opacity}:${l.blendMode}:${l.group}:${order.map((f) => `${l.cels[f].id}v${l.cels[f].version}`).join('/')}`)
      .join(','),
  ].join('|');
}

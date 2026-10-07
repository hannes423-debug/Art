import { encodeAnimation } from './io/image';

export type TimelapseFormat = 'video' | 'gif' | 'apng';

/** A video container the browser can record, if any (MP4 preferred for sharing). */
export function videoMime(): string | null {
  if (typeof MediaRecorder === 'undefined' || typeof HTMLCanvasElement.prototype.captureStream !== 'function') return null;
  for (const m of ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return null;
}

/**
 * Turns timelapse snapshots into a video, GIF or APNG of `seconds` length
 * (plus a short hold on the finished image). Every frame is fitted into
 * the size of the last snapshot, so canvas resizes during the drawing
 * still play back cleanly.
 */
export async function renderTimelapse(
  pngs: Blob[],
  format: TimelapseFormat,
  seconds: number,
  onProgress: (fraction: number) => void = () => {},
): Promise<{ blob: Blob; ext: string }> {
  if (!pngs.length) throw new Error('Nothing has been recorded yet');
  const bitmaps: ImageBitmap[] = [];
  for (const p of pngs) bitmaps.push(await createImageBitmap(p));
  const last = bitmaps[bitmaps.length - 1];
  const W = last.width;
  const H = last.height;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const opaque = format === 'video';
  const draw = (b: ImageBitmap) => {
    ctx.clearRect(0, 0, W, H);
    if (opaque) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, W, H);
    }
    const k = Math.min(W / b.width, H / b.height);
    ctx.imageSmoothingEnabled = k < 1;
    const w = b.width * k;
    const h = b.height * k;
    ctx.drawImage(b, (W - w) / 2, (H - h) / 2, w, h);
  };
  const step = Math.max(10, Math.round((seconds * 1000) / bitmaps.length));
  const hold = 1500;
  try {
    if (format === 'video') {
      const mime = videoMime();
      if (!mime) throw new Error('This browser cannot record video. Choose GIF or APNG.');
      const stream = canvas.captureStream(0);
      const track = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void };
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4_000_000 });
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      const stopped = new Promise<void>((r) => (rec.onstop = () => r()));
      draw(bitmaps[0]);
      rec.start();
      for (let i = 0; i < bitmaps.length; i++) {
        draw(bitmaps[i]);
        track.requestFrame?.();
        onProgress(i / bitmaps.length);
        await new Promise((r) => setTimeout(r, i === bitmaps.length - 1 ? hold : step));
      }
      rec.stop();
      await stopped;
      const type = mime.split(';')[0];
      return { blob: new Blob(chunks, { type }), ext: type === 'video/mp4' ? 'mp4' : 'webm' };
    }
    const frames = bitmaps.map((b, i) => {
      draw(b);
      onProgress(i / bitmaps.length);
      return { data: ctx.getImageData(0, 0, W, H).data, duration: i === bitmaps.length - 1 ? hold : step };
    });
    const blob = await encodeAnimation(W, H, frames, format);
    return { blob, ext: format === 'gif' ? 'gif' : 'png' };
  } finally {
    for (const b of bitmaps) b.close();
  }
}

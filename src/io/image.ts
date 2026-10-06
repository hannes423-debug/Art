import type { RGBA } from '../core/color';
import { MAX_DIMENSION } from '../core/document';
import { type Pixels, allocPixels } from '../core/surface';
import { type RawImage, decodePNG, encodePNG, hasCompressionStreams, isPNG } from './png';

export type ExportFormat = 'png' | 'jpeg' | 'webp';

export const FORMAT_MIME: Record<ExportFormat, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };
export const FORMAT_EXT: Record<ExportFormat, string> = { png: 'png', jpeg: 'jpg', webp: 'webp' };

/** Detects common formats from file contents (extensions and MIME types are unreliable on mobile). */
export function sniffType(bytes: Uint8Array): 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp' | 'json' | 'unknown' {
  if (isPNG(bytes)) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'gif';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45) return 'webp';
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'bmp';
  for (let i = 0; i < Math.min(bytes.length, 64); i++) {
    const c = bytes[i];
    if (c === 0x7b) return 'json';
    if (c !== 0x20 && c !== 0x0a && c !== 0x0d && c !== 0x09 && c !== 0xef && c !== 0xbb && c !== 0xbf) break;
  }
  return 'unknown';
}

/**
 * Decodes an image file to exact RGBA. PNGs use the built-in decoder (no
 * premultiplication or color management); other formats use the browser.
 */
export async function decodeImage(blob: Blob): Promise<RawImage> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (isPNG(bytes) && hasCompressionStreams()) {
    try {
      const img = await decodePNG(bytes);
      checkSize(img.width, img.height);
      return img;
    } catch (err) {
      console.warn('Built-in PNG decoder failed, using the browser decoder', err);
    }
  }
  return decodeWithBrowser(blob);
}

function checkSize(w: number, h: number): void {
  if (w > MAX_DIMENSION || h > MAX_DIMENSION) throw new Error(`Image is too large (${w}×${h}). The maximum is ${MAX_DIMENSION}×${MAX_DIMENSION}.`);
}

async function decodeWithBrowser(blob: Blob): Promise<RawImage> {
  let source: CanvasImageSource;
  let width: number;
  let height: number;
  let cleanup = () => {};
  try {
    const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    source = bmp;
    width = bmp.width;
    height = bmp.height;
    cleanup = () => bmp.close();
  } catch {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.src = url;
    try {
      await img.decode();
    } catch {
      URL.revokeObjectURL(url);
      throw new Error('This file is not an image format the browser can read.');
    }
    source = img;
    width = img.naturalWidth;
    height = img.naturalHeight;
    cleanup = () => URL.revokeObjectURL(url);
  }
  try {
    checkSize(width, height);
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(source, 0, 0);
    const data = ctx.getImageData(0, 0, width, height).data as Pixels;
    c.width = c.height = 0;
    return { width, height, data };
  } finally {
    cleanup();
  }
}

let webpSupport: Promise<boolean> | null = null;

/** Whether the browser can encode WebP (Safari cannot; it silently returns PNG). */
export function webpEncodeSupported(): Promise<boolean> {
  if (!webpSupport) {
    webpSupport = new Promise((resolve) => {
      const c = document.createElement('canvas');
      c.width = c.height = 1;
      c.toBlob((b) => resolve(!!b && b.type === 'image/webp'), 'image/webp');
    });
  }
  return webpSupport;
}

function canvasFromPixels(w: number, h: number, data: Uint8ClampedArray): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const copy = allocPixels(w, h);
  copy.set(data);
  c.getContext('2d')!.putImageData(new ImageData(copy, w, h), 0, 0);
  return c;
}

/**
 * Encodes an image. PNG is lossless and exact (including alpha); JPEG has
 * no alpha, so it is composited onto `background` explicitly.
 */
export async function encodeImage(img: RawImage, format: ExportFormat, quality = 0.92, background: RGBA = { r: 255, g: 255, b: 255, a: 255 }): Promise<Blob> {
  if (format === 'png' && hasCompressionStreams()) {
    const bytes = await encodePNG(img.width, img.height, img.data);
    return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/png' });
  }
  const src = canvasFromPixels(img.width, img.height, img.data);
  let out = src;
  if (format === 'jpeg') {
    out = document.createElement('canvas');
    out.width = img.width;
    out.height = img.height;
    const ctx = out.getContext('2d')!;
    ctx.fillStyle = `rgb(${background.r} ${background.g} ${background.b})`;
    ctx.fillRect(0, 0, img.width, img.height);
    ctx.drawImage(src, 0, 0);
  }
  const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, FORMAT_MIME[format], quality));
  if (!blob) throw new Error('The browser could not encode the image.');
  return blob;
}

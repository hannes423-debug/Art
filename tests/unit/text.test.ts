import { describe, expect, it } from 'vitest';
import { PIXEL_FONT, renderPixelText } from '../../src/core/pixel-font';

const black = { r: 0, g: 0, b: 0, a: 255 };

/** ASCII art of a rendered image ('#' = ink). */
function art(img: { width: number; height: number; data: Uint8ClampedArray }): string[] {
  const rows: string[] = [];
  for (let y = 0; y < img.height; y++) {
    let r = '';
    for (let x = 0; x < img.width; x++) r += img.data[(y * img.width + x) * 4 + 3] ? '#' : '.';
    rows.push(r);
  }
  return rows;
}

describe('pixel font', () => {
  it('draws glyphs exactly, with 1px spacing and descenders', () => {
    const img = renderPixelText('Hi', black)!;
    expect(img.width).toBe(2 * PIXEL_FONT.advance - 1);
    expect(img.height).toBe(PIXEL_FONT.height);
    expect(art(img)).toEqual(['#...#...#..', '#...#......', '#...#..##..', '#####...#..', '#...#...#..', '#...#...#..', '#...#..###.', '...........']);
    const g = art(renderPixelText('g', black)!);
    expect(g[7]).toBe('.###.');
  });

  it('scales, aligns lines and replaces unknown characters', () => {
    const big = renderPixelText('.', black, 3)!;
    expect([big.width, big.height]).toEqual([15, 24]);
    expect(big.data[(15 * 15 + 3) * 4 + 3]).toBe(255);
    const two = renderPixelText('ab\nc', black, 1, 'right')!;
    expect(two.width).toBe(11);
    expect(two.height).toBe(PIXEL_FONT.lineHeight + PIXEL_FONT.height);
    // 'c' is right-aligned under 'b'.
    const rows = art(two);
    expect(rows[PIXEL_FONT.lineHeight + 2].slice(6)).toBe('.###.');
    expect(art(renderPixelText('é', black)!)).toEqual(art(renderPixelText('?', black)!));
    expect(renderPixelText('', black)).toBeNull();
  });
});

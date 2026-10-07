import type { RGBA } from './color';

/**
 * A built-in 5×7 pixel font (printable ASCII, with descenders on g, j, p,
 * q and y), drawn for Art. Each glyph is 8 rows of 5 bits, one base-32
 * digit per row, starting at the space character (32).
 */
const GLYPHS =
  '0000000044444040aa000000aavavaa04fke5u40op248j30cik8lid044000000248884208422248004lel400044v44000000c480000v000000000cc001248g00ehjlphe04c4444e0eh1248v0v2421he026aiv220vgu11he068guhhe0v1248880ehhehhe0ehhf12c00cc0cc000cc0c480248g842000v0v00084212480eh124040eh1dlle0ehhvhhh0uhhuhhu0ehggghe0sihhhis0vgguggv0vgguggg0ehgnhhf0hhhvhhh0e44444e072222ic0hikokih0ggggggv0hrllhhh0hhpljhh0ehhhhhe0uhhuggg0ehhhlid0uhhukih0fgge11u0v4444440hhhhhhe0hhhhha40hhhllla0hha4ahh0hhha4440v1248gv0e88888e00g842100e22222e04ah00000000000v08400000000e1fhf0ggmphhu000egghe011djhhf000ehvge0698s888000fhhf1eggmphhh040c444e0206222icggikoki0c44444e000qllhh000mphhh000ehhhe000uhhugg00fhhf1100mpggg000fge1u088s8896000hhhjd000hhha4000hhlla000ha4ah000hhhf1e00v248v0244844204444444084424480008l2000';

export const PIXEL_FONT = { width: 5, height: 8, advance: 6, lineHeight: 10 } as const;

function glyphRows(ch: string): number[] {
  let code = ch.charCodeAt(0);
  if (code < 32 || code > 126) code = 63; // '?'
  const i = (code - 32) * 8;
  const rows: number[] = [];
  for (let r = 0; r < 8; r++) rows.push(parseInt(GLYPHS[i + r], 32));
  return rows;
}

export type TextAlign = 'left' | 'center' | 'right';

export interface TextImage {
  width: number;
  height: number;
  data: Uint8ClampedArray<ArrayBuffer>;
}

/** Renders text with the pixel font: crisp pixels in one color, each font pixel scaled to scale×scale. */
export function renderPixelText(text: string, color: RGBA, scale = 1, align: TextAlign = 'left'): TextImage | null {
  const lines = text.replace(/\r/g, '').split('\n');
  const { advance, lineHeight } = PIXEL_FONT;
  const widths = lines.map((l) => (l.length ? l.length * advance - 1 : 0));
  const wMax = Math.max(...widths);
  if (wMax <= 0) return null;
  // The last line only needs the glyph height (including descenders).
  const hTotal = (lines.length - 1) * lineHeight + PIXEL_FONT.height;
  const width = wMax * scale;
  const height = hTotal * scale;
  const data = new Uint8ClampedArray(width * height * 4);
  lines.forEach((line, li) => {
    const off = align === 'left' ? 0 : align === 'center' ? Math.floor((wMax - widths[li]) / 2) : wMax - widths[li];
    for (let ci = 0; ci < line.length; ci++) {
      const rows = glyphRows(line[ci]);
      const gx = off + ci * advance;
      const gy = li * lineHeight;
      for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 5; c++) {
          if (!(rows[r] & (1 << (4 - c)))) continue;
          for (let sy = 0; sy < scale; sy++) {
            for (let sx = 0; sx < scale; sx++) {
              const o = (((gy + r) * scale + sy) * width + (gx + c) * scale + sx) * 4;
              data[o] = color.r;
              data[o + 1] = color.g;
              data[o + 2] = color.b;
              data[o + 3] = color.a;
            }
          }
        }
      }
    }
  });
  return { width, height, data };
}

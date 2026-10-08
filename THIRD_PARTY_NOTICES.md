# Third-party notices

Art has no runtime dependencies. The following third-party material is
included or adapted.

## Lucide icons (ISC License)

Several interface icons in `src/ui/icons.ts` are adapted from
[Lucide](https://lucide.dev).

```
ISC License

Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of
Feather (MIT). All other copyright (c) for Lucide are held by Lucide
Contributors 2022.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

## Built-in palettes

The preset palettes in `src/core/palette.ts` are lists of color values
(data, not artwork). They are freely published color sets or palettes made
for Art:

- **DawnBringer 32** and **DawnBringer 16** by DawnBringer, released for free use by the pixel art community.
- **Endesga 32** by Endesga and **Sweetie 16** by GrafxKid, both published for free use.
- **PICO-8** — the 16-color palette of the PICO-8 fantasy console by Lexaloffle Games.
- **Game Boy** — the classic four-shade green screen; **Game Boy Pocket** — four gray shades.
- **NES** — a commonly published approximation of the colors the NES (Ricoh 2C02) produces; there is no single official table.
- **Commodore 64** — the color measurements published by Philip “Pepto” Timmermann.
- **GBA-style 32** and **SNES-style 16** — original palettes made for Art. The
  Game Boy Advance and SNES have no fixed palette (games choose from 32 768
  colors), so these are starter palettes whose colors are limited to the
  consoles' 15-bit RGB555 color space.
- **Grayscale** (8 steps) and **1-bit** (black and white).

## Algorithms

- The 1-pixel ellipse rasterizer follows the integer midpoint approach
  described by Alois Zingl in *A Rasterizing Algorithm for Drawing Curves*
  (2012).
- The pixel-perfect stroke cleanup follows the widely used technique of
  removing the middle pixel of L-shaped corners in freehand 1-pixel lines.

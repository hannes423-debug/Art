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

The preset palettes in `src/core/palette.ts` are freely published color sets:

- **DawnBringer 32** by DawnBringer, released for free use by the pixel art community.
- **PICO-8** — the 16-color palette of the PICO-8 fantasy console by Lexaloffle Games.
- **Game Boy** — the classic four-shade green palette.
- **Grayscale** — an 8-step gray ramp.

## Algorithms

- The 1-pixel ellipse rasterizer follows the integer midpoint approach
  described by Alois Zingl in *A Rasterizing Algorithm for Drawing Curves*
  (2012).
- The pixel-perfect stroke cleanup follows the widely used technique of
  removing the middle pixel of L-shaped corners in freehand 1-pixel lines.

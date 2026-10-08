# Art project format (`.artproj`) — version 3

An Art project is a single **UTF-8 JSON** file. It is meant to be easy to read
and write from any language: there is no compression layer, no binary header,
and every image is a standard PNG.

The format is open and may be used freely by other tools.

## Example

```json
{
  "format": "art-project",
  "version": 3,
  "generator": "Art 0.1.0",
  "name": "knight",
  "width": 24,
  "height": 24,
  "frames": [{ "duration": 100 }, { "duration": 100 }, { "duration": 100 }],
  "tags": [{ "name": "walk", "from": 0, "to": 2, "color": "#5aa9ff", "direction": "pingpong" }],
  "groups": [{ "id": 1, "name": "Body", "visible": true, "opacity": 1, "collapsed": false }],
  "layers": [
    {
      "name": "Shadow",
      "visible": true,
      "opacity": 1,
      "blendMode": "normal",
      "alphaLocked": false,
      "cels": ["data:image/png;base64,iVBORw0KGgo…", null, { "link": 0 }]
    },
    {
      "name": "Knight",
      "visible": true,
      "opacity": 0.8,
      "blendMode": "multiply",
      "alphaLocked": true,
      "group": 1,
      "cels": ["data:image/png;base64,iVBORw0KGgo…", "data:image/png;base64,iVBORw0KGgo…", null]
    }
  ],
  "activeLayer": 1,
  "activeFrame": 0,
  "palette": ["#000000", "#df7126", "#5b6ee180"],
  "grid": { "enabled": true, "width": 16, "height": 16 },
  "created": "2026-10-05T12:00:00.000Z",
  "modified": "2026-10-05T12:30:00.000Z"
}
```

## Fields

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `format` | string | yes | Always `"art-project"`. |
| `version` | integer | yes | Format version. Readers must reject versions newer than they understand. This document describes version `3`. Art writes the lowest version that can hold the project: `3` if it has layer groups, else `2` if it has linked cels, else `1`. |
| `generator` | string | no | Application that wrote the file. Informational only. |
| `name` | string | no | Document name. |
| `width`, `height` | integer | yes | Canvas size in pixels, `1`–`8192`. |
| `frames` | array | no | One entry per animation frame, in order. Each is `{ "duration": ms }` (display time in milliseconds, minimum 10). Defaults to a single 100 ms frame. |
| `tags` | array | no | Animation tags: `{ "name", "from", "to", "color", "direction" }`. `from`/`to` are inclusive frame indices; `color` is `#rrggbb`; `direction` is `"forward"`, `"reverse"` or `"pingpong"`. Tags may overlap. |
| `groups` | array | no | (version 3) Layer groups: `{ "id": integer, "name", "visible", "opacity", "collapsed" }`. A group is composited from its member layers on a transparent background, then blended onto the layers below with the group `opacity` (normal blending); a hidden group hides all its members. `collapsed` is an editor setting. |
| `layers` | array | yes | Layers **from bottom to top**. At least one. |
| `layers[].name` | string | no | Layer name. |
| `layers[].visible` | boolean | no | Default `true`. Hidden layers are not part of exports. |
| `layers[].opacity` | number | no | `0`–`1`, default `1`. |
| `layers[].blendMode` | string | no | `"normal"`, `"multiply"`, `"screen"` or `"add"`. Unknown values are read as `"normal"`. |
| `layers[].alphaLocked` | boolean | no | Editor setting: painting keeps existing transparency. |
| `layers[].group` | integer | no | (version 3) `id` of the group the layer belongs to. Members of a group are adjacent in `layers`. |
| `layers[].cels` | array | yes | One entry per frame (same length as `frames`). Each entry is a PNG image as a `data:image/png;base64,` URL, `null` for a fully transparent cel, or (version 2) `{ "link": i }`: a *linked cel* that shares its pixels with frame `i` of the same layer, where `i` is smaller than the entry's own frame index and refers to an entry that is not itself a link. |
| `activeLayer` | integer | no | Index into `layers` of the layer selected when saved. |
| `activeFrame` | integer | no | Index into `frames` of the frame selected when saved. |
| `palette` | array | no | Palette colors as `#rrggbb` or `#rrggbbaa` strings. |
| `paletteName` | string | no | Name of that palette (for display; readers may ignore it). |
| `grid` | object | no | Editor grid: `{ "enabled": boolean, "width": px, "height": px }`. |
| `created`, `modified` | string | no | ISO-8601 timestamps. |

## Cel images

- Every cel PNG has exactly the canvas size (`width` × `height`).
- Pixels are **straight (non-premultiplied) RGBA**. The PNG may use any valid
  color type and bit depth; Art writes indexed (palette) PNGs when a cel has
  256 colors or fewer, otherwise RGB or RGBA, all 8 bits per channel.
- Fully transparent pixels are stored as `(0, 0, 0, 0)`.
- No color-space conversion is applied: values are stored and read as-is.
  (`gAMA`/`iCCP` chunks are not written and are ignored when reading.)

## Compositing

The image for a frame is produced by blending the visible layers from bottom to
top onto a transparent background, each with its `opacity` and `blendMode`,
following the W3C *Compositing and Blending Level 1* formulas (source-over for
`normal`; separable `multiply`/`screen`; `add` is Porter-Duff *plus*, i.e.
canvas `lighter`).

## Version history

- **3** — layer groups (`groups`, `layers[].group`).
- **2** — linked cels (`{ "link": i }` entries). Also added in this release,
  without a version change because older readers can ignore them: `tags`.
- **1** — initial format.

## Compatibility rules

- Readers should ignore unknown fields. Writers may add fields without
  changing `version` if older readers can safely ignore them.
- A change that older readers cannot ignore (for example a new required field
  or a different cel encoding) increments `version`.

## In-browser storage

Inside the browser, Art keeps projects in IndexedDB (database `art`, stores
`meta` and `data`; timelapse snapshots live in a separate `timelapse` store
and are not part of the project file) using the same structure, except that cels are PNG `Blob`s
instead of data URLs. "Save project as file" always writes the portable JSON
format described above.

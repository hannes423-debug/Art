import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { decodePNG } from '../../src/io/png';
import { drawMouse, layerPixel, newImage, openApp, pixelPoint, selectTool, setFg } from './helpers';

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

const menu = async (page: import('@playwright/test').Page, top: string, item: string | RegExp) => {
  await page.locator('.menubar-btn', { hasText: top }).click();
  await page.getByRole('menuitem', { name: item }).click();
};

test('symmetry mirrors pencil strokes across the canvas center', async ({ page }) => {
  await newImage(page, 16, 16);
  await selectTool(page, 'p');
  await setFg(page, '#ff0000');
  // Symmetry is a tool option: the ⇆ button mirrors left ↔ right.
  await page.locator('.optionsbar').getByTitle('Mirror left ↔ right').click();
  await drawMouse(page, [[2, 3]]);
  expect(await layerPixel(page, 2, 3)).toEqual([255, 0, 0, 255]);
  expect(await layerPixel(page, 13, 3)).toEqual([255, 0, 0, 255]);
  expect(await layerPixel(page, 2, 12)).toEqual([0, 0, 0, 0]);
  // Both axes: four copies from one click.
  await page.keyboard.press('Alt+y');
  await expect(page.locator('.optionsbar').getByTitle('Mirror both ways (4 copies)')).toHaveAttribute('aria-checked', 'true');
  await drawMouse(page, [[4, 5]]);
  for (const [x, y] of [
    [4, 5],
    [11, 5],
    [4, 10],
    [11, 10],
  ])
    expect(await layerPixel(page, x, y)).toEqual([255, 0, 0, 255]);
  // Axis at x = 4.5 runs through the middle of pixel 4.
  await page.evaluate(() => (window as any).art.editor.setSymmetry({ mode: 'x', x: 4.5 }));
  await drawMouse(page, [[1, 0]]);
  expect(await layerPixel(page, 7, 0)).toEqual([255, 0, 0, 255]);
  // One stroke (with its mirror images) is one undo step.
  await page.keyboard.press('Control+z');
  expect(await layerPixel(page, 7, 0)).toEqual([0, 0, 0, 0]);
  expect(await layerPixel(page, 11, 10)).toEqual([255, 0, 0, 255]);
});

test('tile preview repeats the image and drawing wraps across edges', async ({ page }) => {
  await newImage(page, 8, 8);
  await selectTool(page, 'p');
  await setFg(page, '#00ff00');
  await menu(page, 'View', /^Tile preview(?!:)/);
  expect(await page.evaluate(() => (window as any).art.editor.settings.tileMode)).toBe('both');
  // Zoom out so the neighbouring copies are on screen, then draw in the tile to the right.
  await page.evaluate(() => {
    const e = (window as any).art.editor;
    e.view.zoomAt(e.view.width / 2, e.view.height / 2, e.view.zoom / 3);
    e.viewChanged();
  });
  await drawMouse(page, [[10, 2]]);
  expect(await layerPixel(page, 2, 2)).toEqual([0, 255, 0, 255]);
  // A stroke crossing the left edge continues on the right.
  await drawMouse(page, [
    [1, 5],
    [-2, 5],
  ]);
  for (const x of [0, 1, 6, 7]) expect(await layerPixel(page, x, 5)).toEqual([0, 255, 0, 255]);
  expect(await layerPixel(page, 5, 5)).toEqual([0, 0, 0, 0]);
  // The copies are drawn: the screen shows the green pixel again in the tile to the right.
  const at = await pixelPoint(page, 10, 2);
  const shot = await decodePNG(new Uint8Array(await page.screenshot({ clip: { x: at.x, y: at.y, width: 1, height: 1 } })));
  const [r, g, b] = shot.data;
  expect(g).toBeGreaterThan(150);
  expect(r + b).toBeLessThan(100);
});

test('replace color across layers from the Edit menu', async ({ page }) => {
  await newImage(page, 8, 8, 'white');
  await selectTool(page, 'p');
  await setFg(page, '#ff0000');
  await drawMouse(page, [[1, 1]]);
  await page.evaluate(() => (window as any).art.editor.setColor('bg', { r: 0, g: 0, b: 255, a: 255 }));
  await menu(page, 'Edit', 'Replace color…');
  const dialog = page.locator('dialog.dialog');
  await expect(dialog.getByLabel('Replace', { exact: true })).toHaveValue('#ff0000');
  await expect(dialog.getByLabel('With', { exact: true })).toHaveValue('#0000ff');
  await dialog.getByRole('button', { name: 'Replace', exact: true }).click();
  expect(await layerPixel(page, 1, 1)).toEqual([0, 0, 255, 255]);
  // White → transparent everywhere.
  await menu(page, 'Edit', 'Replace color…');
  await dialog.getByLabel('Replace', { exact: true }).fill('#ffffff');
  await dialog.getByRole('button', { name: 'With: transparent' }).click();
  await dialog.getByRole('button', { name: 'Replace', exact: true }).click();
  expect(await layerPixel(page, 5, 5)).toEqual([0, 0, 0, 0]);
  expect(await layerPixel(page, 1, 1)).toEqual([0, 0, 255, 255]);
  await page.keyboard.press('Control+z');
  expect(await layerPixel(page, 5, 5)).toEqual([255, 255, 255, 255]);
});

/** Sets up a 3-frame animation: a red pixel moving right, 100/150/200 ms. */
async function threeFrames(page: import('@playwright/test').Page) {
  await newImage(page, 6, 4);
  await page.evaluate(() => {
    const e = (window as any).art.editor;
    const d = e.doc;
    for (let i = 1; i < 3; i++)
      d.insertFrame(
        i,
        { duration: 100 },
        d.layers.map((l: any) => l.cels[0].clone()),
      );
    d.frames.forEach((f: any, i: number) => (f.duration = 100 + 50 * i));
    d.layers[0].cels.forEach((c: any, i: number) => {
      c.ensureData().fill(0);
      c.ensureData().set([255, 0, 0, 255], (1 * 6 + i) * 4);
      c.touch({ x: 0, y: 0, w: 6, h: 4 });
    });
    d.emit('frames');
  });
}

async function exportAnimation(page: import('@playwright/test').Page, format: 'GIF' | 'APNG') {
  await menu(page, 'File', 'Export animation (GIF/APNG)…');
  const dialog = page.locator('dialog.dialog');
  await expect(dialog.getByRole('heading', { name: 'Export animation' })).toBeVisible();
  await dialog.getByLabel('Format').selectOption({ label: format === 'GIF' ? 'GIF (plays everywhere)' : 'APNG (lossless, full alpha)' });
  await dialog.getByLabel('File name').fill('walk');
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Export', exact: true }).click();
  const file = await download;
  return { name: file.suggestedFilename(), bytes: readFileSync((await file.path())!) };
}

/** Decodes every frame with the browser's own ImageDecoder. */
async function browserFrames(page: import('@playwright/test').Page, bytes: Buffer, type: string) {
  return page.evaluate(
    async ([b64, mime]) => {
      const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dec = new (window as any).ImageDecoder({ data: bin, type: mime });
      await dec.tracks.ready;
      const n = dec.tracks.selectedTrack.frameCount;
      const out: { duration: number; red: number[] }[] = [];
      for (let i = 0; i < n; i++) {
        const { image } = await dec.decode({ frameIndex: i });
        const c = new OffscreenCanvas(image.displayWidth, image.displayHeight);
        const ctx = c.getContext('2d')!;
        ctx.drawImage(image, 0, 0);
        const px = ctx.getImageData(0, 0, c.width, c.height).data;
        const red: number[] = [];
        for (let p = 0; p < px.length; p += 4) if (px[p] > 200 && px[p + 3] > 200) red.push(p / 4);
        out.push({ duration: Math.round(image.duration / 1000), red });
        image.close();
      }
      return out;
    },
    [bytes.toString('base64'), type] as const,
  );
}

test('exports an animated GIF that browsers play frame by frame', async ({ page }) => {
  await threeFrames(page);
  const { name, bytes } = await exportAnimation(page, 'GIF');
  expect(name).toBe('walk.gif');
  const frames = await browserFrames(page, bytes, 'image/gif');
  expect(frames.map((f) => f.red)).toEqual([[6], [7], [8]]);
  expect(frames.map((f) => f.duration)).toEqual([100, 150, 200]);
});

test('exports a lossless APNG', async ({ page }) => {
  await threeFrames(page);
  const { name, bytes } = await exportAnimation(page, 'APNG');
  expect(name).toBe('walk.png');
  const first = await decodePNG(new Uint8Array(bytes));
  expect(Array.from(first.data.subarray(6 * 4, 6 * 4 + 4))).toEqual([255, 0, 0, 255]);
  const frames = await browserFrames(page, bytes, 'image/png');
  expect(frames.map((f) => f.red)).toEqual([[6], [7], [8]]);
  expect(frames.map((f) => f.duration)).toEqual([100, 150, 200]);
});

test('shading moves pixels one palette step per stroke', async ({ page }) => {
  await newImage(page, 8, 8);
  await page.evaluate(() => {
    const e = (window as any).art.editor;
    e.setPalette([
      { r: 10, g: 10, b: 10, a: 255 },
      { r: 80, g: 80, b: 80, a: 255 },
      { r: 160, g: 160, b: 160, a: 255 },
    ]);
    const d = e.doc.activeCel.ensureData();
    for (let i = 0; i < 64; i++) d.set([80, 80, 80, 255], i * 4);
    d.set([1, 2, 3, 255], (2 * 8 + 4) * 4); // not in the palette
    e.doc.activeCel.touch({ x: 0, y: 0, w: 8, h: 8 });
    e.doc.notifyPixels(e.doc.activeCel, { x: 0, y: 0, w: 8, h: 8 });
  });
  await page.keyboard.press('k');
  expect(await page.evaluate(() => (window as any).art.editor.tool.id)).toBe('shade');
  // Scrubbing back and forth over the same pixels shades them only once.
  await drawMouse(page, [
    [1, 2],
    [5, 2],
    [1, 2],
    [5, 2],
  ]);
  expect(await layerPixel(page, 1, 2)).toEqual([160, 160, 160, 255]);
  expect(await layerPixel(page, 3, 2)).toEqual([160, 160, 160, 255]);
  expect(await layerPixel(page, 4, 2)).toEqual([1, 2, 3, 255]);
  expect(await layerPixel(page, 1, 3)).toEqual([80, 80, 80, 255]);
  // Right button steps the other way; the end of the ramp stays put.
  await drawMouse(page, [[1, 2]], 'right');
  expect(await layerPixel(page, 1, 2)).toEqual([80, 80, 80, 255]);
  await drawMouse(page, [[1, 5]], 'right');
  await drawMouse(page, [[1, 5]], 'right');
  expect(await layerPixel(page, 1, 5)).toEqual([10, 10, 10, 255]);
});

test('gradient tool: smooth, dithered and limited to the selection', async ({ page }) => {
  await newImage(page, 16, 4);
  await page.evaluate(() => {
    const e = (window as any).art.editor;
    e.setColor('fg', { r: 0, g: 0, b: 0, a: 255 });
    e.setColor('bg', { r: 255, g: 255, b: 255, a: 255 });
  });
  await page.keyboard.press('Shift+g');
  expect(await page.evaluate(() => (window as any).art.editor.tool.id)).toBe('gradient');
  const drag = async () => {
    const z = await page.evaluate(() => (window as any).art.editor.view.zoom);
    const a = await pixelPoint(page, 0, 1);
    const b = await pixelPoint(page, 15, 1);
    await page.mouse.move(a.x - z / 2, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x + z / 2, b.y, { steps: 6 });
    await page.mouse.up();
  };
  await drag();
  const left = await layerPixel(page, 0, 0);
  const mid = await layerPixel(page, 8, 3);
  const right = await layerPixel(page, 15, 2);
  expect(left[0]).toBeLessThan(20);
  expect(mid[0]).toBeGreaterThan(110);
  expect(mid[0]).toBeLessThan(150);
  expect(right[0]).toBeGreaterThan(235);
  expect(await page.evaluate(() => (window as any).art.editor.history.undoCount)).toBe(1);
  await page.keyboard.press('Control+z');
  // Dithered: only the two end colors, roughly half of each in the middle.
  await page.locator('.optionsbar').getByRole('button', { name: 'Dither' }).click();
  await drag();
  const colors = await page.evaluate(() => {
    const c = (window as any).art.editor.doc.activeCel;
    const set = new Set<number>();
    let whites = 0;
    for (let y = 0; y < 4; y++)
      for (let x = 0; x < 16; x++) {
        const p = c.getPixel(x, y);
        set.add(p[0]);
        if (p[0] === 255) whites++;
      }
    return { values: [...set].sort((a, b) => a - b), whites };
  });
  expect(colors.values).toEqual([0, 255]);
  expect(colors.whites).toBeGreaterThan(24);
  expect(colors.whites).toBeLessThan(40);
  await page.keyboard.press('Control+z');
  // With a selection only the selected pixels change.
  await page.evaluate(() => {
    const e = (window as any).art.editor;
    const m = new Uint8Array(64);
    m.fill(255, 0, 16);
    e.applySelection(m, { x: 0, y: 0, w: 16, h: 1 }, 'replace', 'Select');
  });
  await drag();
  expect((await layerPixel(page, 15, 0))[3]).toBe(255);
  expect(await layerPixel(page, 15, 1)).toEqual([0, 0, 0, 0]);
});

test('palette lock, map to palette, select by color and feather', async ({ page }) => {
  await newImage(page, 8, 8, 'white');
  await page.evaluate(() => {
    const e = (window as any).art.editor;
    e.setPalette([
      { r: 0, g: 0, b: 0, a: 255 },
      { r: 255, g: 255, b: 255, a: 255 },
      { r: 200, g: 0, b: 0, a: 255 },
    ]);
  });
  await menu(page, 'Image', 'Lock colors to palette');
  // Picking an off-palette color snaps it.
  await setFg(page, '#e01010');
  expect(await page.evaluate(() => (window as any).art.editor.fg)).toEqual({ r: 200, g: 0, b: 0, a: 255 });
  await selectTool(page, 'b');
  await page.evaluate(() => (window as any).art.editor.setOption('brush', 'opacity', 0.5));
  await drawMouse(page, [[3, 3]]);
  const painted = await layerPixel(page, 3, 3);
  expect([
    [0, 0, 0],
    [255, 255, 255],
    [200, 0, 0],
  ]).toContainEqual(painted.slice(0, 3));
  await menu(page, 'Image', 'Lock colors to palette');
  // Off-palette pixels → palette.
  await page.evaluate(() => {
    const e = (window as any).art.editor;
    e.doc.activeCel.ensureData().set([30, 30, 30, 255], 0);
  });
  await menu(page, 'Image', 'Map colors to palette…');
  await page.locator('dialog.dialog').getByRole('button', { name: 'Map colors' }).click();
  expect(await layerPixel(page, 0, 0)).toEqual([0, 0, 0, 255]);
  // Select every white pixel, then feather.
  await menu(page, 'Select', 'Select by color…');
  const dialog = page.locator('dialog.dialog');
  await dialog.getByLabel('Color', { exact: true }).fill('#ffffff');
  await dialog.getByRole('button', { name: 'Select', exact: true }).click();
  const sel = await page.evaluate(() => (window as any).art.editor.doc.selection.valueAt(7, 7));
  expect(sel).toBe(255);
  expect(await page.evaluate(() => (window as any).art.editor.doc.selection.valueAt(0, 0))).toBe(0);
  await menu(page, 'Select', 'Feather selection…');
  await dialog.getByLabel('Radius (px)').fill('3');
  await dialog.getByRole('button', { name: 'Feather' }).click();
  const soft = await page.evaluate(() => (window as any).art.editor.doc.selection.valueAt(1, 0));
  expect(soft).toBeGreaterThan(0);
  expect(soft).toBeLessThan(255);
});

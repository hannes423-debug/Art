import { expect, test } from '@playwright/test';
import { drawMouse, historyCount, layerPixel, newImage, openApp, pixelPoint, selectTool, setFg } from './helpers';

test.beforeEach(async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openApp(page);
});

/** Encodes a solid-color horizontal strip of `n` frames (frame i has color i). */
async function stripPNG(n: number, size: number): Promise<Buffer> {
  const { encodePNG } = await import('../../src/io/png');
  const w = n * size;
  const data = new Uint8ClampedArray(w * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < w; x++) {
      const f = Math.floor(x / size);
      // Leave frame 2 empty to test "skip empty cells".
      if (f === 2) continue;
      data.set([f * 60, 255 - f * 60, 100, 255], (y * w + x) * 4);
    }
  }
  return Buffer.from(await encodePNG(w, size, data));
}

test('imports a sprite sheet as frames, skipping empty cells', async ({ page }) => {
  await newImage(page, 8, 8);
  const chooser = page.waitForEvent('filechooser');
  // Not awaited: the call resolves only after a file has been chosen.
  void page.evaluate(() => (window as any).art.importSpriteSheet());
  await (await chooser).setFiles({ name: 'walk.png', mimeType: 'image/png', buffer: await stripPNG(4, 8) });
  const dialog = page.locator('dialog.dialog');
  await expect(dialog.getByRole('heading', { name: /Import sprite sheet/ })).toBeVisible();
  await expect(dialog.getByLabel('Frame width')).toHaveValue('8');
  await expect(dialog.locator('.field-hint').first()).toContainText('4 cells');
  await dialog.getByRole('button', { name: 'Import frames' }).click();
  await page.waitForFunction(() => (window as any).art.editor.doc.frames.length === 3);
  const doc = await page.evaluate(() => {
    const d = (window as any).art.editor.doc;
    return { w: d.width, h: d.height, frames: d.frames.length, name: d.name, colors: d.layers[0].cels.map((c: any) => c.getPixel(0, 0)) };
  });
  expect(doc).toEqual({ w: 8, h: 8, frames: 3, name: 'walk', colors: [[0, 255, 100, 255], [60, 195, 100, 255], [180, 75, 100, 255]] });
  await expect(page.locator('.timeline')).toBeVisible();
});

test('canvas size with anchor, scale, crop, trim and rotate', async ({ page }) => {
  await newImage(page, 8, 8);
  await selectTool(page, 'p');
  await setFg(page, '#ff0000');
  await drawMouse(page, [[0, 0]]);
  // Grow the canvas to 12×10 anchored bottom-right: old pixel (0,0) moves to (4,2).
  await page.evaluate(() => (window as any).art.showCanvasSize());
  const dialog = page.locator('dialog.dialog');
  await dialog.getByLabel('Width', { exact: true }).fill('12');
  await dialog.getByLabel('Height', { exact: true }).fill('10');
  await dialog.locator('.anchor-cell').nth(8).click();
  await dialog.getByRole('button', { name: 'Resize canvas' }).click();
  let info = await page.evaluate(() => [(window as any).art.editor.doc.width, (window as any).art.editor.doc.height]);
  expect(info).toEqual([12, 10]);
  expect(await layerPixel(page, 4, 2)).toEqual([255, 0, 0, 255]);
  expect(await layerPixel(page, 0, 0)).toEqual([0, 0, 0, 0]);
  // Trim transparent borders back to the single pixel.
  await page.evaluate(() => (window as any).art.actions.run('image.trim'));
  info = await page.evaluate(() => [(window as any).art.editor.doc.width, (window as any).art.editor.doc.height]);
  expect(info).toEqual([1, 1]);
  // Scale 4× with nearest neighbour: all pixels stay pure red.
  await page.evaluate(() => (window as any).art.showScaleImage());
  await dialog.getByRole('button', { name: '4×' }).click();
  await dialog.getByRole('button', { name: 'Scale' }).click();
  info = await page.evaluate(() => [(window as any).art.editor.doc.width, (window as any).art.editor.doc.height]);
  expect(info).toEqual([4, 4]);
  expect(await layerPixel(page, 3, 3)).toEqual([255, 0, 0, 255]);
  // Undo everything step by step back to the original.
  for (let i = 0; i < 3; i++) await page.keyboard.press('Control+z');
  info = await page.evaluate(() => [(window as any).art.editor.doc.width, (window as any).art.editor.doc.height]);
  expect(info).toEqual([8, 8]);
  expect(await layerPixel(page, 0, 0)).toEqual([255, 0, 0, 255]);
  // Rotate a non-square image 90° clockwise.
  await page.evaluate(() => (window as any).art.actions.run('image.canvasSize'));
  await dialog.getByLabel('Width', { exact: true }).fill('8');
  await dialog.getByLabel('Height', { exact: true }).fill('4');
  await dialog.locator('.anchor-cell').nth(0).click();
  await dialog.getByRole('button', { name: 'Resize canvas' }).click();
  await page.evaluate(() => (window as any).art.actions.run('image.rotateCW'));
  info = await page.evaluate(() => [(window as any).art.editor.doc.width, (window as any).art.editor.doc.height]);
  expect(info).toEqual([4, 8]);
  // (0,0) in a w=8,h=4 image rotates clockwise to (h-1-0, 0) = (3, 0).
  expect(await layerPixel(page, 3, 0)).toEqual([255, 0, 0, 255]);
});

test('crop to a magic wand selection', async ({ page }) => {
  await newImage(page, 16, 16);
  await selectTool(page, 'u');
  await page.evaluate(() => (window as any).art.editor.setOption('shape', 'fill', true));
  await setFg(page, '#00ff00');
  await drawMouse(page, [
    [4, 5],
    [9, 11],
  ]);
  expect(await layerPixel(page, 4, 5)).toEqual([0, 255, 0, 255]);
  expect(await layerPixel(page, 9, 11)).toEqual([0, 255, 0, 255]);
  expect(await layerPixel(page, 10, 11)).toEqual([0, 0, 0, 0]);
  await selectTool(page, 'w');
  await drawMouse(page, [[6, 6]]);
  expect(await page.evaluate(() => (window as any).art.editor.doc.selection.bounds)).toEqual({ x: 4, y: 5, w: 6, h: 7 });
  await page.evaluate(() => (window as any).art.actions.run('image.cropSel'));
  expect(await page.evaluate(() => [(window as any).art.editor.doc.width, (window as any).art.editor.doc.height])).toEqual([6, 7]);
  expect(await layerPixel(page, 0, 0)).toEqual([0, 255, 0, 255]);
});

test('line, rectangle outline and ellipse rasterize exact pixels', async ({ page }) => {
  await newImage(page, 16, 16);
  await setFg(page, '#000000');
  await selectTool(page, 'l');
  await drawMouse(page, [
    [1, 1],
    [6, 3],
  ]);
  const count = await page.evaluate(() => {
    const c = (window as any).art.editor.doc.activeCel;
    let n = 0;
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if (c.getPixel(x, y)[3]) n++;
    return n;
  });
  expect(count).toBe(6); // Bresenham: max(dx, dy) + 1 pixels, no doubled corners
  expect((await layerPixel(page, 1, 1))[3]).toBe(255);
  expect((await layerPixel(page, 6, 3))[3]).toBe(255);
  await page.keyboard.press('Delete');
  await selectTool(page, 'u');
  await page.evaluate(() => (window as any).art.editor.setOption('shape', 'fill', false));
  await drawMouse(page, [
    [2, 2],
    [7, 6],
  ]);
  for (const [x, y] of [
    [2, 2],
    [7, 2],
    [2, 6],
    [7, 6],
    [4, 2],
    [2, 4],
  ]) expect((await layerPixel(page, x, y))[3]).toBe(255);
  expect((await layerPixel(page, 4, 4))[3]).toBe(0);
  await page.keyboard.press('Delete');
  await selectTool(page, 'o');
  await page.evaluate(() => (window as any).art.editor.setOption('shape', 'fill', true));
  await drawMouse(page, [
    [0, 0],
    [7, 7],
  ]);
  expect((await layerPixel(page, 0, 0))[3]).toBe(0);
  expect((await layerPixel(page, 3, 3))[3]).toBe(255);
  expect((await layerPixel(page, 0, 3))[3]).toBe(255);
});

test('pixel-perfect pencil removes L-shaped corner pixels', async ({ page }) => {
  await newImage(page, 8, 8);
  await selectTool(page, 'p');
  await page.evaluate(() => (window as any).art.editor.setOption('pencil', 'pixelPerfect', true));
  await drawMouse(page, [
    [2, 2],
    [3, 2],
    [3, 3],
  ]);
  expect((await layerPixel(page, 2, 2))[3]).toBe(255);
  expect((await layerPixel(page, 3, 2))[3]).toBe(0);
  expect((await layerPixel(page, 3, 3))[3]).toBe(255);
});

test('alpha lock recolors only existing pixels', async ({ page }) => {
  await newImage(page, 8, 8);
  await selectTool(page, 'p');
  await setFg(page, '#ff0000');
  await drawMouse(page, [[3, 3]]);
  await page.locator('.lp-alpha').click();
  await setFg(page, '#0000ff');
  await page.evaluate(() => (window as any).art.editor.setOption('pencil', 'size', 5));
  await drawMouse(page, [[3, 3]]);
  expect(await layerPixel(page, 3, 3)).toEqual([0, 0, 255, 255]);
  expect(await layerPixel(page, 2, 3)).toEqual([0, 0, 0, 0]);
});

test('multiply blend mode composites like the display', async ({ page }) => {
  await newImage(page, 4, 4, 'white');
  await page.evaluate(() => (window as any).art.actions.run('layer.new'));
  await page.evaluate(() => (window as any).art.editor.setColor('fg', { r: 128, g: 64, b: 255, a: 255 }));
  await selectTool(page, 'p');
  await drawMouse(page, [[1, 1]]);
  await page.locator('.lp-blend').selectOption('multiply');
  const px = await page.evaluate(() => {
    const out = (window as any).art.files.renderExport({ format: 'png', scale: 1, content: 'image', columns: 0, padding: 0, json: false, quality: 1 });
    return Array.from(out.data.slice((1 * 4 + 1) * 4, (1 * 4 + 1) * 4 + 4));
  });
  expect(px).toEqual([128, 64, 255, 255]);
  // Same on a non-white backdrop: multiply darkens.
  await page.locator('.layer-row').last().click();
  await setFg(page, '#808080');
  await drawMouse(page, [[1, 1]]);
  const px2 = await page.evaluate(() => {
    const out = (window as any).art.files.renderExport({ format: 'png', scale: 1, content: 'image', columns: 0, padding: 0, json: false, quality: 1 });
    return Array.from(out.data.slice((1 * 4 + 1) * 4, (1 * 4 + 1) * 4 + 4));
  });
  expect(px2).toEqual([64, 32, 128, 255]);
});

test('copy and paste a selection, then move it before applying', async ({ page }) => {
  await newImage(page, 16, 16);
  await selectTool(page, 'p');
  await setFg(page, '#ff00ff');
  await drawMouse(page, [[2, 2]]);
  await selectTool(page, 's');
  const z = await page.evaluate(() => (window as any).art.editor.view.zoom);
  const a = await pixelPoint(page, 1, 1);
  const b = await pixelPoint(page, 3, 3);
  await page.mouse.move(a.x - z / 2, a.y - z / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + z / 2, b.y + z / 2, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  await page.waitForFunction(() => !!(window as any).art.editor.floating);
  expect(await page.evaluate(() => (window as any).art.editor.tool.id)).toBe('move');
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  expect(await layerPixel(page, 2, 2)).toEqual([255, 0, 255, 255]);
  expect(await layerPixel(page, 7, 2)).toEqual([255, 0, 255, 255]);
  const before = await historyCount(page);
  await page.keyboard.press('Control+z');
  expect(await layerPixel(page, 7, 2)).toEqual([0, 0, 0, 0]);
  expect(await historyCount(page)).toBe(before - 1);
});

test('imports a palette file and paints with a palette color', async ({ page }) => {
  await newImage(page, 8, 8);
  await page.locator('.color-panel').getByRole('button', { name: 'Palette options' }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: 'Import palette…' }).click();
  await (await chooser).setFiles({ name: 'tiny.hex', mimeType: 'text/plain', buffer: Buffer.from('ff0000\n00ff00\n0000ff\n') });
  await expect(page.locator('.cp-swatches.palette .swatch')).toHaveCount(3);
  await page.locator('.cp-swatches.palette .swatch').nth(1).click();
  expect(await page.evaluate(() => (window as any).art.editor.fg)).toEqual({ r: 0, g: 255, b: 0, a: 255 });
});

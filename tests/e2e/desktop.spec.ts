import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { decodePNG } from '../../src/io/png';
import { drawMouse, historyCount, layerPixel, newImage, openApp, pixelOfLayer, pixelPoint, selectTool, setFg } from './helpers';

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

test('shows the welcome dialog and creates a transparent image', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'Welcome to Art' })).toBeVisible();
  await newImage(page, 32, 24);
  await expect(page.locator('.doc-dims')).toHaveText('32×24');
  expect(await layerPixel(page, 0, 0)).toEqual([0, 0, 0, 0]);
  // Integer zoom for crisp pixels after fitting.
  const zoom = await page.evaluate(() => (window as any).art.editor.view.zoom);
  expect(Number.isInteger(zoom)).toBe(true);
});

test('pencil draws exact pixels; undo and redo restore them', async ({ page }) => {
  await newImage(page, 32, 32);
  await selectTool(page, 'p');
  await setFg(page, '#ff0000');
  await drawMouse(page, [
    [2, 2],
    [10, 2],
  ]);
  for (let x = 2; x <= 10; x++) expect(await layerPixel(page, x, 2)).toEqual([255, 0, 0, 255]);
  expect(await layerPixel(page, 11, 2)).toEqual([0, 0, 0, 0]);
  expect(await layerPixel(page, 5, 3)).toEqual([0, 0, 0, 0]);
  expect(await historyCount(page)).toBe(1);

  await page.keyboard.press('Control+z');
  expect(await layerPixel(page, 5, 2)).toEqual([0, 0, 0, 0]);
  await page.keyboard.press('Control+Shift+z');
  expect(await layerPixel(page, 5, 2)).toEqual([255, 0, 0, 255]);
  // Toolbar buttons work too.
  await page.locator('.topbar').getByRole('button', { name: /^Undo/ }).click();
  expect(await layerPixel(page, 5, 2)).toEqual([0, 0, 0, 0]);
  await page.locator('.topbar').getByRole('button', { name: /^Redo/ }).click();
  expect(await layerPixel(page, 5, 2)).toEqual([255, 0, 0, 255]);
});

test('right mouse button paints with the background color', async ({ page }) => {
  await newImage(page, 16, 16);
  await selectTool(page, 'p');
  await page.evaluate(() => (window as any).art.editor.setColor('bg', { r: 0, g: 0, b: 255, a: 255 }));
  await drawMouse(page, [[4, 4]], 'right');
  expect(await layerPixel(page, 4, 4)).toEqual([0, 0, 255, 255]);
});

test('brush strokes keep uniform opacity where dabs overlap', async ({ page }) => {
  await newImage(page, 64, 64);
  await selectTool(page, 'b');
  await page.evaluate(() => {
    const e = (window as any).art.editor;
    e.setOption('brush', 'opacity', 0.5);
    e.setOption('brush', 'hardness', 1);
    e.setOption('brush', 'size', 9);
  });
  await setFg(page, '#000000');
  await drawMouse(page, [
    [10, 20],
    [30, 20],
    [50, 20],
  ]);
  const a = await layerPixel(page, 20, 20);
  const b = await layerPixel(page, 40, 20);
  expect(a[3]).toBe(128);
  expect(b[3]).toBe(128);
  expect(await historyCount(page)).toBe(1);
});

test('eraser erases to full transparency', async ({ page }) => {
  await newImage(page, 32, 32, 'white');
  expect(await layerPixel(page, 8, 8)).toEqual([255, 255, 255, 255]);
  await selectTool(page, 'e');
  await drawMouse(page, [
    [4, 8],
    [20, 8],
  ]);
  expect(await layerPixel(page, 8, 8)).toEqual([0, 0, 0, 0]);
  expect(await layerPixel(page, 8, 20)).toEqual([255, 255, 255, 255]);
});

test('Shift+click draws a straight line from the last point', async ({ page }) => {
  await newImage(page, 32, 32);
  await selectTool(page, 'p');
  await drawMouse(page, [[2, 2]]);
  const end = await pixelPoint(page, 2, 12);
  await page.keyboard.down('Shift');
  await page.mouse.click(end.x, end.y);
  await page.keyboard.up('Shift');
  for (let y = 2; y <= 12; y++) expect((await layerPixel(page, 2, y))[3]).toBe(255);
});

test('fill and color picker', async ({ page }) => {
  await newImage(page, 16, 16);
  await selectTool(page, 'p');
  await setFg(page, '#000000');
  // A vertical wall splitting the canvas.
  await drawMouse(page, [
    [8, 0],
    [8, 15],
  ]);
  await selectTool(page, 'g');
  await setFg(page, '#00ff00');
  await drawMouse(page, [[2, 5]]);
  expect(await layerPixel(page, 0, 0)).toEqual([0, 255, 0, 255]);
  expect(await layerPixel(page, 7, 15)).toEqual([0, 255, 0, 255]);
  expect(await layerPixel(page, 12, 5)).toEqual([0, 0, 0, 0]);
  // Picker sets the foreground color.
  await setFg(page, '#123456');
  await selectTool(page, 'i');
  await drawMouse(page, [[3, 3]]);
  const fg = await page.evaluate(() => (window as any).art.editor.fg);
  expect(fg).toEqual({ r: 0, g: 255, b: 0, a: 255 });
});

test('layers: add, paint, hide, reorder, merge', async ({ page }) => {
  await newImage(page, 16, 16);
  await selectTool(page, 'p');
  await setFg(page, '#ff0000');
  await drawMouse(page, [[1, 1]]);
  // New layer via the panel button.
  await page
    .locator('.layers-panel')
    .getByRole('button', { name: /New layer/ })
    .click();
  await expect(page.locator('.layer-row')).toHaveCount(2);
  await setFg(page, '#0000ff');
  await drawMouse(page, [[1, 1]]);
  expect(await pixelOfLayer(page, 0, 1, 1)).toEqual([255, 0, 0, 255]);
  expect(await pixelOfLayer(page, 1, 1, 1)).toEqual([0, 0, 255, 255]);
  const composite = () =>
    page.evaluate(() => {
      const e = (window as any).art.editor;
      const d = e.doc;
      // Exact composite of the top-left pixels.
      let out = [0, 0, 0, 0];
      for (const l of d.layers)
        if (l.visible) {
          const p = l.cels[0].getPixel(1, 1);
          if (p[3]) out = p;
        }
      return out;
    });
  expect(await composite()).toEqual([0, 0, 255, 255]);
  // Hide the top layer with its eye button.
  await page.locator('.layer-row').first().getByRole('button', { name: 'Hide layer' }).click();
  expect(await composite()).toEqual([255, 0, 0, 255]);
  // Painting on a hidden layer is refused with a message.
  await drawMouse(page, [[5, 5]]);
  await expect(page.locator('.toast').last()).toContainText('hidden');
  await page.locator('.layer-row').first().getByRole('button', { name: 'Show layer' }).click();
  // Rename by double-click.
  await page.locator('.layer-row').first().locator('.lp-name').dblclick();
  await page.locator('.lp-rename').fill('Ink');
  await page.locator('.lp-rename').press('Enter');
  await expect(page.locator('.layer-row').first().locator('.lp-name')).toHaveText('Ink');
  // Move the active (top) layer down: order flips.
  await page.locator('.layers-panel').getByRole('button', { name: 'Move layer down' }).click();
  await expect(page.locator('.layer-row').last().locator('.lp-name')).toHaveText('Ink');
  expect(await composite()).toEqual([255, 0, 0, 255]);
  // Undo the move, then merge down.
  await page.keyboard.press('Control+z');
  await expect(page.locator('.layer-row').first().locator('.lp-name')).toHaveText('Ink');
  await page.locator('.layers-panel').getByRole('button', { name: 'Merge down' }).click();
  await expect(page.locator('.layer-row')).toHaveCount(1);
  expect(await pixelOfLayer(page, 0, 1, 1)).toEqual([0, 0, 255, 255]);
});

test('layer opacity slider is a single undo step', async ({ page }) => {
  await newImage(page, 8, 8, 'white');
  const before = await historyCount(page);
  const slider = page.locator('.lp-opacity input[type=range]');
  await slider.fill('40');
  await slider.dispatchEvent('change');
  expect(await page.evaluate(() => (window as any).art.editor.doc.activeLayer.opacity)).toBeCloseTo(0.4);
  expect(await historyCount(page)).toBe(before + 1);
  await page.keyboard.press('Control+z');
  expect(await page.evaluate(() => (window as any).art.editor.doc.activeLayer.opacity)).toBe(1);
});

test('exports a transparent PNG with exact pixels', async ({ page }) => {
  await newImage(page, 20, 10);
  await selectTool(page, 'p');
  await page.evaluate(() => (window as any).art.editor.setColor('fg', { r: 200, g: 100, b: 50, a: 128 }));
  await drawMouse(page, [[3, 4]]);
  await page.keyboard.press('Control+e');
  const dialog = page.locator('dialog.dialog');
  await expect(dialog.getByRole('heading', { name: 'Export image' })).toBeVisible();
  await dialog.getByLabel('File name').fill('sprite');
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Export', exact: true }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('sprite.png');
  const img = await decodePNG(new Uint8Array(readFileSync((await file.path())!)));
  expect([img.width, img.height]).toEqual([20, 10]);
  const at = (x: number, y: number) => Array.from(img.data.subarray((y * 20 + x) * 4, (y * 20 + x) * 4 + 4));
  expect(at(3, 4)).toEqual([200, 100, 50, 128]);
  expect(at(0, 0)).toEqual([0, 0, 0, 0]);
});

test('exports scaled-up pixel art with nearest neighbour', async ({ page }) => {
  await newImage(page, 4, 4);
  await selectTool(page, 'p');
  await setFg(page, '#ffffff');
  await drawMouse(page, [[1, 1]]);
  await page.keyboard.press('Control+e');
  const dialog = page.locator('dialog.dialog');
  await dialog.getByLabel('Scale').selectOption('4');
  await expect(dialog.locator('.export-info')).toContainText('16 × 16');
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Export', exact: true }).click();
  const img = await decodePNG(new Uint8Array(readFileSync((await (await download).path())!)));
  expect([img.width, img.height]).toEqual([16, 16]);
  const at = (x: number, y: number) => Array.from(img.data.subarray((y * 16 + x) * 4, (y * 16 + x) * 4 + 4));
  for (const [x, y] of [
    [4, 4],
    [7, 7],
  ])
    expect(at(x, y)).toEqual([255, 255, 255, 255]);
  expect(at(8, 8)).toEqual([0, 0, 0, 0]);
  expect(at(3, 4)).toEqual([0, 0, 0, 0]);
});

test('autosaves to the browser and restores the session after reload', async ({ page }) => {
  await newImage(page, 24, 24);
  await selectTool(page, 'p');
  await setFg(page, '#ff00ff');
  await drawMouse(page, [
    [5, 5],
    [9, 5],
  ]);
  await page
    .locator('.layers-panel')
    .getByRole('button', { name: /New layer/ })
    .click();
  await page.keyboard.press('Control+s');
  await expect(page.locator('.toast').last()).toContainText('Saved');
  await expect(page.locator('.doc-dirty')).not.toHaveClass(/on/);
  await page.reload();
  await page.waitForFunction(() => (window as any).art?.editor.doc.width === 24);
  await expect(page.locator('dialog.dialog')).toBeHidden();
  await expect(page.locator('.layer-row')).toHaveCount(2);
  expect(await pixelOfLayer(page, 0, 7, 5)).toEqual([255, 0, 255, 255]);
  // The project appears in the library.
  await page.evaluate(() => (window as any).art.showProjects());
  await expect(page.locator('.project-item')).toHaveCount(1);
});

test('saves a project file and opens it again', async ({ page }) => {
  await newImage(page, 12, 12);
  await selectTool(page, 'p');
  await setFg(page, '#336699');
  await drawMouse(page, [[6, 6]]);
  await page.evaluate(() => {
    const e = (window as any).art.editor;
    e.doc.name = 'hero';
    e.doc.activeLayer.name = 'Body';
  });
  const download = page.waitForEvent('download');
  await page.keyboard.press('Control+Shift+s');
  const file = await download;
  expect(file.suggestedFilename()).toBe('hero.artproj');
  const path = (await file.path())!;
  const json = JSON.parse(readFileSync(path, 'utf8'));
  expect(json.format).toBe('art-project');
  expect(json.layers[0].name).toBe('Body');

  // Start over, then open the file through the Open command.
  await newImage(page, 5, 5);
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('Control+o');
  await (await chooser).setFiles({ name: 'hero.artproj', mimeType: 'application/json', buffer: readFileSync(path) });
  await page.waitForFunction(() => (window as any).art.editor.doc.width === 12);
  expect(await layerPixel(page, 6, 6)).toEqual([0x33, 0x66, 0x99, 255]);
  await expect(page.locator('.layer-row .lp-name').first()).toHaveText('Body');
});

test('opens a PNG and keeps its exact pixels', async ({ page }) => {
  await newImage(page, 8, 8);
  const { encodePNG } = await import('../../src/io/png');
  const data = new Uint8ClampedArray(3 * 2 * 4);
  data.set([10, 20, 30, 40, 255, 0, 0, 255, 0, 0, 0, 0, 1, 2, 3, 4, 50, 60, 70, 80, 90, 100, 110, 1]);
  const png = Buffer.from(await encodePNG(3, 2, data, { canonicalizeTransparent: false }));
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('Control+o');
  await (await chooser).setFiles({ name: 'tiny.png', mimeType: 'image/png', buffer: png });
  await page.waitForFunction(() => (window as any).art.editor.doc.width === 3);
  expect(await layerPixel(page, 0, 0)).toEqual([10, 20, 30, 40]);
  expect(await layerPixel(page, 2, 1)).toEqual([90, 100, 110, 1]);
  await expect(page.locator('.doc-name')).toHaveText('tiny');
});

test('rectangle selection limits painting and can be cleared', async ({ page }) => {
  await newImage(page, 16, 16, 'white');
  await selectTool(page, 's');
  const a = await pixelPoint(page, 2, 2);
  const b = await pixelPoint(page, 6, 6);
  // Drag from pixel corner (2,2) to (7,7) → selects 5×5.
  const z = await page.evaluate(() => (window as any).art.editor.view.zoom);
  await page.mouse.move(a.x - z / 2, a.y - z / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + z / 2, b.y + z / 2, { steps: 5 });
  await page.mouse.up();
  const bounds = await page.evaluate(() => (window as any).art.editor.doc.selection.bounds);
  expect(bounds).toEqual({ x: 2, y: 2, w: 5, h: 5 });
  await page.keyboard.press('Delete');
  expect(await layerPixel(page, 4, 4)).toEqual([0, 0, 0, 0]);
  expect(await layerPixel(page, 8, 8)).toEqual([255, 255, 255, 255]);
  // Painting outside the selection does nothing.
  await selectTool(page, 'p');
  await setFg(page, '#ff0000');
  await drawMouse(page, [[10, 10]]);
  expect(await layerPixel(page, 10, 10)).toEqual([255, 255, 255, 255]);
  await page.keyboard.press('Control+d');
  await drawMouse(page, [[10, 10]]);
  expect(await layerPixel(page, 10, 10)).toEqual([255, 0, 0, 255]);
});

test('grow, shrink and border the selection from the Select menu', async ({ page }) => {
  await newImage(page, 16, 16);
  await page.evaluate(() => {
    const e = (window as any).art.editor;
    const m = new Uint8Array(256);
    for (let y = 5; y < 9; y++) m.fill(255, y * 16 + 5, y * 16 + 9);
    e.doc.selection.combine(m, { x: 5, y: 5, w: 4, h: 4 }, 'replace');
    e.doc.notifySelection();
  });
  const bounds = () => page.evaluate(() => (window as any).art.editor.doc.selection.bounds);
  const menu = async (item: string) => {
    await page.locator('.menubar-btn', { hasText: 'Select' }).click();
    await page.getByRole('menuitem', { name: item }).click();
  };
  const dialog = page.locator('dialog.dialog');

  await menu('Grow selection…');
  await dialog.getByLabel('By (px)').fill('2');
  await dialog.getByLabel('Shape').selectOption('square');
  await dialog.getByRole('button', { name: 'Grow' }).click();
  expect(await bounds()).toEqual({ x: 3, y: 3, w: 8, h: 8 });

  // The dialog remembers the last amount and shape.
  await menu('Shrink selection…');
  await expect(dialog.getByLabel('By (px)')).toHaveValue('2');
  await dialog.getByRole('button', { name: 'Shrink' }).click();
  expect(await bounds()).toEqual({ x: 5, y: 5, w: 4, h: 4 });

  // Keyboard: grow / shrink by one pixel.
  await page.keyboard.press('Control+Alt+Equal');
  expect(await bounds()).toEqual({ x: 4, y: 4, w: 6, h: 6 });
  await page.keyboard.press('Control+Alt+Minus');
  expect(await bounds()).toEqual({ x: 5, y: 5, w: 4, h: 4 });

  // A 1px outside border filled with the foreground color outlines the area.
  await menu('Border selection…');
  await dialog.getByLabel('Width (px)').fill('1');
  await dialog.getByRole('button', { name: 'Select border' }).click();
  await setFg(page, '#000000');
  await page.keyboard.press('Alt+Backspace');
  expect(await layerPixel(page, 4, 4)).toEqual([0, 0, 0, 255]);
  expect(await layerPixel(page, 5, 5)).toEqual([0, 0, 0, 0]);
  expect(await layerPixel(page, 3, 3)).toEqual([0, 0, 0, 0]);

  // Each change is one undo step.
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  expect(await bounds()).toEqual({ x: 5, y: 5, w: 4, h: 4 });
});

test('move tool moves selected pixels as one undo step', async ({ page }) => {
  await newImage(page, 16, 16);
  await selectTool(page, 'p');
  await setFg(page, '#ff0000');
  await drawMouse(page, [[2, 2]]);
  await page.keyboard.press('Control+a');
  await selectTool(page, 'm');
  const before = await historyCount(page);
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  expect(await layerPixel(page, 2, 2)).toEqual([0, 0, 0, 0]);
  expect(await layerPixel(page, 5, 3)).toEqual([255, 0, 0, 255]);
  expect(await historyCount(page)).toBe(before + 1);
  await page.keyboard.press('Control+z');
  expect(await layerPixel(page, 2, 2)).toEqual([255, 0, 0, 255]);
  expect(await layerPixel(page, 5, 3)).toEqual([0, 0, 0, 0]);
});

test('zoom, fit, actual pixels and pan', async ({ page }) => {
  await newImage(page, 32, 32);
  const zoom = () => page.evaluate(() => (window as any).art.editor.view.zoom);
  const fitted = await zoom();
  await page.keyboard.press('Control+1');
  expect(await zoom()).toBe(1);
  await page.keyboard.press('Control+0');
  expect(await zoom()).toBe(fitted);
  const c = await pixelPoint(page, 16, 16);
  await page.mouse.move(c.x, c.y);
  await page.mouse.wheel(0, -100);
  expect(await zoom()).toBeGreaterThan(fitted);
  // Space + drag pans without drawing.
  const tx = await page.evaluate(() => (window as any).art.editor.view.tx);
  await page.keyboard.down('Space');
  await page.mouse.down();
  await page.mouse.move(c.x + 50, c.y + 30, { steps: 3 });
  await page.mouse.up();
  await page.keyboard.up('Space');
  expect(await page.evaluate(() => (window as any).art.editor.view.tx)).toBeCloseTo(tx + 50, 0);
  expect(await historyCount(page)).toBe(0);
});

test('canvas-only mode hides the interface and Tab restores it', async ({ page }) => {
  await newImage(page, 16, 16);
  await page.locator('canvas.view').focus();
  await page.keyboard.press('Tab');
  await expect(page.locator('.topbar')).toBeHidden();
  await expect(page.locator('.sidepanel')).toBeHidden();
  await expect(page.getByRole('button', { name: /Exit canvas only/ })).toBeVisible();
  await page.getByRole('button', { name: /Exit canvas only/ }).click();
  await expect(page.locator('.topbar')).toBeVisible();
});

test('sprite frames: add, duplicate, onion skin and sprite sheet export', async ({ page }) => {
  await newImage(page, 8, 8);
  await selectTool(page, 'p');
  await setFg(page, '#ffffff');
  await drawMouse(page, [[1, 1]]);
  await page.evaluate(() => (window as any).art.toggleTimeline(true));
  await expect(page.locator('.timeline')).toBeVisible();
  await page.locator('.timeline').getByRole('button', { name: 'Duplicate frame' }).click();
  await page
    .locator('.timeline')
    .getByRole('button', { name: /New empty frame/ })
    .click();
  await expect(page.locator('.tl-frame')).toHaveCount(3);
  expect(await page.evaluate(() => (window as any).art.editor.doc.activeFrame)).toBe(2);
  await drawMouse(page, [[6, 6]]);
  await page
    .locator('.timeline')
    .getByRole('button', { name: /Onion skin/ })
    .click();
  expect(await page.evaluate(() => (window as any).art.editor.settings.onionSkin)).toBe(true);
  await page.keyboard.press('Control+e');
  const dialog = page.locator('dialog.dialog');
  await dialog.getByLabel('Content').selectOption('sheet');
  await expect(dialog.locator('.export-info')).toContainText('24 × 8');
  const downloads: Promise<import('@playwright/test').Download>[] = [page.waitForEvent('download')];
  await dialog.getByRole('button', { name: 'Export', exact: true }).click();
  const png = await downloads[0];
  const img = await decodePNG(new Uint8Array(readFileSync((await png.path())!)));
  expect([img.width, img.height]).toEqual([24, 8]);
  const at = (x: number, y: number) => img.data[(y * 24 + x) * 4 + 3];
  expect(at(1, 1)).toBe(255); // frame 1
  expect(at(9, 1)).toBe(255); // frame 2 (duplicate)
  expect(at(17, 1)).toBe(0); // frame 3 (new, empty)
  expect(at(22, 6)).toBe(255); // drawn on frame 3
});

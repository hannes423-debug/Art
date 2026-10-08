import { expect, test } from '@playwright/test';
import { drawMouse, layerPixel, newImage, openApp, selectTool } from './helpers';

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

test('pick a console palette, paint with its colors, map the image keeping the original', async ({ page }) => {
  await newImage(page, 8, 8, 'white');
  const panel = page.locator('.color-panel');
  const nameBtn = panel.locator('.cp-pal-name');
  await expect(nameBtn).toContainText('DawnBringer 32');
  await expect(nameBtn).toContainText('32');
  // Quick switcher.
  await nameBtn.click();
  await page.getByRole('menuitem', { name: 'GBA-style 32 (32)' }).click();
  await expect(nameBtn).toContainText('GBA-style 32');
  await expect(panel.locator('.cp-swatches.palette .swatch')).toHaveCount(32);
  // White is not a GBA-style color: the image is left alone, with a hint.
  await expect(page.locator('.toast').last()).toContainText('not in “GBA-style 32”');
  expect(await layerPixel(page, 0, 0)).toEqual([255, 255, 255, 255]);
  // Paint with a palette color.
  const sw = panel.locator('.cp-swatches.palette .swatch').nth(14);
  const hex = await sw.getAttribute('data-hex');
  await sw.click();
  await selectTool(page, 'p');
  await drawMouse(page, [[3, 3]]);
  const px = await layerPixel(page, 3, 3);
  expect(
    '#' +
      px
        .slice(0, 3)
        .map((v) => v.toString(16).padStart(2, '0'))
        .join('') +
      'ff',
  ).toBe(hex);
  // Map the image from the palette browser; the original stays (hidden) underneath.
  await panel.getByTitle('Palette options').click();
  await page.getByRole('menuitem', { name: 'Palettes… (browse, create, edit)' }).click();
  const dlg = page.locator('dialog.dialog');
  await expect(dlg.locator('.pal-row.active')).toContainText('GBA-style 32');
  await dlg.locator('.pal-row', { hasText: 'Game Boy Pocket' }).locator('.pal-pick').click();
  await dlg.locator('.pal-row', { hasText: 'GBA-style 32' }).locator('.pal-pick').click();
  await expect(dlg.locator('.pal-notice')).toContainText('not in “GBA-style 32”');
  await dlg.getByRole('button', { name: 'Map colors…' }).click();
  await expect(dlg.getByLabel(/Keep the original/)).toBeChecked();
  await dlg.getByRole('button', { name: 'Map colors' }).click();
  const layers = await page.evaluate(() => (window as any).art.editor.doc.layers.map((l: any) => [l.name, l.visible]));
  expect(layers).toEqual([
    ['Background', false],
    ['Background (GBA-style 32)', true],
  ]);
  expect(await page.evaluate(() => (window as any).art.editor.doc.layers[0].cels[0].getPixel(0, 0))).toEqual([255, 255, 255, 255]);
  const mapped = await layerPixel(page, 0, 0);
  expect(mapped).toEqual([247, 247, 247, 255]);
});

test('create, edit, reorder and keep a custom palette; import a .gpl', async ({ page }) => {
  await newImage(page, 8, 8);
  await page.evaluate(() => (window as any).art.editor.setColor('fg', { r: 10, g: 200, b: 30, a: 255 }));
  await page.evaluate(() => (window as any).art.showPalettes());
  const dlg = page.locator('dialog.dialog').last();
  await dlg.getByRole('button', { name: 'New…' }).click();
  const prompt = page.locator('dialog.dialog').last();
  await prompt.locator('input').fill('Forest');
  await prompt.getByRole('button', { name: 'Create' }).click();
  // Start empty (just the foreground color), not from the current colors.
  await page.locator('dialog.dialog').last().getByRole('button', { name: 'Cancel' }).click();
  const ed = page.locator('dialog.dialog').last();
  await expect(ed.getByRole('heading', { name: 'Edit palette' })).toBeVisible();
  await expect(ed.locator('.pal-edit-grid .swatch')).toHaveCount(1);
  // Add a second color and edit it.
  await page.evaluate(() => (window as any).art.editor.setColor('fg', { r: 0, g: 0, b: 0, a: 255 }));
  await ed.getByRole('button', { name: '+ Add FG' }).click();
  await ed.getByLabel('Selected color (hex)').fill('#203040');
  // Move it first, add a third, remove it.
  await ed.getByRole('button', { name: '◀ Move' }).click();
  await ed.getByRole('button', { name: '+ Add FG' }).click();
  await ed.getByRole('button', { name: 'Remove' }).click();
  await ed.getByRole('button', { name: 'Done' }).click();
  const state = await page.evaluate(() => {
    const e = (window as any).art.editor;
    return { name: e.paletteName, ref: e.paletteRef?.kind, colors: e.palette.map((c: any) => [c.r, c.g, c.b]) };
  });
  expect(state).toEqual({
    name: 'Forest',
    ref: 'custom',
    colors: [
      [32, 48, 64],
      [10, 200, 30],
    ],
  });
  await expect(page.locator('.color-panel .cp-pal-name')).toContainText('Forest');
  // Import a GIMP palette: it is saved to My palettes under its own name.
  await page.locator('dialog.dialog').last().getByRole('button', { name: 'Done' }).click();
  await page.evaluate(() => (window as any).art.showPalettes());
  const chooser = page.waitForEvent('filechooser');
  await page.locator('dialog.dialog').last().getByRole('button', { name: 'Import…' }).click();
  await (
    await chooser
  ).setFiles({
    name: 'sunset.gpl',
    mimeType: 'text/plain',
    buffer: Buffer.from('GIMP Palette\nName: Sunset Sky\n#\n255 128   0\tOrange\n 40  20  80\tNight\n'),
  });
  await expect(page.locator('dialog.dialog').last().locator('.pal-row.active')).toContainText('Sunset Sky');
  await expect(page.locator('dialog.dialog').last().locator('.pal-row.active')).toContainText('2 colors');
  // Saved palettes survive a reload.
  await page.evaluate(() => (window as any).art.editor.persistNow());
  await page.reload();
  await page.waitForFunction(() => !!(window as any).art);
  const after = await page.evaluate(() => {
    const e = (window as any).art.editor;
    return { name: e.paletteName, saved: e.customPalettes.map((p: any) => p.name) };
  });
  expect(after).toEqual({ name: 'Sunset Sky', saved: ['Forest', 'Sunset Sky'] });
});

test('editing a built-in palette makes an edited copy and leaves the built-in alone', async ({ page }) => {
  await newImage(page, 4, 4);
  await page.evaluate(() => (window as any).art.editor.selectPalette({ kind: 'builtin', id: 'pico8' }));
  const sw = page.locator('.color-panel .cp-swatches.palette .swatch').first();
  await sw.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Remove from palette' }).click();
  await expect(page.locator('.color-panel .cp-pal-name')).toContainText('PICO-8 (edited)');
  await expect(page.locator('.color-panel .cp-pal-name')).toContainText('15');
  // The built-in itself is unchanged.
  await page.evaluate(() => (window as any).art.editor.selectPalette({ kind: 'builtin', id: 'pico8' }));
  await expect(page.locator('.color-panel .cp-swatches.palette .swatch')).toHaveCount(16);
});

test('drag colors to reorder them in the palette editor', async ({ page }) => {
  await newImage(page, 8, 8);
  await page.evaluate(() => {
    const e = (window as any).art.editor;
    e.createCustomPalette('Three', [
      { r: 255, g: 0, b: 0, a: 255 },
      { r: 0, g: 255, b: 0, a: 255 },
      { r: 0, g: 0, b: 255, a: 255 },
    ]);
    (window as any).art.showPalettes();
  });
  await page.locator('dialog.dialog').last().locator('.pal-row', { hasText: 'Three' }).getByRole('button', { name: 'Edit' }).click();
  const ed = page.locator('dialog.dialog').last();
  const sw = ed.locator('.pal-edit-grid .swatch');
  const a = (await sw.nth(0).boundingBox())!;
  const c = (await sw.nth(2).boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width, a.y + a.height / 2, { steps: 3 });
  await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2, { steps: 6 });
  await page.mouse.up();
  const order = await page.evaluate(() => (window as any).art.editor.palette.map((c: any) => [c.r, c.g, c.b]));
  expect(order).toEqual([
    [0, 255, 0],
    [0, 0, 255],
    [255, 0, 0],
  ]);
  // The dragged color stays selected; the buttons still work.
  await expect(sw.nth(2)).toHaveAttribute('aria-selected', 'true');
  await ed.getByRole('button', { name: '◀ Move' }).click();
  expect(await page.evaluate(() => (window as any).art.editor.palette[1].r)).toBe(255);
});

test('export all my palettes and import them on another device; lock is remembered per palette', async ({ page }) => {
  await newImage(page, 8, 8);
  await page.evaluate(() => {
    const e = (window as any).art.editor;
    e.createCustomPalette('Skin', [
      { r: 255, g: 204, b: 153, a: 255 },
      { r: 170, g: 102, b: 68, a: 128 },
    ]);
    e.createCustomPalette('Night', [{ r: 10, g: 10, b: 40, a: 255 }]);
    (window as any).art.showPalettes();
  });
  const download = page.waitForEvent('download');
  await page.locator('dialog.dialog').last().getByRole('button', { name: 'Export all…' }).click();
  const file = await download;
  const path = (await file.path())!;
  // “Another device”: nothing saved.
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForFunction(() => !!(window as any).art);
  expect(await page.evaluate(() => (window as any).art.editor.customPalettes.length)).toBe(0);
  await page.evaluate(() => (window as any).art.showPalettes());
  for (let round = 0; round < 2; round++) {
    const chooser = page.waitForEvent('filechooser');
    await page.locator('dialog.dialog').last().getByRole('button', { name: 'Import…' }).click();
    await (await chooser).setFiles(path);
    await expect(page.locator('.toast').last()).toContainText(round ? '0 palettes (2 already saved)' : 'Imported 2 palettes');
  }
  const saved = await page.evaluate(() =>
    (window as any).art.editor.customPalettes.map((p: any) => [p.name, p.colors.length, p.colors[p.colors.length - 1].a]),
  );
  expect(saved).toEqual([
    ['Skin', 2, 128],
    ['Night', 1, 255],
  ]);
  await expect(page.locator('dialog.dialog').last().locator('.pal-row', { hasText: 'Night' })).toBeVisible();

  // Lock on for PICO-8, off for Game Boy: switching palettes restores each one's choice.
  const lockAfter = (id: string) =>
    page.evaluate((id) => {
      const e = (window as any).art.editor;
      e.selectPalette({ kind: 'builtin', id });
      return e.settings.paletteLock;
    }, id);
  await lockAfter('pico8');
  await page.evaluate(() => (window as any).art.editor.setPaletteLock(true));
  await lockAfter('gameboy');
  await page.evaluate(() => (window as any).art.editor.setPaletteLock(false));
  expect(await lockAfter('pico8')).toBe(true);
  expect(await lockAfter('gameboy')).toBe(false);
  await page.evaluate(() => (window as any).art.editor.persistNow());
  await page.reload();
  await page.waitForFunction(() => !!(window as any).art);
  expect(await lockAfter('pico8')).toBe(true);
});

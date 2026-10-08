import { type CDPSession, type Page, expect, test } from '@playwright/test';
import { historyCount, layerPixel, newImage, openApp, pixelPoint, setFg } from './helpers';

type Pt = { x: number; y: number };

async function cdp(page: Page): Promise<CDPSession> {
  return page.context().newCDPSession(page);
}

/** Real multi-touch through the DevTools protocol (produces touch pointer events). */
async function touch(client: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd', points: Pt[]): Promise<void> {
  await client.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: points.map((p, i) => ({ x: p.x, y: p.y, id: i + 1, radiusX: 4, radiusY: 4, force: 1 })),
  });
}

async function fingerStroke(page: Page, client: CDPSession, pixels: [number, number][]): Promise<void> {
  const pts = await Promise.all(pixels.map(([x, y]) => pixelPoint(page, x, y)));
  await touch(client, 'touchStart', [pts[0]]);
  for (const p of pts.slice(1)) {
    await page.waitForTimeout(20);
    await touch(client, 'touchMove', [p]);
  }
  await page.waitForTimeout(20);
  await touch(client, 'touchEnd', []);
}

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

test('uses the mobile layout: bottom tool bar, no side panel or menu bar', async ({ page }) => {
  await newImage(page, 32, 32);
  await expect(page.locator('.bottombar .toolbar')).toBeVisible();
  await expect(page.locator('.sidepanel')).toBeHidden();
  await expect(page.locator('.menubar')).toBeHidden();
  await expect(page.locator('.statusbar')).toBeHidden();
  // The canvas gets most of the screen.
  const stage = await page.locator('.stage').boundingBox();
  const vp = page.viewportSize()!;
  expect(stage!.height).toBeGreaterThan(vp.height * 0.6);
  // Touch targets are at least 44px.
  const btn = await page.locator('.bottombar .tool-btn').first().boundingBox();
  expect(btn!.height).toBeGreaterThanOrEqual(44);
});

test('one finger draws with the pencil and does not scroll the page', async ({ page }) => {
  await newImage(page, 32, 32);
  await page.evaluate(() => (window as any).art.editor.setTool('pencil'));
  await setFg(page, '#ff0000');
  const client = await cdp(page);
  await fingerStroke(page, client, [
    [4, 10],
    [8, 10],
    [12, 10],
  ]);
  for (const x of [4, 6, 8, 10, 12]) expect(await layerPixel(page, x, 10)).toEqual([255, 0, 0, 255]);
  expect(await page.evaluate(() => [window.scrollX, window.scrollY, document.scrollingElement?.scrollTop ?? 0])).toEqual([0, 0, 0]);
  expect(await historyCount(page)).toBe(1);
});

test('two-finger pinch zooms and pans without drawing', async ({ page }) => {
  await newImage(page, 32, 32);
  await page.evaluate(() => (window as any).art.editor.setTool('pencil'));
  const client = await cdp(page);
  const zoom0 = await page.evaluate(() => (window as any).art.editor.view.zoom);
  const c = await pixelPoint(page, 16, 16);
  await touch(client, 'touchStart', [
    { x: c.x - 30, y: c.y },
    { x: c.x + 30, y: c.y },
  ]);
  for (let i = 1; i <= 6; i++) {
    await page.waitForTimeout(16);
    await touch(client, 'touchMove', [
      { x: c.x - 30 - i * 12, y: c.y + i * 4 },
      { x: c.x + 30 + i * 12, y: c.y + i * 4 },
    ]);
  }
  await touch(client, 'touchEnd', []);
  const zoom1 = await page.evaluate(() => (window as any).art.editor.view.zoom);
  expect(zoom1).toBeGreaterThan(zoom0 * 1.8);
  expect(await historyCount(page)).toBe(0);
  const blank = await page.evaluate(() => (window as any).art.editor.doc.activeCel.isBlank());
  expect(blank).toBe(true);
});

test('two-finger tap undoes and three-finger tap redoes', async ({ page }) => {
  await newImage(page, 32, 32);
  await page.evaluate(() => (window as any).art.editor.setTool('pencil'));
  const client = await cdp(page);
  await fingerStroke(page, client, [
    [5, 5],
    [9, 5],
  ]);
  expect(await historyCount(page)).toBe(1);
  const c = await pixelPoint(page, 16, 16);
  await touch(client, 'touchStart', [
    { x: c.x - 40, y: c.y },
    { x: c.x + 40, y: c.y },
  ]);
  await page.waitForTimeout(60);
  await touch(client, 'touchEnd', []);
  expect(await layerPixel(page, 7, 5)).toEqual([0, 0, 0, 0]);
  await touch(client, 'touchStart', [
    { x: c.x - 40, y: c.y },
    { x: c.x, y: c.y + 30 },
    { x: c.x + 40, y: c.y },
  ]);
  await page.waitForTimeout(60);
  await touch(client, 'touchEnd', []);
  expect((await layerPixel(page, 7, 5))[3]).toBe(255);
});

test('canvas-only mode: full-screen canvas, drawing works, easy to exit', async ({ page }) => {
  await newImage(page, 32, 32);
  await page
    .locator('.topbar')
    .getByRole('button', { name: /Canvas only/ })
    .click();
  await expect(page.locator('.topbar')).toBeHidden();
  await expect(page.locator('.bottombar')).toBeHidden();
  const stage = await page.locator('.stage').boundingBox();
  const vp = page.viewportSize()!;
  expect(Math.round(stage!.height)).toBe(vp.height);
  expect(Math.round(stage!.width)).toBe(vp.width);
  const client = await cdp(page);
  await fingerStroke(page, client, [
    [3, 3],
    [6, 3],
  ]);
  expect((await layerPixel(page, 4, 3))[3]).toBe(255);
  // Floating undo works in focus mode.
  await page.locator('.focus-controls').getByRole('button', { name: /^Undo/ }).click();
  expect((await layerPixel(page, 4, 3))[3]).toBe(0);
  await page.getByRole('button', { name: /Exit canvas only/ }).click();
  await expect(page.locator('.topbar')).toBeVisible();
  await expect(page.locator('.bottombar')).toBeVisible();
});

test('the back gesture leaves canvas-only mode', async ({ page }) => {
  await newImage(page, 16, 16);
  await page
    .locator('.topbar')
    .getByRole('button', { name: /Canvas only/ })
    .click();
  await expect(page.locator('.topbar')).toBeHidden();
  await page.goBack();
  await expect(page.locator('.topbar')).toBeVisible();
});

test('layers drawer and color sheet open as overlays and close', async ({ page }) => {
  await newImage(page, 16, 16);
  await page.locator('.topbar').getByRole('button', { name: 'Layers' }).click();
  const drawer = page.locator('.drawer.right');
  await expect(drawer).toBeVisible();
  await drawer.getByRole('button', { name: /New layer/ }).click();
  await expect(drawer.locator('.layer-row')).toHaveCount(2);
  await page.locator('.scrim').click({ position: { x: 20, y: 300 } });
  await expect(drawer).toBeHidden();

  await page.locator('.bottombar').getByRole('button', { name: 'Colors' }).click();
  const sheet = page.locator('.drawer.bottom');
  await expect(sheet).toBeVisible();
  await sheet.locator('.cp-hex').fill('#00ff00');
  await sheet.locator('.cp-hex').press('Enter');
  expect(await page.evaluate(() => (window as any).art.editor.fg)).toEqual({ r: 0, g: 255, b: 0, a: 255 });
  await sheet.getByRole('button', { name: 'Close' }).click();
  await expect(sheet).toBeHidden();
});

test('menu drawer exposes all commands', async ({ page }) => {
  await newImage(page, 16, 16);
  await page.locator('.topbar').getByRole('button', { name: 'Menu' }).click();
  const menu = page.locator('.drawer.left');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('button', { name: 'Export image…' })).toBeVisible();
  await menu.getByText('Image', { exact: true }).click();
  await menu.getByRole('button', { name: 'Flip image horizontally' }).click();
  await expect(menu).toBeHidden();
  expect(await historyCount(page)).toBe(1);
});

test('tapping the active tool opens its options sheet', async ({ page }) => {
  await newImage(page, 16, 16);
  const brush = page.locator('.bottombar').getByRole('button', { name: 'Brush' });
  await brush.click();
  await brush.click();
  await expect(page.getByRole('heading', { name: 'Brush options' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pressure → size' })).toBeVisible();
});

test('touch and hold picks a color with a loupe instead of painting', async ({ page }) => {
  await newImage(page, 16, 16, 'white');
  await page.evaluate(() => {
    const e = (window as any).art.editor;
    const d = e.doc.activeCel.ensureData();
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) d.set([10, 120, 220, 255], (y * 16 + x) * 4);
    e.doc.activeCel.touch({ x: 0, y: 0, w: 16, h: 16 });
    e.doc.notifyPixels(e.doc.activeCel, { x: 0, y: 0, w: 16, h: 16 });
    e.setTool('pencil');
  });
  await setFg(page, '#000000');
  const client = await cdp(page);
  const p = await pixelPoint(page, 3, 3);
  await touch(client, 'touchStart', [p]);
  await page.waitForTimeout(700);
  // While holding, the loupe is drawn and the start dab has been undone.
  expect(await layerPixel(page, 3, 3)).toEqual([10, 120, 220, 255]);
  const q = await pixelPoint(page, 12, 12);
  await touch(client, 'touchMove', [q]);
  await page.waitForTimeout(30);
  await touch(client, 'touchMove', [p]);
  await page.waitForTimeout(30);
  await touch(client, 'touchEnd', []);
  expect(await page.evaluate(() => (window as any).art.editor.fg)).toEqual({ r: 10, g: 120, b: 220, a: 255 });
  expect(await page.evaluate(() => (window as any).art.editor.tool.id)).toBe('pencil');
  expect(await historyCount(page)).toBe(0);
  expect(await layerPixel(page, 12, 12)).toEqual([255, 255, 255, 255]);
  // A normal tap still paints.
  await touch(client, 'touchStart', [q]);
  await page.waitForTimeout(40);
  await touch(client, 'touchEnd', []);
  expect(await layerPixel(page, 12, 12)).toEqual([10, 120, 220, 255]);
});

test('palettes work by touch and their dialogs fit the phone screen', async ({ page }) => {
  await newImage(page, 16, 16);
  await page.locator('.bottombar').getByRole('button', { name: 'Colors' }).click();
  const sheet = page.locator('.drawer.bottom');
  const nameBtn = sheet.locator('.cp-pal-name');
  await nameBtn.tap();
  const menu = page.locator('.popup-menu');
  await expect(menu).toBeVisible();
  const vp = page.viewportSize()!;
  const mb = (await menu.boundingBox())!;
  expect(mb.x).toBeGreaterThanOrEqual(0);
  expect(mb.x + mb.width).toBeLessThanOrEqual(vp.width + 1);
  await page.getByRole('menuitem', { name: 'Manage palettes…' }).tap();
  const dlg = page.locator('dialog.dialog');
  await expect(dlg).toBeVisible();
  const db = (await dlg.boundingBox())!;
  expect(db.x).toBeGreaterThanOrEqual(0);
  expect(db.x + db.width).toBeLessThanOrEqual(vp.width + 1);
  expect(db.y + db.height).toBeLessThanOrEqual(vp.height + 1);
  // Nothing scrolls sideways inside the dialog.
  expect(await dlg.locator('.dialog-body').evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  // Tap a palette far down the list (the list scrolls inside the dialog).
  const nes = dlg.locator('.pal-row', { hasText: 'NES' }).first().locator('.pal-pick');
  await nes.scrollIntoViewIfNeeded();
  await nes.tap();
  await expect(dlg.locator('.pal-row.active')).toContainText('NES');
  await dlg.getByRole('button', { name: 'Done' }).tap();
  await expect(nameBtn).toContainText('NES');
  // Tapping a swatch sets the color.
  const sw = sheet.locator('.cp-swatches.palette .swatch').nth(7);
  const hex = await sw.getAttribute('data-hex');
  await sw.tap();
  const fg = await page.evaluate(() => (window as any).art.editor.fg);
  expect('#' + [fg.r, fg.g, fg.b].map((v: number) => v.toString(16).padStart(2, '0')).join('') + 'ff').toBe(hex);
});

test('animated project thumbnails play on a phone and fit the screen', async ({ page }) => {
  await newImage(page, 6, 6);
  await page.evaluate(async () => {
    const e = (window as any).art.editor;
    const d = e.doc;
    d.insertFrame(
      1,
      { duration: 120 },
      d.layers.map((l: any) => l.cels[0].clone()),
    );
    d.layers[0].cels.forEach((c: any, i: number) => {
      c.ensureData().fill(0);
      c.ensureData().set([0, 200, 0, 255], (2 * 6 + i * 3) * 4);
      c.touch({ x: 0, y: 0, w: 6, h: 6 });
    });
    d.emit('frames');
    d.setActiveFrame(0);
    e.markChanged();
    await (window as any).art.save();
  });
  await page.waitForFunction(() => !!(window as any).art.editor.info.projectId);
  await page.evaluate(() => (window as any).art.showProjects());
  const c = page.locator('.project-thumb canvas');
  await expect(c).toHaveCount(1);
  const xs = new Set<number>();
  for (let i = 0; i < 20; i++) {
    xs.add(
      await c.evaluate((el: HTMLCanvasElement) => {
        const d = el.getContext('2d')!.getImageData(0, 0, el.width, el.height).data;
        for (let p = 0; p < d.length; p += 4) if (d[p + 1] === 200 && d[p + 3] === 255) return (p / 4) % el.width;
        return -1;
      }),
    );
    await page.waitForTimeout(25);
  }
  expect([...xs].filter((x) => x >= 0).sort()).toEqual([0, 3]);
  const box = (await page.locator('dialog.dialog').boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
});

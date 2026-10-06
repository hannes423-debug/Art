import { type Page, expect } from '@playwright/test';

/** Pixel as [r, g, b, a]. */
export type Px = [number, number, number, number];

/**
 * Opens the app with File System Access disabled, so saving/exporting uses
 * plain downloads that tests can capture.
 */
export async function openApp(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    delete w.showOpenFilePicker;
    delete w.showSaveFilePicker;
    w.showOpenFilePicker = undefined;
    w.showSaveFilePicker = undefined;
  });
  await page.goto('./');
  await page.waitForFunction(() => !!(window as unknown as { art?: unknown }).art);
}

/** Creates a new image using the welcome / New dialog. */
export async function newImage(page: Page, w: number, h: number, background = 'transparent'): Promise<void> {
  const dialog = page.locator('dialog.dialog');
  if (!(await dialog.isVisible())) {
    await page.evaluate(() => (window as any).art.showNewDialog());
  }
  await dialog.getByLabel('Width', { exact: true }).fill(String(w));
  await dialog.getByLabel('Height', { exact: true }).fill(String(h));
  await dialog.getByLabel('Background').selectOption(background);
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(dialog).toBeHidden();
  await page.waitForFunction(
    ([ww, hh]) => {
      const d = (window as any).art.editor.doc;
      return d.width === ww && d.height === hh;
    },
    [w, h],
  );
  // Let the stage settle and the view fit.
  await page.waitForTimeout(100);
}

/** Screen (page) coordinates of the center of document pixel (x, y). */
export async function pixelPoint(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ([px, py]) => {
      const art = (window as any).art;
      const p = art.editor.view.docToScreen(px + 0.5, py + 0.5);
      const r = (document.querySelector('canvas.view') as HTMLCanvasElement).getBoundingClientRect();
      return { x: r.left + p.x, y: r.top + p.y };
    },
    [x, y],
  );
}

/** Drags the mouse through document pixel coordinates. */
export async function drawMouse(page: Page, points: [number, number][], button: 'left' | 'right' = 'left'): Promise<void> {
  const first = await pixelPoint(page, ...points[0]);
  await page.mouse.move(first.x, first.y);
  await page.mouse.down({ button });
  for (const p of points.slice(1)) {
    const s = await pixelPoint(page, ...p);
    await page.mouse.move(s.x, s.y, { steps: 4 });
  }
  await page.mouse.up({ button });
}

/** Pixel of the active layer's current cel. */
export async function layerPixel(page: Page, x: number, y: number): Promise<Px> {
  return page.evaluate(([px, py]) => (window as any).art.editor.doc.activeCel.getPixel(px, py), [x, y]);
}

/** Pixel of a specific layer (bottom = 0). */
export async function pixelOfLayer(page: Page, layer: number, x: number, y: number): Promise<Px> {
  return page.evaluate(
    ([l, px, py]) => {
      const d = (window as any).art.editor.doc;
      return d.layers[l].cels[d.activeFrame].getPixel(px, py);
    },
    [layer, x, y],
  );
}

export async function historyCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as any).art.editor.history.undoCount);
}

export async function setFg(page: Page, hex: string): Promise<void> {
  await page.evaluate((h) => {
    const art = (window as any).art;
    const n = parseInt(h.slice(1), 16);
    art.editor.setColor('fg', { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 255 });
  }, hex);
}

export async function selectTool(page: Page, key: string): Promise<void> {
  await page.locator('canvas.view').focus();
  await page.keyboard.press(key);
}

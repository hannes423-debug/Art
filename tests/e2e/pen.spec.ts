import { expect, test } from '@playwright/test';
import { newImage, openApp, pixelPoint } from './helpers';

/**
 * Stylus input via the DevTools protocol: pointerType "pen" with real
 * pressure values, as a Wacom/Apple Pencil/S Pen would produce.
 */
test('pen pressure controls brush size', async ({ page }) => {
  await openApp(page);
  await newImage(page, 64, 64);
  await page.evaluate(() => {
    const e = (window as any).art.editor;
    e.setTool('brush');
    e.setOption('brush', 'size', 20);
    e.setOption('brush', 'hardness', 1);
    e.setOption('brush', 'pressureSize', true);
    e.setOption('brush', 'pressureOpacity', false);
  });
  const client = await page.context().newCDPSession(page);
  const stroke = async (y: number, force: number) => {
    const a = await pixelPoint(page, 10, y);
    const b = await pixelPoint(page, 50, y);
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', clickCount: 1, pointerType: 'pen', force });
    for (let i = 1; i <= 10; i++) {
      const x = a.x + ((b.x - a.x) * i) / 10;
      await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: a.y, button: 'left', buttons: 1, pointerType: 'pen', force });
    }
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1, pointerType: 'pen', force: 0 });
  };
  await stroke(16, 0.25);
  await stroke(44, 1);
  /** Height of the painted band in column 30. */
  const thickness = (y0: number, y1: number) =>
    page.evaluate(([a, b]) => {
      const cel = (window as any).art.editor.doc.activeCel;
      let n = 0;
      for (let y = a; y < b; y++) if (cel.getPixel(30, y)[3] > 127) n++;
      return n;
    }, [y0, y1]);
  const light = await thickness(0, 32);
  const firm = await thickness(32, 64);
  expect(light).toBeGreaterThanOrEqual(3);
  expect(light).toBeLessThanOrEqual(7);
  expect(firm).toBeGreaterThanOrEqual(18);
  expect(firm).toBeLessThanOrEqual(22);
  // A detected pen switches fingers to navigation in automatic touch mode.
  await expect(page.locator('.toast').last()).toContainText('Pen detected');
});

import { expect, test } from '@playwright/test';
import { layerPixel, newImage, openApp, pixelPoint } from './helpers';

test('is installable: manifest and icons are served', async ({ page, request }) => {
  await openApp(page);
  const href = await page.locator('link[rel=manifest]').getAttribute('href');
  const manifestUrl = new URL(href!, page.url()).href;
  const manifest = await (await request.get(manifestUrl)).json();
  expect(manifest.display).toBe('standalone');
  expect(manifest.icons.some((i: { purpose?: string }) => i.purpose === 'maskable')).toBe(true);
  for (const icon of manifest.icons) {
    const res = await request.get(new URL(icon.src, manifestUrl).href);
    expect(res.ok(), icon.src).toBe(true);
  }
});

test('works offline after the first visit', async ({ page, context }) => {
  await openApp(page);
  const hasSW = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return false;
    const reg = await Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(() => r(null), 8000))]);
    return !!reg;
  });
  test.skip(!hasSW, 'Service worker only runs in the production build');
  // Wait until the worker controls the page.
  await page
    .waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 10_000 })
    .catch(async () => {
      await page.reload();
      await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    });
  await context.setOffline(true);
  await page.reload();
  await page.waitForFunction(() => !!(window as any).art);
  await newImage(page, 8, 8);
  const p = await pixelPoint(page, 2, 2);
  await page.mouse.click(p.x, p.y);
  expect((await layerPixel(page, 2, 2))[3]).toBe(255);
  await context.setOffline(false);
});

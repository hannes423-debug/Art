import { expect, test } from '@playwright/test';
import { newImage, openApp } from './helpers';

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

/** A 4×4 transparent sprite whose single red pixel walks right over 3 frames (100/200/300 ms). */
async function walkCycle(page: import('@playwright/test').Page) {
  await newImage(page, 4, 4);
  await page.evaluate(() => {
    const e = (window as any).art.editor;
    const d = e.doc;
    for (let i = 1; i < 3; i++)
      d.insertFrame(
        i,
        { duration: 100 },
        d.layers.map((l: any) => l.cels[0].clone()),
      );
    d.frames.forEach((f: any, i: number) => (f.duration = 100 * (i + 1)));
    d.layers[0].cels.forEach((c: any, i: number) => {
      c.ensureData().fill(0);
      c.ensureData().set([255, 0, 0, 255], (1 * 4 + i) * 4);
      c.touch({ x: 0, y: 0, w: 4, h: 4 });
    });
    d.emit('frames');
    d.setActiveFrame(0);
    e.markChanged();
  });
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => !!(window as any).art.editor.info.projectId && !(window as any).art.editor.modified);
}

/** Which frame a thumbnail canvas shows: the x of its red pixel (or -1), and whether everything else is transparent. */
async function shown(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('.project-thumb canvas')!;
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let red = -1;
    let other = 0;
    for (let p = 0; p < d.length; p += 4) {
      if (d[p] === 255 && d[p + 1] === 0 && d[p + 2] === 0 && d[p + 3] === 255) red = (p / 4) % c.width;
      else if (d[p + 3] !== 0) other++;
    }
    return { red, other, w: c.width, h: c.height };
  });
}

test('multi-frame projects play in the project list with their own timing, crisp and transparent', async ({ page }) => {
  await walkCycle(page);
  await page.evaluate(() => (window as any).art.showProjects());
  const canvas = page.locator('.project-thumb canvas');
  await expect(canvas).toHaveCount(1);
  // Exact pixels at the sprite's own size (scaled by CSS with pixelated rendering).
  await expect.poll(async () => (await shown(page)).red).not.toBe(-1);
  const s = await shown(page);
  expect([s.w, s.h, s.other]).toEqual([4, 4, 0]);
  expect(await canvas.evaluate((c) => getComputedStyle(c).imageRendering)).toBe('pixelated');
  expect(await canvas.evaluate((c) => c.style.width)).toBe('96px');
  // Sample over two loops (1.2 s): every frame shows, in order, ~proportional to its duration.
  const seen: number[] = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 1200) {
    seen.push((await shown(page)).red);
    await page.waitForTimeout(20);
  }
  const counts = [0, 1, 2].map((x) => seen.filter((v) => v === x).length);
  expect(counts.every((n) => n > 0)).toBe(true);
  expect(counts[2]).toBeGreaterThan(counts[0]);
  expect(seen.every((v) => v >= 0 && v <= 2)).toBe(true);
  // The open document is untouched by its preview playing.
  const state = await page.evaluate(() => {
    const e = (window as any).art.editor;
    return { frame: e.doc.activeFrame, undo: e.history.undoCount, playing: e.playing, modified: e.modified };
  });
  expect(state).toEqual({ frame: 0, undo: 0, playing: false, modified: false });
  // Turning animated thumbnails off shows the first frame and stops.
  await page.evaluate(() => (window as any).art.editor.updateSettings({ animatedThumbs: false }));
  await expect.poll(async () => (await shown(page)).red).toBe(0);
  await page.waitForTimeout(450);
  expect((await shown(page)).red).toBe(0);
});

test('one-frame projects stay static', async ({ page }) => {
  await newImage(page, 8, 8, 'white');
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => !!(window as any).art.editor.info.projectId);
  await page.evaluate(() => (window as any).art.showProjects());
  await expect(page.locator('.project-thumb img')).toHaveCount(1);
  await expect(page.locator('.project-thumb canvas')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).art.thumbs.size)).toBe(0);
});

test('hundreds of animated thumbnails: one scheduler, only visible ones decoded, released when closed', async ({ page }) => {
  await newImage(page, 8, 8);
  // Let the app create its library database, then seed 200 animated projects into it.
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => !!(window as any).art.editor.info.projectId);
  await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 32;
    c.height = 8;
    const ctx = c.getContext('2d')!;
    ['#f00', '#0f0', '#00f', '#ff0'].forEach((col, i) => {
      ctx.fillStyle = col;
      ctx.fillRect(i * 8 + 2, 2, 4, 4);
    });
    const strip: Blob = await new Promise((r) => c.toBlob((b) => r(b!), 'image/png'));
    const db: IDBDatabase = await new Promise((res, rej) => {
      const req = indexedDB.open('art', 2);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    const tx = db.transaction('meta', 'readwrite');
    for (let i = 0; i < 200; i++) {
      tx.objectStore('meta').put({
        id: `seed-${i}`,
        name: `Sprite ${i}`,
        width: 8,
        height: 8,
        frames: 4,
        layers: 1,
        created: new Date().toISOString(),
        modified: new Date(Date.now() - i * 1000).toISOString(),
        thumbnail: null,
        anim: { strip, frameW: 8, frameH: 8, durations: [80, 80, 80, 80 + (i % 5) * 40] },
      });
    }
    await new Promise((r) => (tx.oncomplete = r));
    db.close();
  });
  const longTasks = await page.evaluate(() => {
    (window as any).__long = 0;
    new PerformanceObserver((l) => ((window as any).__long += l.getEntries().filter((e) => e.duration > 100).length)).observe({
      type: 'longtask',
      buffered: false,
    });
    return 0;
  });
  void longTasks;
  await page.evaluate(() => (window as any).art.showProjects());
  // 200 seeded animations (the saved one-frame project stays a static image).
  await expect(page.locator('.project-thumb canvas')).toHaveCount(200);
  expect(await page.evaluate(() => (window as any).art.thumbs.size)).toBe(200);
  await page.waitForTimeout(600);
  const decoded = await page.evaluate(() => (window as any).art.thumbs.decoded);
  expect(decoded).toBeGreaterThan(0);
  expect(decoded).toBeLessThan(60);
  // Scroll to the end: the last ones animate too.
  await page.locator('.project-thumb canvas').last().scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  const last = await page
    .locator('.project-thumb canvas')
    .last()
    .evaluate((c: HTMLCanvasElement) => {
      const d = c.getContext('2d')!.getImageData(4, 4, 1, 1).data;
      return d[3];
    });
  expect(last).toBe(255);
  expect(await page.evaluate(() => (window as any).__long)).toBe(0);
  // Closing the list releases everything.
  await page.locator('dialog.dialog .dialog-footer').getByRole('button', { name: 'Close' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).art.thumbs.size)).toBe(0);
});

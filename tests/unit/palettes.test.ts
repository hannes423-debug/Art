import { describe, expect, it } from 'vitest';
import { parseHex } from '../../src/core/color';
import { ArtDocument } from '../../src/core/document';
import { History } from '../../src/core/history';
import { PALETTE_PRESETS, findPreset, paletteNameFromFile, parsePalette, presetColors, quantizeRGB555, toGpl } from '../../src/core/palette';
import { deserializeProject, projectToJSON } from '../../src/io/project';
import { addFrame, countOffPalette, mapToPalette } from '../../src/ops';

describe('built-in palettes', () => {
  it('are well formed: unique ids, valid colors, no duplicates within a palette', () => {
    const ids = new Set<string>();
    for (const p of PALETTE_PRESETS) {
      expect(ids.has(p.id), p.id).toBe(false);
      ids.add(p.id);
      expect(p.colors.length).toBeGreaterThan(1);
      for (const c of p.colors) expect(parseHex(c), `${p.name} ${c}`).not.toBeNull();
      expect(new Set(p.colors).size, p.name).toBe(p.colors.length);
    }
    for (const id of ['db32', 'pico8', 'gameboy', 'gba32', 'nes', 'snes16', 'gray8']) expect(findPreset(id)).toBeDefined();
    expect(presetColors('nes').length).toBeGreaterThanOrEqual(52);
    expect(presetColors('pico8')).toHaveLength(16);
    // Older code looked palettes up by name.
    expect(presetColors('DawnBringer 32')).toEqual(presetColors('db32'));
  });

  it('GBA/SNES-style palettes only hold 15-bit (RGB555) colors', () => {
    const is555 = (v: number) => Math.round((Math.round((v * 31) / 255) * 255) / 31) === v;
    for (const id of ['gba32', 'snes16']) for (const c of presetColors(id)) expect([c.r, c.g, c.b].every(is555), `${id} ${JSON.stringify(c)}`).toBe(true);
    expect(quantizeRGB555('ffffff')).toBe('ffffff');
    expect(quantizeRGB555('000000')).toBe('000000');
    expect(quantizeRGB555('7f7f7f')).toBe('7b7b7b');
  });

  it('reads palette names from GIMP files and round-trips', () => {
    const gpl = toGpl(presetColors('gameboy'), 'Pocket Greens');
    expect(paletteNameFromFile(gpl)).toBe('Pocket Greens');
    expect(parsePalette(gpl)).toEqual(presetColors('gameboy'));
    expect(paletteNameFromFile('ff0000\n00ff00')).toBeNull();
  });
});

describe('mapping an image to a palette', () => {
  const pal = presetColors('gameboy');

  it('counts colors outside the palette across all frames', () => {
    const d = ArtDocument.createBlank(2, 1, 'T', { r: 15, g: 56, b: 15, a: 255 });
    expect(countOffPalette(d, pal)).toBe(0);
    addFrame(d, new History(), 'duplicate');
    d.activeCel.ensureData().set([200, 10, 10, 255, 1, 2, 3, 255]);
    expect(countOffPalette(d, pal)).toBe(2);
  });

  it('can keep the original: maps a copy of the layer and hides the original, one undo step', () => {
    const d = ArtDocument.createBlank(2, 1, 'T', { r: 255, g: 0, b: 0, a: 255 });
    const h = new History();
    const original = d.activeLayer;
    expect(mapToPalette(d, h, pal, { allLayers: false, allFrames: false, dither: false, keepOriginal: true, label: 'Game Boy' })).toBe(2);
    expect(d.layers).toHaveLength(2);
    const copy = d.layers[1];
    expect(copy.name).toBe('Background (Game Boy)');
    expect(d.activeLayer).toBe(copy);
    expect(original.visible).toBe(false);
    expect(original.cels[0].getPixel(0, 0)).toEqual([255, 0, 0, 255]);
    const mapped = copy.cels[0].getPixel(0, 0);
    expect(pal.some((c) => c.r === mapped[0] && c.g === mapped[1] && c.b === mapped[2])).toBe(true);
    expect(h.undoCount).toBe(1);
    h.undo();
    expect(d.layers).toEqual([original]);
    expect(original.visible).toBe(true);
    h.redo();
    expect(original.visible).toBe(false);
  });

  it('keeps linked cels linked in the copy', () => {
    const d = ArtDocument.createBlank(1, 1, 'T', { r: 255, g: 0, b: 0, a: 255 });
    const h = new History();
    addFrame(d, h, 'linked');
    mapToPalette(d, h, pal, { allLayers: false, allFrames: true, dither: false, keepOriginal: true });
    const copy = d.activeLayer;
    expect(copy.cels[1]).toBe(copy.cels[0]);
    expect(copy.cels[0]).not.toBe(d.layers[0].cels[0]);
  });
});

describe('project files', () => {
  it('remember the palette name (optional field, older files still load)', async () => {
    const d = ArtDocument.createBlank(1, 1);
    const json = await projectToJSON(d, { palette: presetColors('pico8'), paletteName: 'PICO-8', grid: { enabled: false, width: 8, height: 8 } });
    const parsed = JSON.parse(json);
    expect(parsed.version).toBe(1);
    expect(parsed.paletteName).toBe('PICO-8');
    expect((await deserializeProject(json)).extras.paletteName).toBe('PICO-8');
    delete parsed.paletteName;
    expect((await deserializeProject(parsed)).extras.paletteName).toBeUndefined();
  });
});

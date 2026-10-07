import type { GridSettings } from './render/renderer';
import { type ToolId, type ToolOptions, defaultToolOptions } from './tools/tool';

export type TouchMode = 'auto' | 'draw' | 'navigate';

export interface Settings {
  /** auto: fingers draw until a pen is used, then fingers only navigate. */
  touchMode: TouchMode;
  /** Mouse wheel zooms (true) or scrolls/pans (false). Ctrl+wheel always zooms. */
  wheelZoom: boolean;
  /** Two-finger rotation of the canvas view. */
  rotateGesture: boolean;
  pixelGrid: boolean;
  grid: GridSettings;
  snapToGrid: boolean;
  /** Smooth (bilinear) view scaling instead of crisp pixels. */
  smooth: boolean;
  onionSkin: boolean;
  onionOpacity: number;
  /** Playback speed for animation preview. */
  fps: number;
  showTimeline: boolean;
  /** Desktop side panel visible. */
  sidePanel: boolean;
  /** Tile preview: repeat the image around itself; drawing wraps across edges. */
  tileMode: 'off' | 'both' | 'x' | 'y';
  /** Snap every painted color to the nearest palette color. */
  paletteLock: boolean;
}

export function defaultSettings(): Settings {
  return {
    touchMode: 'auto',
    wheelZoom: true,
    rotateGesture: false,
    pixelGrid: true,
    grid: { enabled: false, width: 16, height: 16 },
    snapToGrid: false,
    smooth: false,
    onionSkin: false,
    onionOpacity: 0.3,
    fps: 8,
    showTimeline: false,
    sidePanel: true,
    tileMode: 'off',
    paletteLock: false,
  };
}

export interface PersistedState {
  settings: Settings;
  options: ToolOptions;
  fg: string;
  bg: string;
  palette: string[];
  recent: string[];
  tool: ToolId;
}

const KEY = 'art.state.v1';

/** Deep-merges stored values over defaults, ignoring unknown keys and wrong types. */
function mergeDefaults<T>(defaults: T, stored: unknown): T {
  if (typeof defaults !== 'object' || defaults === null || Array.isArray(defaults)) {
    return typeof stored === typeof defaults ? (stored as T) : defaults;
  }
  if (typeof stored !== 'object' || stored === null) return defaults;
  const out = { ...defaults } as Record<string, unknown>;
  for (const k of Object.keys(defaults as object)) {
    out[k] = mergeDefaults((defaults as Record<string, unknown>)[k], (stored as Record<string, unknown>)[k]);
  }
  return out as T;
}

export function loadState(): Partial<PersistedState> & { settings: Settings; options: ToolOptions } {
  let stored: Record<string, unknown> = {};
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) stored = JSON.parse(raw);
  } catch {
    // Storage unavailable (private mode) or corrupt: fall back to defaults.
  }
  return {
    settings: mergeDefaults(defaultSettings(), stored.settings),
    options: mergeDefaults(defaultToolOptions(), stored.options),
    fg: typeof stored.fg === 'string' ? stored.fg : undefined,
    bg: typeof stored.bg === 'string' ? stored.bg : undefined,
    palette: Array.isArray(stored.palette) ? (stored.palette as string[]).filter((s) => typeof s === 'string') : undefined,
    recent: Array.isArray(stored.recent) ? (stored.recent as string[]).filter((s) => typeof s === 'string') : undefined,
    tool: typeof stored.tool === 'string' ? (stored.tool as ToolId) : undefined,
  };
}

export function saveState(state: PersistedState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Ignore quota/private-mode errors; settings are a convenience.
  }
}

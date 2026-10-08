import type { ProjectData } from './project';

/**
 * Local project library in IndexedDB. Projects never leave the device.
 * Metadata (with a thumbnail) is stored separately from the pixel data so
 * the project list loads quickly.
 */

export interface ProjectMeta {
  id: string;
  name: string;
  width: number;
  height: number;
  frames: number;
  layers: number;
  created: string;
  modified: string;
  thumbnail: Blob | null;
  /** Animated preview for multi-frame projects (absent for one frame and for projects saved by older versions). */
  anim?: ThumbnailAnimation;
}

/**
 * A small animated preview: the frames of the default animation side by
 * side in one PNG strip (frameW × frameH each), with each frame's duration.
 */
export interface ThumbnailAnimation {
  strip: Blob;
  frameW: number;
  frameH: number;
  durations: number[];
}

const DB_NAME = 'art';
/** 2: adds the 'timelapse' store. */
const DB_VERSION = 2;
let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('This browser does not support local storage of projects.'));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('data')) db.createObjectStore('data', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('timelapse')) {
          const s = db.createObjectStore('timelapse', { autoIncrement: true });
          s.createIndex('project', 'project');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('Could not open the project library'));
      req.onblocked = () => reject(new Error('The project library is blocked by another tab'));
    });
    dbPromise.catch(() => (dbPromise = null));
  }
  return dbPromise;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Storage error'));
    tx.onabort = () => reject(tx.error ?? new Error('Storage aborted (is the disk full?)'));
  });
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function newProjectId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return 'p-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

export async function listProjects(): Promise<ProjectMeta[]> {
  const db = await openDB();
  const tx = db.transaction('meta', 'readonly');
  const all = await request(tx.objectStore('meta').getAll() as IDBRequest<ProjectMeta[]>);
  return all.sort((a, b) => b.modified.localeCompare(a.modified));
}

export async function saveProject(meta: ProjectMeta, data: ProjectData<Blob>): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(['meta', 'data'], 'readwrite');
  tx.objectStore('meta').put(meta);
  tx.objectStore('data').put({ id: meta.id, project: data });
  await done(tx);
}

export async function loadProject(id: string): Promise<{ meta: ProjectMeta; data: ProjectData<Blob> } | null> {
  const db = await openDB();
  const tx = db.transaction(['meta', 'data'], 'readonly');
  const meta = await request(tx.objectStore('meta').get(id) as IDBRequest<ProjectMeta | undefined>);
  const row = await request(tx.objectStore('data').get(id) as IDBRequest<{ id: string; project: ProjectData<Blob> } | undefined>);
  if (!meta || !row) return null;
  return { meta, data: row.project };
}

/** Adds an animated preview to a stored project's metadata (if the project still exists). */
export async function setProjectAnimation(id: string, anim: ThumbnailAnimation): Promise<void> {
  const db = await openDB();
  const tx = db.transaction('meta', 'readwrite');
  const store = tx.objectStore('meta');
  const meta = await request(store.get(id) as IDBRequest<ProjectMeta | undefined>);
  if (meta) store.put({ ...meta, anim });
  await done(tx);
}

export async function deleteProject(id: string): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(['meta', 'data'], 'readwrite');
  tx.objectStore('meta').delete(id);
  tx.objectStore('data').delete(id);
  await done(tx);
  await clearTimelapse(id);
}

// ------------------------------------------------------------- Timelapse

/** One recorded snapshot of a project (a small PNG of the whole image). */
export interface TimelapseFrame {
  project: string;
  time: number;
  png: Blob;
}

export async function addTimelapseFrames(frames: TimelapseFrame[]): Promise<void> {
  if (!frames.length) return;
  const db = await openDB();
  const tx = db.transaction('timelapse', 'readwrite');
  const s = tx.objectStore('timelapse');
  for (const f of frames) s.add(f);
  await done(tx);
}

/** All frames of a project in recording order. */
export async function getTimelapseFrames(project: string): Promise<TimelapseFrame[]> {
  const db = await openDB();
  const tx = db.transaction('timelapse', 'readonly');
  const all = await request(tx.objectStore('timelapse').index('project').getAll(project) as IDBRequest<TimelapseFrame[]>);
  return all.sort((a, b) => a.time - b.time);
}

export async function countTimelapseFrames(project: string): Promise<number> {
  const db = await openDB();
  const tx = db.transaction('timelapse', 'readonly');
  return request(tx.objectStore('timelapse').index('project').count(project));
}

export async function clearTimelapse(project: string): Promise<void> {
  const db = await openDB();
  const tx = db.transaction('timelapse', 'readwrite');
  const idx = tx.objectStore('timelapse').index('project');
  const keys = await request(idx.getAllKeys(project));
  for (const k of keys) tx.objectStore('timelapse').delete(k);
  await done(tx);
}

export async function renameProject(id: string, name: string): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(['meta', 'data'], 'readwrite');
  const meta = await request(tx.objectStore('meta').get(id) as IDBRequest<ProjectMeta | undefined>);
  const row = await request(tx.objectStore('data').get(id) as IDBRequest<{ id: string; project: ProjectData<Blob> } | undefined>);
  if (meta) tx.objectStore('meta').put({ ...meta, name });
  if (row) tx.objectStore('data').put({ ...row, project: { ...row.project, name } });
  await done(tx);
}

/** Asks the browser not to evict our storage under pressure (best effort). */
export async function requestPersistence(): Promise<boolean> {
  try {
    if (navigator.storage?.persisted && (await navigator.storage.persisted())) return true;
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

const LAST_KEY = 'art.lastProject';

export function getLastProjectId(): string | null {
  try {
    return localStorage.getItem(LAST_KEY);
  } catch {
    return null;
  }
}

export function setLastProjectId(id: string | null): void {
  try {
    if (id) localStorage.setItem(LAST_KEY, id);
    else localStorage.removeItem(LAST_KEY);
  } catch {
    // ignore
  }
}

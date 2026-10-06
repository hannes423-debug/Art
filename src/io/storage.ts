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
}

const DB_NAME = 'art';
const DB_VERSION = 1;
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

export async function deleteProject(id: string): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(['meta', 'data'], 'readwrite');
  tx.objectStore('meta').delete(id);
  tx.objectStore('data').delete(id);
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

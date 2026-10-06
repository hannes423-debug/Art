/**
 * File open/save that works everywhere: the File System Access API where
 * available (Chromium desktop: real "Save" back to the same file), and
 * <input type=file> / downloads elsewhere (Firefox, Safari, mobile).
 */

export interface FileType {
  description: string;
  /** MIME type → extensions (with dots). */
  accept: Record<string, string[]>;
}

export interface PickedFile {
  file: File;
  handle: FileSystemFileHandle | null;
}

interface FsWindow {
  showOpenFilePicker?: (opts: unknown) => Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?: (opts: unknown) => Promise<FileSystemFileHandle>;
}

const fsWin = window as unknown as FsWindow;

export const hasFileSystemAccess = typeof fsWin.showOpenFilePicker === 'function' && typeof fsWin.showSaveFilePicker === 'function';

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

/** Opens a file picker. Resolves to [] when the user cancels. */
export async function pickFiles(types: FileType[], multiple = false): Promise<PickedFile[]> {
  if (hasFileSystemAccess) {
    try {
      const handles = await fsWin.showOpenFilePicker!({ types, multiple, excludeAcceptAllOption: false });
      return Promise.all(handles.map(async (h) => ({ file: await h.getFile(), handle: h })));
    } catch (err) {
      if (isAbort(err)) return [];
      console.warn('showOpenFilePicker failed, falling back to <input>', err);
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = multiple;
    // Mobile pickers often grey out unknown extensions, so only filter on desktop.
    if (!matchMedia('(pointer: coarse)').matches) {
      input.accept = types.flatMap((t) => Object.entries(t.accept).flatMap(([mime, exts]) => [mime, ...exts])).join(',');
    }
    input.style.display = 'none';
    let settled = false;
    const finish = (files: PickedFile[]) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => finish([...(input.files ?? [])].map((file) => ({ file, handle: null }))));
    input.addEventListener('cancel', () => finish([]));
    document.body.append(input);
    input.click();
  });
}

export type SaveResult = { status: 'saved'; handle: FileSystemFileHandle } | { status: 'downloaded' } | { status: 'cancelled' };

/** Writes to an existing handle (no prompt). Throws if permission is denied. */
export async function writeToHandle(handle: FileSystemFileHandle, blob: Blob): Promise<void> {
  const h = handle as FileSystemFileHandle & {
    queryPermission?: (d: { mode: string }) => Promise<string>;
    requestPermission?: (d: { mode: string }) => Promise<string>;
  };
  if (h.queryPermission && (await h.queryPermission({ mode: 'readwrite' })) !== 'granted') {
    if (!h.requestPermission || (await h.requestPermission({ mode: 'readwrite' })) !== 'granted') {
      throw new Error('Permission to write the file was denied.');
    }
  }
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
}

/** "Save as": native save dialog where supported, otherwise a download. */
export async function saveFileAs(blob: Blob, suggestedName: string, types: FileType[]): Promise<SaveResult> {
  if (hasFileSystemAccess) {
    try {
      const handle = await fsWin.showSaveFilePicker!({ suggestedName, types });
      await writeToHandle(handle, blob);
      return { status: 'saved', handle };
    } catch (err) {
      if (isAbort(err)) return { status: 'cancelled' };
      console.warn('showSaveFilePicker failed, falling back to download', err);
    }
  }
  downloadBlob(blob, suggestedName);
  return { status: 'downloaded' };
}

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Web Share with files (mobile): lets users send a PNG straight to Photos, chat apps, etc. */
export function canShareFile(blob: Blob, name: string): boolean {
  try {
    const file = new File([blob], name, { type: blob.type });
    return typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });
  } catch {
    return false;
  }
}

export async function shareFile(blob: Blob, name: string): Promise<boolean> {
  const file = new File([blob], name, { type: blob.type });
  try {
    await navigator.share({ files: [file], title: name });
    return true;
  } catch (err) {
    if (isAbort(err)) return false;
    throw err;
  }
}

/** Safe file name from a document name. */
export function fileNameFor(name: string, ext: string): string {
  const base = name.replace(/\.[a-z0-9]{2,8}$/i, '').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'untitled';
  return `${base}.${ext}`;
}

/**
 * Saving and opening project files. Chrome and Edge have a file picker API, so
 * Save can write the same file again; other browsers download a copy instead.
 */

interface Writable {
  write(data: string | Blob): Promise<void>;
  close(): Promise<void>;
}

export interface FileHandle {
  readonly name: string;
  createWritable(): Promise<Writable>;
  getFile(): Promise<File>;
}

interface PickerType {
  description: string;
  accept: Record<string, string[]>;
}

interface PickerWindow {
  showSaveFilePicker?: (o: { suggestedName?: string; types?: PickerType[] }) => Promise<FileHandle>;
  showOpenFilePicker?: (o: { types?: PickerType[]; multiple?: boolean }) => Promise<FileHandle[]>;
}

const TYPES: PickerType[] = [{ description: 'Tanker Time project', accept: { 'application/json': ['.json'] } }];

function pickerWindow(): PickerWindow {
  return window as unknown as PickerWindow;
}

/** The browser can save to a chosen file and save to it again later. Pickers do not work inside frames. */
export function canPickFiles(): boolean {
  try {
    return typeof pickerWindow().showSaveFilePicker === 'function' && window.self === window.top;
  } catch {
    return false;
  }
}

function aborted(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

/** Asks where to save. Returns null when the user cancels. */
export async function pickSaveFile(suggestedName: string): Promise<FileHandle | null> {
  try {
    return await pickerWindow().showSaveFilePicker!({ suggestedName, types: TYPES });
  } catch (err) {
    if (aborted(err)) return null;
    throw err;
  }
}

export async function pickOpenFile(): Promise<{ file: File; handle: FileHandle } | null> {
  try {
    const [handle] = await pickerWindow().showOpenFilePicker!({ types: TYPES, multiple: false });
    return handle ? { file: await handle.getFile(), handle } : null;
  } catch (err) {
    if (aborted(err)) return null;
    throw err;
  }
}

export async function writeFile(handle: FileHandle, text: string): Promise<void> {
  const w = await handle.createWritable();
  await w.write(new Blob([text], { type: 'application/json' }));
  await w.close();
}

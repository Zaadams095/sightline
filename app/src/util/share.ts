import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import type { CameraSystemAdapter } from '@/systems/types';

const clipsDir = () => {
  const dir = new Directory(Paths.cache, 'clips');
  if (!dir.exists) dir.create();
  return dir;
};

/**
 * Saves a URL to `dest`: downloads http(s), copies local files (e.g. media bundled with the
 * app, which is a file:// URL in release builds).
 */
export async function fetchToFile(uri: string, dest: File): Promise<File> {
  if (dest.exists) dest.delete();
  if (!uri.startsWith('file:')) return File.downloadFileAsync(uri, dest);
  new File(uri).copy(dest);
  return dest;
}

/** Downloads a clip through the gateway and opens the iOS share sheet. */
export async function shareClip(adapter: CameraSystemAdapter, cameraId: string, cameraName: string, start: number, end: number) {
  if (!adapter.clip) throw new Error('This system cannot export clips.');
  const stamp = new Date(start * 1000).toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const name = `${cameraName.replace(/[^\w-]+/g, '_')}_${stamp}.mp4`;
  const dest = new File(clipsDir(), name);
  const file = await fetchToFile(adapter.clip(cameraId, start, end).uri, dest);
  await Sharing.shareAsync(file.uri, { mimeType: 'video/mp4', UTI: 'public.mpeg-4', dialogTitle: cameraName });
}

/** Removes exported clips older than a day so the cache doesn't grow. */
export function pruneClips() {
  try {
    const dir = clipsDir();
    const cutoff = Date.now() - 86_400_000;
    for (const f of dir.list()) if (f instanceof File && (f.modificationTime ?? 0) < cutoff) f.delete();
  } catch {}
}

const libraryDir = () => {
  const dir = new Directory(Paths.document, 'library');
  if (!dir.exists) dir.create();
  return dir;
};

/** Downloads a saved clip into the app's Documents (kept until removed) for offline viewing. */
export async function downloadClipForOffline(
  adapter: CameraSystemAdapter,
  clip: { id: string; cameraId: string; start: number; end: number },
): Promise<string> {
  if (!adapter.clip) throw new Error('This system cannot export clips.');
  const dest = new File(libraryDir(), `${clip.id}.mp4`);
  const file = await fetchToFile(adapter.clip(clip.cameraId, clip.start, clip.end).uri, dest);
  return file.uri;
}

export function deleteOfflineClip(uri: string) {
  try {
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch {}
}

export async function shareLocalFile(uri: string, title: string) {
  await Sharing.shareAsync(uri, { mimeType: 'video/mp4', UTI: 'public.mpeg-4', dialogTitle: title });
}

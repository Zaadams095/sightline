import { Directory, File, Paths } from 'expo-file-system';
import Storage from 'expo-sqlite/kv-store';
import type { StateStorage } from 'zustand/middleware';

import { AppGroup } from '@modules/app-group';

/**
 * Where familiar faces & vehicles live: the app's Documents/familiar folder (crops in
 * crops/, the store with the feature prints in its own JSON file), marked "exclude from
 * backup" so none of it goes into iCloud or computer backups of the iPhone. It stays on this
 * iPhone only; a new phone starts without it. The copy the notification extension reads (App
 * Group familiar/gallery.json, recognize.ts syncGallery) is excluded the same way.
 *
 * Earlier versions kept the store in the shared settings database (expo-sqlite kv-store),
 * which is backed up with the phone; it's moved here once and deleted there.
 */
export const FAMILIAR_DIR = 'familiar';

const familiarDir = () => new Directory(Paths.document, FAMILIAR_DIR);

let excluded = false;

/** The familiar folder, created if needed and kept out of backups. */
export function ensureFamiliarDir(): Directory {
  const dir = familiarDir();
  if (!dir.exists) {
    dir.create({ intermediates: true, idempotent: true });
    excluded = false;
  }
  if (!excluded) {
    excluded = true;
    void excludeFromBackup(dir.uri).catch(() => {
      excluded = false; // try again on the next write
    });
  }
  return dir;
}

/** Marks a file or folder "don't back up". No-op on builds without it (an older binary). */
export async function excludeFromBackup(uri: string): Promise<void> {
  if (typeof AppGroup?.excludeFromBackup === 'function') await AppGroup.excludeFromBackup(uri);
}

/** The same for a path in the App Group container (the notification extension's copy). */
export async function excludeGroupPathFromBackup(relPath: string): Promise<void> {
  if (typeof AppGroup?.excludeGroupPathFromBackup === 'function') await AppGroup.excludeGroupPathFromBackup(relPath);
}

const storeFile = (name: string) => new File(ensureFamiliarDir(), `${name}.json`);

function writeStore(name: string, value: string) {
  const f = storeFile(name);
  if (!f.exists) f.create();
  f.write(value);
}

/** zustand storage for the familiar store: a file in the excluded folder. */
export const familiarStorage: StateStorage = {
  async getItem(name) {
    // Also covers a gallery written before the extension's copy was excluded.
    void excludeGroupPathFromBackup(FAMILIAR_DIR).catch(() => {});
    const f = storeFile(name);
    if (f.exists) return f.text();
    // One-time move out of the backed-up settings database.
    const old = await Storage.getItem(name);
    if (old == null) return null;
    try {
      writeStore(name, old);
      await Storage.removeItem(name);
    } catch {
      // Keep the old copy; the next start tries again.
    }
    return old;
  },
  setItem(name, value) {
    writeStore(name, value);
  },
  removeItem(name) {
    try {
      const f = storeFile(name);
      if (f.exists) f.delete();
    } catch {}
    void Storage.removeItem(name).catch(() => {});
  },
};

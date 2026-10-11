import * as Crypto from 'expo-crypto';
import Storage from 'expo-sqlite/kv-store';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import type { UploadMeta } from '@/backup/sections';

/** This phone's backup settings and bookkeeping. Never itself backed up. */
interface BackupState {
  /** "Back up to iCloud" (on by default). */
  enabled: boolean;
  /** Random id for this install, used to break ties between phones. */
  deviceId: string;
  /** What this phone last uploaded per section. */
  meta: UploadMeta;
  lastBackupAt: number;
  /** Plain-language problem with the last backup, if any. */
  lastError: string | null;
  /** Existing keychain secrets have been copied to iCloud Keychain. */
  secretsMigrated: boolean;
  /** The "Welcome back" offer was dismissed. */
  restoreDismissed: boolean;
  set(p: Partial<Omit<BackupState, 'set'>>): void;
}

export const useBackup = create<BackupState>()(
  persist(
    (set) => ({
      enabled: true,
      deviceId: '',
      meta: {},
      lastBackupAt: 0,
      lastError: null,
      secretsMigrated: false,
      restoreDismissed: false,
      set: (p) => set(p),
    }),
    { name: 'backup-settings', version: 1, storage: createJSONStorage(() => Storage) },
  ),
);

export function backupDeviceId(): string {
  let id = useBackup.getState().deviceId;
  if (!id) {
    id = Crypto.randomUUID();
    useBackup.getState().set({ deviceId: id });
  }
  return id;
}

/** Resolves once the backup settings have loaded from disk. */
export function backupHydrated(): Promise<void> {
  if (useBackup.persist.hasHydrated()) return Promise.resolve();
  return new Promise((resolve) => {
    const unsub = useBackup.persist.onFinishHydration(() => {
      unsub();
      resolve();
    });
  });
}

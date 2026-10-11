import { requireOptionalNativeModule } from 'expo-modules-core';

interface NativeAppGroup {
  writeText(relPath: string, text: string): Promise<void>;
  copyFile(fromUri: string, relPath: string): Promise<void>;
  readText(relPath: string): Promise<string | null>;
  removeFile(relPath: string): Promise<void>;
  /** Keeps a file or folder (file:// URI) out of iCloud / computer backups. Newer builds only. */
  excludeFromBackup?(uri: string): Promise<void>;
  /** The same for a path in the App Group container. Newer builds only. */
  excludeGroupPathFromBackup?(relPath: string): Promise<void>;
  reloadWidgets(): void;
}

/** Files shared with the widget / Siri extensions. null in Expo Go and on builds without it. */
export const AppGroup = requireOptionalNativeModule<NativeAppGroup>('AppGroup');

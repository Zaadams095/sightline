import { requireOptionalNativeModule } from 'expo-modules-core';

/** NSUbiquitousKeyValueStoreChangeReasonKey values. */
export const CLOUD_CHANGE = { server: 0, initialSync: 1, quotaViolation: 2, accountChange: 3 } as const;

interface NativeCloudBackup {
  isSignedIn(): boolean;
  kvSynchronize(): boolean;
  kvGet(key: string): string | null;
  kvSet(key: string, value: string): void;
  kvRemove(key: string): void;
  kvKeys(): string[];
  /** iCloud Keychain (synchronizable) items, service "sightline.sync". */
  syncSecretGet(account: string): Promise<string | null>;
  syncSecretSet(account: string, value: string): Promise<void>;
  syncSecretRemove(account: string): Promise<void>;
  syncSecretAccounts(): Promise<string[]>;
  /** data:image/png;base64 QR code. */
  qrPng(text: string): Promise<string>;
  addListener(event: 'onCloudChange', listener: (e: { reason: number; keys: string[] }) => void): { remove(): void };
}

/** null in Expo Go, on web and on builds made before iCloud backup existed. */
export const CloudBackup = requireOptionalNativeModule<NativeCloudBackup>('CloudBackup');

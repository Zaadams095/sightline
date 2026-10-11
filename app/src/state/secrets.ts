import * as SecureStore from 'expo-secure-store';

import { isSyncableSecret, secretKey, type SecretRef, type SecretValue } from '@/backup/sections';
import { useBackup } from '@/backup/settings';
import { CloudBackup } from '@modules/cloud-backup';

/**
 * Keychain-backed secrets. Keys are namespaced so a system's secrets can be wiped together.
 *
 * Each secret is kept on this phone (device-only keychain item, as always; this is what the
 * app reads). While "Back up to iCloud" is on, a copy also goes to iCloud Keychain so a new
 * phone signed in to the same Apple Account gets it. Reads fall back to that copy (a restored
 * phone) and keep a local one. The app-lock PIN never leaves the phone. The App Group items
 * the notification extension reads are separate and stay device-only (see alerts/bridge.ts).
 */
const opts: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

const cloudCopy = (scope: string) => !!CloudBackup && isSyncableSecret(scope);
const syncing = (scope: string) => cloudCopy(scope) && useBackup.getState().enabled;

export const secrets = {
  async get(scope: string, name: string): Promise<string | null> {
    const k = secretKey(scope, name);
    const local = await SecureStore.getItemAsync(k, opts);
    if (local != null || !cloudCopy(scope)) return local;
    const cloud = await CloudBackup!.syncSecretGet(k).catch(() => null);
    if (cloud != null) await SecureStore.setItemAsync(k, cloud, opts).catch(() => {});
    return cloud;
  },
  async set(scope: string, name: string, value: string): Promise<void> {
    const k = secretKey(scope, name);
    await SecureStore.setItemAsync(k, value, opts);
    if (syncing(scope)) await CloudBackup!.syncSecretSet(k, value).catch(() => {});
  },
  async remove(scope: string, name: string): Promise<void> {
    const k = secretKey(scope, name);
    await SecureStore.deleteItemAsync(k, opts);
    if (cloudCopy(scope)) await CloudBackup!.syncSecretRemove(k).catch(() => {});
  },
};

export const SECRET = {
  password: 'password',
  token: 'token',
  wireguardConf: 'wg.conf',
} as const;

/** The values of these secrets that exist (for an encrypted transfer bundle). */
export async function readSecrets(refs: SecretRef[]): Promise<SecretValue[]> {
  const out: SecretValue[] = [];
  for (const r of refs) {
    const value = await secrets.get(r.scope, r.name).catch(() => null);
    if (value) out.push({ ...r, value });
  }
  return out;
}

/** Saves secrets received from another phone. */
export async function writeSecrets(values: SecretValue[]): Promise<void> {
  for (const v of values) if (isSyncableSecret(v.scope)) await secrets.set(v.scope, v.name, v.value);
}

/** Copies this phone's existing secrets to iCloud Keychain (first run, or backup turned on). */
export async function copySecretsToCloud(refs: SecretRef[]): Promise<void> {
  if (!CloudBackup) return;
  for (const r of refs) {
    const k = secretKey(r.scope, r.name);
    const local = await SecureStore.getItemAsync(k, opts).catch(() => null);
    if (local) await CloudBackup.syncSecretSet(k, local);
  }
}

/** After a restore: keeps a local copy of each secret iCloud Keychain has; returns the ones it lacks. */
export async function pullSecretsFromCloud(refs: SecretRef[]): Promise<SecretRef[]> {
  const missing: SecretRef[] = [];
  for (const r of refs) {
    const v = await secrets.get(r.scope, r.name).catch(() => null);
    if (!v) missing.push(r);
  }
  return missing;
}

/** "Delete iCloud backup": removes every Sightline item from iCloud Keychain (local copies stay). */
export async function removeCloudSecrets(): Promise<void> {
  if (!CloudBackup) return;
  const accounts = await CloudBackup.syncSecretAccounts().catch(() => [] as string[]);
  for (const a of accounts) await CloudBackup.syncSecretRemove(a).catch(() => {});
}

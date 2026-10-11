import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import {
  AAD_MOVE,
  encodeMoveCode,
  makeBackupFile,
  MOVE_TTL_SEC,
  moveUrl,
  openBackupFile,
  openBundle,
  parseMoveCode,
  sealBundle,
  toHex,
  type Bundle,
} from '@/backup/bundle';
import { hasTransferSupport, nativeAead, nativeDeriveKey, randomBytes } from '@/backup/crypto-native';
import { applyBackup, buildBundle, markAllChanged, type RestoreResult } from '@/backup/restore';
import { tr } from '@/i18n';
import { CloudBackup } from '@modules/cloud-backup';
import { WgTunnel } from '@modules/wg-tunnel';

/**
 * Moving to another phone without iCloud.
 * - Wi-Fi transfer: the old phone encrypts everything with a one-time key, serves it once on
 *   the home Wi-Fi for 5 minutes, and shows a QR code with the address and the key. The key
 *   never goes over the network.
 * - Backup file: the same bundle, encrypted with a passcode the person picks, to AirDrop or
 *   save in Files.
 */

const UPDATE_APP = () => tr().settings.backupMsg.updateBoth;

export const transferSupported = () => hasTransferSupport() && !!CloudBackup;
export const fileBackupSupported = () => typeof WgTunnel?.deriveKey === 'function';

export interface OutgoingTransfer {
  /** data: URI of the QR code to show. */
  qr: string;
  expiresAt: number;
}

export async function startTransfer(): Promise<OutgoingTransfer> {
  if (!transferSupported()) throw new Error(UPDATE_APP());
  const key = randomBytes(32);
  const token = toHex(randomBytes(16));
  const sealed = await sealBundle(nativeAead, key, await buildBundle(), AAD_MOVE);
  const res = JSON.parse(await WgTunnel!.transferServe!(token, sealed, MOVE_TTL_SEC)) as { port: number; hosts: string[]; error?: string };
  if (res.error || !res.port) throw new Error(res.error ? tr().settings.backupMsg.startFailedWhy(res.error) : tr().settings.backupMsg.startFailed);
  const qr = await CloudBackup!.qrPng(encodeMoveCode({ hosts: res.hosts, port: res.port, token, key }));
  return { qr, expiresAt: Date.now() + MOVE_TTL_SEC * 1000 };
}

/** active = still waiting; served = the other phone picked it up. */
export function transferStatus(): { active: boolean; served: boolean } {
  try {
    return JSON.parse(WgTunnel?.transferStatus?.() ?? '{}') as { active: boolean; served: boolean };
  } catch {
    return { active: false, served: false };
  }
}

export function stopTransfer() {
  WgTunnel?.transferStop?.();
}

export const looksLikeTransferCode = (text: string) => !!parseMoveCode(text);

/** New phone: fetches and decrypts the bundle the QR code points to. */
export async function receiveTransfer(qrText: string): Promise<Bundle> {
  const code = parseMoveCode(qrText);
  if (!code) {
    throw new Error(tr().settings.backupMsg.notTransferCode);
  }
  if (!hasTransferSupport()) throw new Error(UPDATE_APP());
  let gone = false;
  for (const host of code.hosts) {
    const r = JSON.parse(await WgTunnel!.transferFetch!(moveUrl(code, host), 8000)) as { status: number; body: string; error?: string };
    if (r.status === 200 && r.body) return openBundle(nativeAead, code.key, r.body, AAD_MOVE);
    if (r.status === 404 || r.status === 410) gone = true;
  }
  throw new Error(
    gone
      ? tr().settings.backupMsg.codeUsed
      : tr().settings.backupMsg.cantReachOld,
  );
}

/** Applies a bundle from the other phone (Wi-Fi transfer or file). */
export async function applyBundle(bundle: Bundle): Promise<RestoreResult> {
  const result = await applyBackup(bundle.sections, bundle.secrets);
  // Back the moved settings up to this phone's iCloud as its own.
  markAllChanged();
  return result;
}

// ---------------------------------------------------------------------------
// Backup file

const exportDir = () => {
  const dir = new Directory(Paths.cache, 'backup-export');
  if (!dir.exists) dir.create();
  return dir;
};

/** Writes the passcode-protected backup and opens the share sheet (AirDrop, Files…). */
export async function exportBackupFile(passcode: string): Promise<void> {
  if (!fileBackupSupported()) throw new Error(UPDATE_APP());
  const text = await makeBackupFile(nativeAead, nativeDeriveKey, passcode, await buildBundle(), randomBytes(16));
  const day = new Date().toISOString().slice(0, 10);
  const file = new File(exportDir(), `${tr().settings.backupMsg.fileName(day)}.sightline`);
  if (file.exists) file.delete();
  file.create();
  file.write(text);
  try {
    await Sharing.shareAsync(file.uri, { mimeType: 'application/json', UTI: 'public.json', dialogTitle: tr().settings.backupMsg.saveDialog });
  } finally {
    // The share sheet has made its copy; don't leave one lying around in the cache.
    try {
      file.delete();
    } catch {}
  }
}

export async function readBackupFile(uri: string, passcode: string): Promise<Bundle> {
  if (!fileBackupSupported()) throw new Error(UPDATE_APP());
  const text = await new File(uri).text();
  return openBackupFile(nativeAead, nativeDeriveKey, passcode, text);
}

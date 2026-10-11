import type { SecretValue, Sections } from '@/backup/sections';

import { tr } from '../i18n/index.ts';

/**
 * Encrypted bundles for moving to another phone without iCloud: the one-time QR transfer
 * over home Wi-Fi, and the passcode-protected backup file. Pure (crypto is passed in) so the
 * format is covered by `npm test` with WebCrypto; the app uses expo-crypto (same AES-GCM).
 *
 * Sealed format: base64( iv[12] || ciphertext || tag[16] ), AES-256-GCM, with an
 * associated-data label so a transfer bundle can't be passed off as a backup file or vice versa.
 */

export interface Bundle {
  format: 'sightline-bundle';
  v: 1;
  createdAt: number;
  /** "Zach's iPhone", shown on the receiving phone. */
  from?: string;
  sections: Sections;
  secrets: SecretValue[];
}

export interface Aead {
  /** Returns iv || ciphertext || tag. */
  seal(key: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Promise<Uint8Array>;
  /** Throws when the key is wrong or the data was changed. */
  open(key: Uint8Array, sealed: Uint8Array, aad: Uint8Array): Promise<Uint8Array>;
}

/** PBKDF2-HMAC-SHA256 → 32-byte key. */
export type DeriveKey = (passcode: string, salt: Uint8Array, iterations: number) => Promise<Uint8Array>;

export const AAD_MOVE = 'sightline-move-v1';
export const AAD_FILE = 'sightline-file-v1';
export const MOVE_TTL_SEC = 5 * 60;
export const FILE_ITERATIONS = 600_000;
export const MIN_PASSCODE = 8;

export class BundleError extends Error {}

// ---------------------------------------------------------------------------
// Bytes helpers (Hermes-safe, no Buffer / TextEncoder dependency)

export function utf8Encode(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}

export function utf8Decode(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; ) {
    const c = b[i++];
    let cp: number;
    if (c < 0x80) cp = c;
    else if (c < 0xe0) cp = ((c & 31) << 6) | (b[i++] & 63);
    else if (c < 0xf0) cp = ((c & 15) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63);
    else cp = ((c & 7) << 18) | ((b[i++] & 63) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63);
    if (cp >= 0x10000) {
      cp -= 0x10000;
      s += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 1023));
    } else s += String.fromCharCode(cp);
  }
  return s;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function toBase64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    s += i + 1 < b.length ? B64[(n >> 6) & 63] : '=';
    s += i + 2 < b.length ? B64[n & 63] : '=';
  }
  return s;
}

export function fromBase64(s: string): Uint8Array {
  const clean = s.replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/]/g, '');
  const out: number[] = [];
  let buf = 0;
  let bits = 0;
  for (const ch of clean) {
    buf = (buf << 6) | B64.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 255);
    }
  }
  return Uint8Array.from(out);
}

export const toBase64Url = (b: Uint8Array) => toBase64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

// ---------------------------------------------------------------------------
// Bundle

export function makeBundle(sections: Sections, secrets: SecretValue[], from?: string, now = Date.now()): Bundle {
  return {
    format: 'sightline-bundle',
    v: 1,
    createdAt: now,
    ...(from ? { from } : {}),
    sections,
    secrets: secrets.filter((s) => s.value),
  };
}

export function parseBundle(json: string): Bundle {
  let b: Bundle;
  try {
    b = JSON.parse(json) as Bundle;
  } catch {
    throw new BundleError(tr().settings.backupMsg.notBackup);
  }
  if (!b || b.format !== 'sightline-bundle' || typeof b.sections !== 'object' || !b.sections) {
    throw new BundleError(tr().settings.backupMsg.notBackup);
  }
  if (b.v !== 1) throw new BundleError(tr().settings.backupMsg.newerVersion);
  const secrets = Array.isArray(b.secrets)
    ? b.secrets.filter((s) => s && typeof s.scope === 'string' && typeof s.name === 'string' && typeof s.value === 'string')
    : [];
  return { ...b, secrets };
}

export async function sealBundle(aead: Aead, key: Uint8Array, bundle: Bundle, aad: string): Promise<string> {
  return toBase64(await aead.seal(key, utf8Encode(JSON.stringify(bundle)), utf8Encode(aad)));
}

export async function openBundle(aead: Aead, key: Uint8Array, sealedB64: string, aad: string): Promise<Bundle> {
  let plain: Uint8Array;
  try {
    plain = await aead.open(key, fromBase64(sealedB64.trim()), utf8Encode(aad));
  } catch {
    throw new BundleError(aad === AAD_FILE ? tr().settings.backupMsg.passcodeMismatch : tr().settings.backupMsg.codeFailed);
  }
  return parseBundle(utf8Decode(plain));
}

// ---------------------------------------------------------------------------
// QR code for the Wi-Fi transfer

export interface MoveCode {
  hosts: string[];
  port: number;
  token: string;
  key: Uint8Array;
}

const MOVE_PREFIX = 'sightline-move:1?';

export function encodeMoveCode(c: MoveCode): string {
  return `${MOVE_PREFIX}h=${c.hosts.join(',')}&p=${c.port}&t=${c.token}&k=${toBase64Url(c.key)}`;
}

export function parseMoveCode(text: string): MoveCode | null {
  const t = text.trim();
  if (!t.startsWith(MOVE_PREFIX)) return null;
  const q: Record<string, string> = {};
  for (const part of t.slice(MOVE_PREFIX.length).split('&')) {
    const i = part.indexOf('=');
    if (i > 0) q[part.slice(0, i)] = part.slice(i + 1);
  }
  const hosts = (q.h ?? '').split(',').filter((h) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h));
  const port = Number(q.p);
  const key = fromBase64(q.k ?? '');
  if (!hosts.length || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  if (!/^[0-9a-f]{32,64}$/.test(q.t ?? '') || key.length !== 32) return null;
  return { hosts, port, token: q.t, key };
}

export const moveUrl = (c: MoveCode, host: string) => `http://${host}:${c.port}/move/${c.token}`;

// ---------------------------------------------------------------------------
// Passcode-protected backup file

export interface BackupFile {
  format: 'sightline-backup-file';
  v: 1;
  kdf: { name: 'PBKDF2-SHA256'; iterations: number; salt: string };
  data: string;
}

export function passcodeProblem(passcode: string): string | null {
  if (passcode.trim().length < MIN_PASSCODE) return tr().settings.backupMsg.atLeast(MIN_PASSCODE);
  return null;
}

export async function makeBackupFile(
  aead: Aead,
  derive: DeriveKey,
  passcode: string,
  bundle: Bundle,
  salt: Uint8Array,
  iterations = FILE_ITERATIONS,
): Promise<string> {
  const problem = passcodeProblem(passcode);
  if (problem) throw new BundleError(problem);
  const key = await derive(passcode, salt, iterations);
  const file: BackupFile = {
    format: 'sightline-backup-file',
    v: 1,
    kdf: { name: 'PBKDF2-SHA256', iterations, salt: toBase64(salt) },
    data: await sealBundle(aead, key, bundle, AAD_FILE),
  };
  return JSON.stringify(file);
}

export async function openBackupFile(aead: Aead, derive: DeriveKey, passcode: string, text: string): Promise<Bundle> {
  let f: BackupFile;
  try {
    f = JSON.parse(text) as BackupFile;
  } catch {
    throw new BundleError(tr().settings.backupMsg.notBackupFile);
  }
  if (!f || f.format !== 'sightline-backup-file' || f.kdf?.name !== 'PBKDF2-SHA256' || typeof f.data !== 'string') {
    throw new BundleError(tr().settings.backupMsg.notBackupFile);
  }
  if (f.v !== 1) throw new BundleError(tr().settings.backupMsg.newerVersion);
  const iterations = Math.min(Math.max(f.kdf.iterations | 0, 1), 10_000_000);
  const key = await derive(passcode, fromBase64(f.kdf.salt), iterations);
  return openBundle(aead, key, f.data, AAD_FILE);
}

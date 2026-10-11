/**
 * manifest.json for an evidence export: what's in the package, when and where it came from,
 * and the SHA-256 fingerprint of every file, so a changed file is detectable. Optionally
 * signed with this phone's key (manifest.sig + public-key.pem). Pure; unit-tested.
 */

import { isoWithOffset, type TimeWindow, type VideoMethod, type ZoneInfo } from './window.ts';

export const MANIFEST_FORMAT = 'sightline-export/1';

export type FileKind = 'video' | 'photo' | 'report' | 'info';

export interface ExportFile {
  /** Path inside the export folder, forward slashes ("video/Front Door 2026-10-11 0100.mp4"). */
  path: string;
  kind: FileKind;
  bytes: number;
  sha256: string;
  /** Camera name for video and photos. */
  camera?: string;
  /** Unix seconds the file covers (video) or shows (photo), when known. */
  start?: number;
  end?: number;
}

export interface CameraOutcome {
  name: string;
  system: string;
  method: VideoMethod;
  /** Whether video made it into the export. */
  video: 'included' | 'partial' | 'none';
  /** Plain-language note ("Recorded from the recorder's replay", "Couldn't reach it"). */
  note?: string;
  events: number;
}

export interface ExportEvent {
  camera: string;
  start: number;
  end: number | null;
  /** "Person", "Car", "Doorbell"… */
  what: string;
  /** Snapshot file in the export, if one was saved. */
  photo?: string;
}

export interface ExportMeta {
  createdAt: number;
  zone: ZoneInfo;
  window: TimeWindow;
  appVersion: string;
  device: string;
  systems: string[];
}

export interface Manifest {
  format: string;
  createdAt: string;
  app: { name: string; version: string };
  device: string;
  systems: string[];
  window: { start: string; end: string; startUnix: number; endUnix: number; timeZone: string };
  cameras: CameraOutcome[];
  events: { camera: string; start: string; end: string | null; what: string; photo?: string }[];
  files: { path: string; kind: FileKind; bytes: number; sha256: string; camera?: string; start?: string; end?: string }[];
  signature: { algorithm: string; publicKey: string; signatureFile: string; publicKeyFingerprint: string } | null;
  howToCheck: string;
}

export const SIGNATURE_FILE = 'manifest.sig';
export const PUBLIC_KEY_FILE = 'public-key.pem';

export function buildManifest(
  meta: ExportMeta,
  cameras: CameraOutcome[],
  events: ExportEvent[],
  files: ExportFile[],
  signer: { publicKeyFingerprint: string } | null,
): Manifest {
  const iso = (t: number) => isoWithOffset(t, meta.zone.offsetMin);
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  return {
    format: MANIFEST_FORMAT,
    createdAt: iso(meta.createdAt),
    app: { name: 'Sightline', version: meta.appVersion },
    device: meta.device,
    systems: meta.systems,
    window: {
      start: iso(meta.window.start),
      end: iso(meta.window.end),
      startUnix: meta.window.start,
      endUnix: meta.window.end,
      timeZone: meta.zone.timeZone,
    },
    cameras,
    events: [...events]
      .sort((a, b) => a.start - b.start)
      .map((e) => ({ camera: e.camera, start: iso(e.start), end: e.end == null ? null : iso(e.end), what: e.what, ...(e.photo ? { photo: e.photo } : {}) })),
    files: sorted.map((f) => ({
      path: f.path,
      kind: f.kind,
      bytes: f.bytes,
      sha256: f.sha256,
      ...(f.camera ? { camera: f.camera } : {}),
      ...(f.start != null ? { start: iso(f.start) } : {}),
      ...(f.end != null ? { end: iso(f.end) } : {}),
    })),
    signature: signer
      ? { algorithm: 'ECDSA P-256 with SHA-256', publicKey: PUBLIC_KEY_FILE, signatureFile: SIGNATURE_FILE, publicKeyFingerprint: signer.publicKeyFingerprint }
      : null,
    howToCheck: signer
      ? `sha256sum each file and compare with "files". Check the signature: openssl dgst -sha256 -verify ${PUBLIC_KEY_FILE} -signature ${SIGNATURE_FILE} manifest.json`
      : 'sha256sum each file and compare with "files".',
  };
}

/** The exact text written to manifest.json (and signed). */
export function manifestJson(m: Manifest): string {
  return `${JSON.stringify(m, null, 2)}\n`;
}

/** Files whose fingerprint doesn't match the manifest (for "Check an export" and tests). */
export function mismatches(m: Pick<Manifest, 'files'>, actual: Record<string, string>): string[] {
  return m.files.filter((f) => actual[f.path]?.toLowerCase() !== f.sha256.toLowerCase()).map((f) => f.path);
}

/** A safe file name piece: letters, digits, spaces, dashes. */
export function safeName(s: string): string {
  return s.replace(/[^\p{L}\p{N} _-]+/gu, '_').replace(/\s+/g, ' ').trim().slice(0, 60) || 'camera';
}

/** "Front Door 2026-10-11 0100" in local time (offset), for file names. */
export function fileStamp(camera: string, unixSec: number, offsetMin: number): string {
  const iso = isoWithOffset(unixSec, offsetMin);
  return `${safeName(camera)} ${iso.slice(0, 10)} ${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`;
}

/** Makes names unique within a folder ("a.mp4", "a (2).mp4"). */
export function uniquePath(path: string, taken: Set<string>): string {
  if (!taken.has(path)) {
    taken.add(path);
    return path;
  }
  const dot = path.lastIndexOf('.');
  const base = dot > path.lastIndexOf('/') ? path.slice(0, dot) : path;
  const ext = dot > path.lastIndexOf('/') ? path.slice(dot) : '';
  for (let i = 2; ; i++) {
    const p = `${base} (${i})${ext}`;
    if (!taken.has(p)) {
      taken.add(p);
      return p;
    }
  }
}

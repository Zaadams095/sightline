import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { Directory, File, FileMode, Paths } from 'expo-file-system';
import * as Print from 'expo-print';
import * as SecureStore from 'expo-secure-store';
import * as Sharing from 'expo-sharing';

import { tr } from '@/i18n';
import { ensureTunnel } from '@/net/connection';
import type { CameraEntry } from '@/systems/registry';
import type { CameraSystemAdapter, PlaybackSource, ReviewItem } from '@/systems/types';
import { titleFor } from '@/util/format';
import { WgTunnel } from '@modules/wg-tunnel';

import { crc32, Sha256, sha256Hex } from './hash.ts';
import {
  buildManifest,
  fileStamp,
  manifestJson,
  PUBLIC_KEY_FILE,
  SIGNATURE_FILE,
  uniquePath,
  type CameraOutcome,
  type ExportEvent,
  type ExportFile,
  type ExportMeta,
} from './manifest.ts';
import { clipPieces, CLIP_PIECE_SEC, exportFolderName, fileAnchors } from './plan.ts';
import { renderReport, type ReportEvent } from './report-html.ts';
import { clampToNow, type TimeWindow, type VideoMethod, type ZoneInfo } from './window.ts';
import { writeZip, ZIP_MAX_BYTES } from './zip.ts';

/**
 * "Export for police or insurance": gathers every chosen camera's video for a time window (the
 * best way each recorder offers), the events and their snapshots, then writes a PDF summary
 * and a manifest of SHA-256 fingerprints (signed with this phone's key when the app can),
 * packs it all into one .zip and opens the share sheet.
 */

const KEY_NAME = 'export-signing-key';
const CONCURRENCY = 3;

export class ExportCancelled extends Error {
  constructor() {
    super('Export cancelled.');
  }
}

export interface ExportProgress {
  /** 0–1 overall. */
  fraction: number;
  /** "Copying video from Front Door…" */
  label: string;
  bytes: number;
}

export interface ExportResult {
  zipUri: string;
  bytes: number;
  cameras: CameraOutcome[];
  signed: boolean;
}

const plainPath = (uri: string) => decodeURIComponent(uri.replace(/^file:\/\//, ''));

function zoneNow(at: number): ZoneInfo {
  let timeZone = '';
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  } catch {}
  return { timeZone, offsetMin: -new Date(at * 1000).getTimezoneOffset() };
}

function deviceText(): string {
  const model = Device.modelName ?? 'iPhone';
  return `${model}${Device.osVersion ? ` (${Device.osName ?? 'iOS'} ${Device.osVersion})` : ''}`;
}

export function appVersion(): string {
  return Constants.expoConfig?.version ?? 'unknown';
}

function check(signal: AbortSignal) {
  if (signal.aborted) throw new ExportCancelled();
}

// ---------------------------------------------------------------------------------------------
// Choosing how to get each camera's video

/**
 * How this camera's video can be exported, asking the recorder when needed (a replay stream
 * vs. downloadable files can only be told apart by asking for playback).
 */
export async function probeMethod(adapter: CameraSystemAdapter, cameraId: string, w: TimeWindow): Promise<VideoMethod> {
  if (adapter.clip) {
    const uri = adapter.clip(cameraId, w.start, Math.min(w.end, w.start + CLIP_PIECE_SEC)).uri;
    if (uri) return 'clip';
  }
  if (!adapter.playback) return 'none';
  try {
    return methodOf(await adapter.playback(cameraId, w.start, w.end));
  } catch {
    // No recording right at the start; a later moment may still have files. Ask about the
    // whole window's segments instead.
    const segs = await adapter.recordingSegments?.(cameraId, w.start, w.end).catch(() => []);
    if (!segs?.length) return 'none';
    try {
      return methodOf(await adapter.playback(cameraId, Math.max(w.start, segs[0].start), w.end));
    } catch {
      return 'none';
    }
  }
}

function methodOf(pb: PlaybackSource): VideoMethod {
  if (pb.kind !== 'stream') return 'none'; // seekable HLS only (no downloadable file)
  if (pb.source.kind === 'file') return 'files';
  if (pb.source.kind === 'rtsp') return WgTunnel?.startRecording ? 'replay' : 'none';
  return 'none';
}

/** Why a method gives no video, in plain words. */
export function methodNote(m: VideoMethod): string | undefined {
  const t = tr().exporting.run;
  if (m === 'replay') return WgTunnel?.startRecording ? t.noteReplay : undefined;
  if (m === 'files') return t.noteFiles;
  if (m === 'none') return t.noteNone;
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Files

async function download(
  uri: string,
  headers: Record<string, string> | undefined,
  dest: File,
  signal: AbortSignal,
  onBytes: (written: number, total: number) => void,
): Promise<File> {
  if (dest.exists) dest.delete();
  return File.downloadFileAsync(uri, dest, { headers, signal, onProgress: (p) => onBytes(p.bytesWritten, p.totalBytes) });
}

/** SHA-256 (and CRC-32 when packing in JS) of a file, streaming. */
async function fingerprint(f: File, wantCrc: boolean): Promise<{ sha256: string; crc: number; bytes: number }> {
  const bytes = f.size ?? 0;
  if (!wantCrc && WgTunnel?.sha256File) {
    return { sha256: await WgTunnel.sha256File(plainPath(f.uri)), crc: 0, bytes };
  }
  const h = new Sha256();
  let crc = 0;
  const handle = f.open(FileMode.ReadOnly);
  try {
    for (;;) {
      const chunk = handle.readBytes(1 << 20);
      if (!chunk.length) break;
      h.update(chunk);
      if (wantCrc) crc = crc32(chunk, crc);
      // Let the UI breathe between megabytes.
      await new Promise((r) => setTimeout(r, 0));
    }
  } finally {
    handle.close();
  }
  return { sha256: h.hex(), crc, bytes };
}

function ensureDir(d: Directory): Directory {
  if (!d.exists) d.create({ intermediates: true });
  return d;
}

function writeText(dir: Directory, name: string, text: string): File {
  const f = new File(dir, name);
  if (f.exists) f.delete();
  f.create();
  f.write(text);
  return f;
}

/** Every file under a directory, with its path relative to it. */
function walk(dir: Directory, prefix = ''): { file: File; path: string }[] {
  const out: { file: File; path: string }[] = [];
  for (const item of dir.list()) {
    if (item instanceof Directory) out.push(...walk(item, `${prefix}${item.name}/`));
    else out.push({ file: item, path: `${prefix}${item.name}` });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Signing (P-256 key kept in this phone's Keychain, never synced or backed up)

async function signer(): Promise<{ key: string; pem: string; fingerprint: string } | null> {
  const t = WgTunnel;
  if (!t?.newSigningKey || !t.signingPublicKey || !t.signFile) return null;
  try {
    let key = await SecureStore.getItemAsync(KEY_NAME);
    if (!key) {
      key = await t.newSigningKey();
      await SecureStore.setItemAsync(KEY_NAME, key, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
    }
    const pem = await t.signingPublicKey(key);
    const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
    const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return { key, pem, fingerprint: sha256Hex(der) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// The export

export interface CameraJob {
  entry: CameraEntry;
  method: VideoMethod;
}

interface Gathered {
  key: string;
  outcome: CameraOutcome;
  events: ExportEvent[];
  thumbs: Map<ExportEvent, File>;
  files: { file: File; path: string; start?: number; end?: number }[];
}

export async function runExport(opts: {
  jobs: CameraJob[];
  window: TimeWindow;
  signal: AbortSignal;
  onProgress: (p: ExportProgress) => void;
}): Promise<ExportResult> {
  const { signal } = opts;
  const createdAt = Math.floor(Date.now() / 1000);
  const w = clampToNow(opts.window, createdAt);
  const zone = zoneNow(w.start);
  const folderName = exportFolderName(createdAt, zone.offsetMin);
  const root = ensureDir(new Directory(Paths.cache, 'exports', String(createdAt)));
  const dir = ensureDir(new Directory(root, folderName));
  const videoDir = ensureDir(new Directory(dir, 'video'));
  const photoDir = ensureDir(new Directory(dir, 'photos'));
  const taken = new Set<string>();

  // Progress: every camera reports 0–1; packing is the last 10%.
  const parts = new Map<string, number>();
  let bytes = 0;
  let label = tr().exporting.screen.gettingReady;
  const report = (extra = 0) => {
    const cams = opts.jobs.length || 1;
    const sum = [...parts.values()].reduce((a, b) => a + b, 0);
    opts.onProgress({ fraction: Math.min(1, (sum / cams) * 0.9 + extra), label, bytes });
  };

  const cleanup = () => {
    try {
      if (root.exists) root.delete();
    } catch {}
  };

  try {
    const gathered: Gathered[] = [];
    let next = 0;
    const worker = async () => {
      while (next < opts.jobs.length) {
        const job = opts.jobs[next++];
        check(signal);
        gathered.push(await gatherCamera(job, w, zone, { videoDir, photoDir, taken, signal }, (f, b) => {
          parts.set(job.entry.camera.key, f);
          if (b) bytes += b;
          label = tr().exporting.run.copying(job.entry.camera.name);
          report();
        }));
        parts.set(job.entry.camera.key, 1);
        report();
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, opts.jobs.length) }, worker));
    check(signal);

    // Order the summary like the user's camera list.
    const order = new Map(opts.jobs.map((j, i) => [j.entry.camera.key, i]));
    gathered.sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));

    label = tr().exporting.run.fingerprints;
    report(0.02);
    const packInJs = !WgTunnel?.zipFolder;
    const crcs = new Map<string, number>();
    const files: ExportFile[] = [];
    const thumbPathOf = new Map<File, string>();
    for (const g of gathered) {
      for (const f of g.files) {
        check(signal);
        const fp = await fingerprint(f.file, packInJs);
        crcs.set(f.path, fp.crc);
        files.push({ path: f.path, kind: 'video', bytes: fp.bytes, sha256: fp.sha256, camera: g.outcome.name, start: f.start, end: f.end });
      }
      for (const [ev, file] of g.thumbs) {
        check(signal);
        const path = ev.photo!;
        thumbPathOf.set(file, path);
        const fp = await fingerprint(file, packInJs);
        crcs.set(path, fp.crc);
        files.push({ path, kind: 'photo', bytes: fp.bytes, sha256: fp.sha256, camera: g.outcome.name, start: ev.start });
      }
    }

    const meta: ExportMeta = {
      createdAt,
      zone,
      window: w,
      appVersion: appVersion(),
      device: deviceText(),
      systems: [...new Set(opts.jobs.map((j) => j.entry.adapter.config.name))],
    };
    const cameras = gathered.map((g) => g.outcome);
    const events = gathered.flatMap((g) => g.events);
    const sign = await signer();

    // PDF summary (thumbnails embedded so the PDF stands on its own).
    label = tr().exporting.run.writingSummary;
    report(0.04);
    const reportEvents: ReportEvent[] = [];
    for (const g of gathered) {
      for (const ev of g.events) {
        const file = g.thumbs.get(ev);
        let thumb: string | undefined;
        if (file && reportEvents.filter((e) => e.thumb).length < 200) {
          try {
            thumb = `data:image/jpeg;base64,${await file.base64()}`;
          } catch {}
        }
        reportEvents.push({ ...ev, thumb });
      }
    }
    const html = renderReport({ meta, cameras, events: reportEvents, files, signer: sign ? { publicKeyFingerprint: sign.fingerprint } : null });
    const printed = await Print.printToFileAsync({ html, width: 612, height: 792 });
    const pdf = new File(dir, 'Summary.pdf');
    if (pdf.exists) pdf.delete();
    await new File(printed.uri).move(pdf);
    const pdfFp = await fingerprint(pdf, packInJs);
    crcs.set('Summary.pdf', pdfFp.crc);
    files.push({ path: 'Summary.pdf', kind: 'report', bytes: pdfFp.bytes, sha256: pdfFp.sha256 });

    const readme = writeText(dir, 'READ ME.txt', readmeText(!!sign));
    const readmeFp = await fingerprint(readme, packInJs);
    crcs.set('READ ME.txt', readmeFp.crc);
    files.push({ path: 'READ ME.txt', kind: 'info', bytes: readmeFp.bytes, sha256: readmeFp.sha256 });

    // Manifest, then its signature.
    const manifest = buildManifest(meta, cameras, events, files, sign ? { publicKeyFingerprint: sign.fingerprint } : null);
    const manifestFile = writeText(dir, 'manifest.json', manifestJson(manifest));
    if (sign) {
      writeText(dir, PUBLIC_KEY_FILE, sign.pem);
      try {
        await WgTunnel!.signFile!(sign.key, plainPath(manifestFile.uri), plainPath(new File(dir, SIGNATURE_FILE).uri));
      } catch {
        // Without a signature the fingerprints still work; the PDF already explains signing,
        // so remove the half-written pieces rather than ship a key with no signature.
        new File(dir, PUBLIC_KEY_FILE).delete();
      }
    }
    check(signal);

    // Pack.
    label = tr().exporting.run.packing;
    report(0.07);
    const zip = new File(root, `${folderName}.zip`);
    if (zip.exists) zip.delete();
    if (WgTunnel?.zipFolder) {
      await WgTunnel.zipFolder(plainPath(dir.uri), plainPath(zip.uri), folderName);
    } else {
      await packInJsZip(dir, zip, folderName, crcs, signal);
    }
    check(signal);
    label = tr().common.done;
    report(0.1);
    return { zipUri: zip.uri, bytes: zip.size ?? bytes, cameras, signed: !!sign && new File(dir, SIGNATURE_FILE).exists };
  } catch (e) {
    cleanup();
    if (signal.aborted) throw new ExportCancelled();
    throw e;
  }
}

async function packInJsZip(dir: Directory, zip: File, folderName: string, crcs: Map<string, number>, signal: AbortSignal) {
  const all = walk(dir);
  const total = all.reduce((a, f) => a + (f.file.size ?? 0), 0);
  if (total > ZIP_MAX_BYTES) throw new Error(tr().exporting.run.tooBig);
  // Files hashed without a CRC (manifest, signature, key) get theirs now.
  for (const f of all) {
    if (!crcs.has(f.path)) crcs.set(f.path, (await fingerprint(f.file, true)).crc);
  }
  zip.create();
  const out = zip.open(FileMode.WriteOnly);
  try {
    const sink = { write: (b: Uint8Array) => out.writeBytes(b) };
    const now = new Date();
    await writeZip(
      all.map((f) => ({ name: `${folderName}/${f.path}`, size: f.file.size ?? 0, crc: crcs.get(f.path) ?? 0, date: now })),
      sink,
      async (i) => {
        const h = all[i].file.open(FileMode.ReadOnly);
        try {
          for (;;) {
            check(signal);
            const chunk = h.readBytes(1 << 20);
            if (!chunk.length) break;
            out.writeBytes(chunk);
            await new Promise((r) => setTimeout(r, 0));
          }
        } finally {
          h.close();
        }
      },
    );
  } finally {
    out.close();
  }
}

function readmeText(signed: boolean): string {
  const t = tr().exporting.readme;
  return [
    t.intro,
    '',
    `Summary.pdf      ${t.summary}`,
    `video/           ${t.video}`,
    `photos/          ${t.photos}`,
    `manifest.json    ${t.manifest}`,
    ...(signed
      ? [
          `${SIGNATURE_FILE}     ${t.signature}`,
          `${PUBLIC_KEY_FILE}   ${t.publicKey}`,
          '',
          t.checkSignature,
          `  openssl dgst -sha256 -verify ${PUBLIC_KEY_FILE} -signature ${SIGNATURE_FILE} manifest.json`,
        ]
      : []),
    '',
    t.checkFile,
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------
// One camera

async function gatherCamera(
  job: CameraJob,
  w: TimeWindow,
  zone: ZoneInfo,
  ctx: { videoDir: Directory; photoDir: Directory; taken: Set<string>; signal: AbortSignal },
  progress: (fraction: number, newBytes?: number) => void,
): Promise<Gathered> {
  const { camera, adapter } = job.entry;
  const outcome: CameraOutcome = { name: camera.name, system: adapter.config.name, method: job.method, video: 'none', events: 0 };
  const files: Gathered['files'] = [];
  const thumbs = new Map<ExportEvent, File>();

  // Events and their snapshots (every brand that reports events).
  let items: ReviewItem[] = [];
  if (adapter.listReview) {
    items = await adapter.listReview({ cameras: [camera.id], after: w.start, before: w.end, limit: 500 }).catch(() => []);
    items = items.filter((i) => i.cameraId === camera.id && i.startTime < w.end && (i.endTime ?? i.startTime) >= w.start);
  }
  const events: ExportEvent[] = items.map((i) => ({ camera: camera.name, start: i.startTime, end: i.endTime, what: titleFor(i) }));
  outcome.events = events.length;
  for (let i = 0; i < items.length; i++) {
    check(ctx.signal);
    const uri = items[i].thumbnailUrl;
    if (!uri) continue;
    const path = uniquePath(`photos/${fileStamp(camera.name, items[i].startTime, zone.offsetMin)}.jpg`, ctx.taken);
    try {
      const f = await download(uri, undefined, new File(ctx.photoDir, path.slice('photos/'.length)), ctx.signal, () => {});
      events[i].photo = path;
      thumbs.set(events[i], f);
    } catch {
      if (ctx.signal.aborted) throw new ExportCancelled();
    }
  }
  progress(0.1);

  const segments = adapter.recordingSegments ? await adapter.recordingSegments(camera.id, w.start, w.end).catch(() => null) : null;
  let failures = 0;
  let attempts = 0;
  const addVideo = (f: File, path: string, start?: number, end?: number) => {
    files.push({ file: f, path, start, end });
  };

  try {
    if (job.method === 'clip' && adapter.clip) {
      const pieces = clipPieces(w, segments);
      for (let p = 0; p < pieces.length; p++) {
        check(ctx.signal);
        const [s, e] = pieces[p];
        const src = adapter.clip(camera.id, s, e);
        if (!src.uri) continue;
        attempts++;
        const path = uniquePath(`video/${fileStamp(camera.name, s, zone.offsetMin)}.mp4`, ctx.taken);
        let last = 0;
        try {
          const f = await download(src.uri, src.headers, new File(ctx.videoDir, path.slice('video/'.length)), ctx.signal, (written, total) => {
            progress(0.1 + 0.9 * ((p + (total > 0 ? written / total : 0)) / pieces.length), written - last);
            last = written;
          });
          if ((f.size ?? 0) > 1024) addVideo(f, path, s, e);
          else {
            f.delete();
            failures++;
          }
        } catch (err) {
          if (ctx.signal.aborted) throw new ExportCancelled();
          failures++;
          void err;
        }
      }
    } else if (job.method === 'files' && adapter.playback) {
      const seen = new Set<string>();
      const anchors = fileAnchors(w, segments, items.map((i) => i.startTime));
      for (let a = 0; a < anchors.length; a++) {
        check(ctx.signal);
        let pb: PlaybackSource;
        try {
          pb = await adapter.playback(camera.id, anchors[a], w.end);
        } catch {
          continue;
        }
        if (pb.kind !== 'stream' || pb.source.kind !== 'file' || seen.has(pb.source.uri)) continue;
        seen.add(pb.source.uri);
        attempts++;
        const startsAt = pb.source.startTime ?? anchors[a];
        const path = uniquePath(`video/${fileStamp(camera.name, startsAt, zone.offsetMin)}.mp4`, ctx.taken);
        let last = 0;
        try {
          const f = await download(pb.source.uri, undefined, new File(ctx.videoDir, path.slice('video/'.length)), ctx.signal, (written, total) => {
            progress(0.1 + 0.9 * ((a + (total > 0 ? written / total : 0)) / anchors.length), written - last);
            last = written;
          });
          if ((f.size ?? 0) > 1024) addVideo(f, path, startsAt);
          else {
            f.delete();
            failures++;
          }
        } catch {
          if (ctx.signal.aborted) throw new ExportCancelled();
          failures++;
        }
      }
    } else if (job.method === 'replay' && adapter.playback && WgTunnel?.startRecording) {
      const pb = await adapter.playback(camera.id, w.start, w.end);
      if (pb.kind === 'stream' && pb.source.kind === 'rtsp') {
        attempts++;
        const path = uniquePath(`video/${fileStamp(camera.name, w.start, zone.offsetMin)}.mp4`, ctx.taken);
        const dest = new File(ctx.videoDir, path.slice('video/'.length));
        const ok = await recordReplay(pb.source.url, job.entry.adapter, dest, w.end - w.start, ctx.signal, (f, b) => progress(0.1 + 0.9 * f, b));
        if (ok) addVideo(dest, path, w.start, w.end);
        else failures++;
      }
    }
  } catch (e) {
    if (e instanceof ExportCancelled || ctx.signal.aborted) throw new ExportCancelled();
    failures++;
    outcome.note = e instanceof Error ? e.message : String(e);
  }

  if (files.length) outcome.video = failures ? 'partial' : 'included';
  if (!outcome.note) {
    if (files.length) outcome.note = methodNote(job.method);
    else if (job.method === 'none') outcome.note = methodNote('none');
    else if (attempts === 0) outcome.note = tr().exporting.screen.noRecordings;
    else outcome.note = tr().exporting.run.noteNoVideo;
  }
  if (outcome.video !== 'included' && files.length && failures) outcome.note = tr().exporting.run.someParts(outcome.note ?? '').trim();
  return { key: camera.key, outcome, events, thumbs, files };
}

/** Records a recorder's RTSP replay on the phone (real time). Resolves true when a file was made. */
async function recordReplay(
  url: string,
  adapter: CameraSystemAdapter,
  dest: File,
  seconds: number,
  signal: AbortSignal,
  progress: (fraction: number, newBytes: number) => void,
): Promise<boolean> {
  const t = WgTunnel!;
  const u = new URL(url.replace(/^rtsps?:/, 'http:'));
  const hostPort = `${u.hostname}:${u.port || '554'}`;
  let viaTunnel = false;
  if (!(await t.probe(hostPort, false, 1500))) {
    if (!adapter.config.endpoint.useTunnel) throw new Error(tr().exporting.run.unreachable);
    await ensureTunnel();
    viaTunnel = true;
  }
  if (dest.exists) dest.delete();
  const id = await t.startRecording!(url, viaTunnel, plainPath(dest.uri), Math.ceil(seconds) + 5);
  let last = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new ExportCancelled();
      await new Promise((r) => setTimeout(r, 1000));
      const st = JSON.parse(t.recordingStatus!(id)) as { bytes: number; seconds: number; done: boolean; error?: string };
      progress(Math.min(1, st.seconds / Math.max(1, seconds)), st.bytes - last);
      last = st.bytes;
      if (st.done) {
        if (st.error && st.bytes === 0) throw new Error(st.error);
        return st.bytes > 1024;
      }
    }
  } finally {
    await t.stopRecording!(id).catch(() => {});
  }
}

export async function shareExport(zipUri: string) {
  await Sharing.shareAsync(zipUri, { mimeType: 'application/zip', UTI: 'public.zip-archive', dialogTitle: tr().exporting.run.shareTitle });
}

/** Removes old exports (they can be large). Keeps the newest hour's in case sharing is retried. */
export function pruneExports() {
  try {
    const dir = new Directory(Paths.cache, 'exports');
    if (!dir.exists) return;
    const cutoff = Date.now() / 1000 - 3600;
    for (const d of dir.list()) if (d instanceof Directory && Number(d.name) < cutoff) d.delete();
  } catch {}
}

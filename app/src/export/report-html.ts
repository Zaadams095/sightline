/**
 * The PDF summary of an evidence export, as HTML for expo-print. Written for whoever receives
 * it (a police officer, an insurance adjuster): plain words, times with their time zone, and
 * every file's fingerprint. Pure; unit-tested.
 */

import { shortFingerprint } from './hash.ts';
import type { CameraOutcome, ExportEvent, ExportFile, ExportMeta } from './manifest.ts';
import { PUBLIC_KEY_FILE, SIGNATURE_FILE } from './manifest.ts';
import { describeWindow, durationText, friendlyTime, isoWithOffset, sizeText } from './window.ts';

export interface ReportEvent extends ExportEvent {
  /** data: URI of a small JPEG for the report (optional). */
  thumb?: string;
}

export interface ReportData {
  meta: ExportMeta;
  cameras: CameraOutcome[];
  events: ReportEvent[];
  /** Files already in the export (the report itself is listed in manifest.json). */
  files: ExportFile[];
  signer: { publicKeyFingerprint: string } | null;
  /** Events listed at most (the rest are counted). Default 200. */
  maxEvents?: number;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const VIDEO_TEXT: Record<CameraOutcome['video'], string> = {
  included: 'Video included',
  partial: 'Some video included',
  none: 'No video — snapshots only',
};

export function renderReport(d: ReportData): string {
  const e = escapeHtml;
  const off = d.meta.zone.offsetMin;
  const when = (t: number) => friendlyTime(t, off);
  const systems = d.meta.systems.length ? d.meta.systems.join(', ') : 'Home cameras';
  const missing = d.cameras.filter((c) => c.video === 'none');
  const max = d.maxEvents ?? 200;
  const events = [...d.events].sort((a, b) => a.start - b.start);
  const shown = events.slice(0, max);

  const cameraRows = d.cameras
    .map(
      (c) =>
        `<tr><td>${e(c.name)}</td><td>${e(c.system)}</td><td>${e(VIDEO_TEXT[c.video])}</td><td>${c.events}</td><td>${e(c.note ?? '')}</td></tr>`,
    )
    .join('');

  const eventRows = shown
    .map(
      (ev) => `<tr>
  <td class="thumb">${ev.thumb ? `<img src="${e(ev.thumb)}" alt="">` : ''}</td>
  <td>${e(when(ev.start))}${ev.end ? `<br><span class="muted">until ${e(friendlyTime(ev.end, off))}</span>` : ''}</td>
  <td>${e(ev.camera)}</td>
  <td>${e(ev.what)}${ev.photo ? `<br><span class="muted">${e(ev.photo)}</span>` : ''}</td>
</tr>`,
    )
    .join('');

  const fileRows = [...d.files]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map(
      (f) =>
        `<tr><td>${e(f.path)}${f.start != null ? `<br><span class="muted">${e(when(f.start))}${f.end != null ? ` – ${e(when(f.end))}` : ''}</span>` : ''}</td><td class="num">${e(sizeText(f.bytes))}</td><td class="hash">${e(f.sha256)}</td></tr>`,
    )
    .join('');

  const signed = d.signer
    ? `<p>The list of fingerprints (<b>manifest.json</b>) is also <b>signed</b> with a key that never leaves the iPhone that made this export.
The signature is in <b>${SIGNATURE_FILE}</b> and the matching public key in <b>${PUBLIC_KEY_FILE}</b>
(key fingerprint <span class="mono">${e(shortFingerprint(d.signer.publicKeyFingerprint))}</span>).
If the list is edited, the signature no longer checks out. To check it:</p>
<p class="mono small">openssl dgst -sha256 -verify ${PUBLIC_KEY_FILE} -signature ${SIGNATURE_FILE} manifest.json</p>`
    : `<p>This export isn’t signed (the app version that made it couldn’t sign), but the fingerprints below still show whether any file was changed.</p>`;

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Video export</title>
<style>
  @page { margin: 18mm 14mm; }
  body { font-family: -apple-system, Helvetica, Arial, sans-serif; color: #111; font-size: 11pt; line-height: 1.4; }
  h1 { font-size: 20pt; margin: 0 0 4pt; }
  h2 { font-size: 13pt; margin: 18pt 0 6pt; border-bottom: 1px solid #ccc; padding-bottom: 3pt; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; vertical-align: top; padding: 4pt 6pt; border-bottom: 1px solid #e3e3e3; }
  th { font-size: 9pt; text-transform: uppercase; color: #555; }
  tr { page-break-inside: avoid; }
  .muted { color: #666; font-size: 9pt; }
  .mono, .hash { font-family: Menlo, Courier, monospace; }
  .hash { font-size: 7.5pt; word-break: break-all; width: 46%; }
  .small { font-size: 9pt; }
  .num { white-space: nowrap; }
  .thumb { width: 110px; }
  .thumb img { width: 100px; border-radius: 4px; }
  .facts td:first-child { width: 30%; color: #555; }
  .note { background: #fff6e0; border: 1px solid #f0d48a; padding: 8pt; border-radius: 6px; }
</style></head>
<body>
<h1>Video export</h1>
<div class="muted">${e(systems)}</div>

<h2>Summary</h2>
<table class="facts">
  <tr><td>Time covered</td><td>${e(describeWindow(d.meta.window, d.meta.zone))}<br><span class="muted">${e(durationText(d.meta.window.end - d.meta.window.start))} · ${e(isoWithOffset(d.meta.window.start, off))} to ${e(isoWithOffset(d.meta.window.end, off))}</span></td></tr>
  <tr><td>Cameras</td><td>${d.cameras.length}</td></tr>
  <tr><td>Events in this time</td><td>${events.length}</td></tr>
  <tr><td>Exported</td><td>${e(when(d.meta.createdAt))}</td></tr>
  <tr><td>Made with</td><td>Sightline ${e(d.meta.appVersion)} on ${e(d.meta.device)}</td></tr>
</table>
${
  missing.length
    ? `<p class="note">These cameras couldn’t export video for this time, so only their event snapshots are included: ${missing.map((c) => e(c.name)).join(', ')}.</p>`
    : ''
}

<h2>Cameras</h2>
<table><tr><th>Camera</th><th>System</th><th>Video</th><th>Events</th><th>Notes</th></tr>${cameraRows}</table>

<h2>Events</h2>
${
  shown.length
    ? `<table><tr><th></th><th>Time</th><th>Camera</th><th>What</th></tr>${eventRows}</table>${
        events.length > shown.length ? `<p class="muted">…and ${events.length - shown.length} more, listed in manifest.json.</p>` : ''
      }`
    : '<p>No events were recorded in this time.</p>'
}

<h2>How to tell nothing was changed</h2>
<p>Every file in this export has a <b>fingerprint</b> (SHA-256), listed below and in <b>manifest.json</b>.
A fingerprint is calculated from every byte of the file: <b>if any file is changed, even by one frame, its fingerprint won’t match.</b>
This report’s own fingerprint is in manifest.json.</p>
${signed}

<h2>Files and fingerprints</h2>
<table><tr><th>File</th><th>Size</th><th>SHA-256</th></tr>${fileRows}</table>

<p class="muted" style="margin-top:18pt">Times are shown in ${e(d.meta.zone.timeZone || 'the phone’s time zone')} (UTC${e(isoWithOffset(d.meta.window.start, off).slice(19))}). Camera clocks can drift from true time by a few seconds.</p>
</body></html>`;
}

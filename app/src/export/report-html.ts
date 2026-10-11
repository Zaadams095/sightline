/**
 * The PDF summary of an evidence export, as HTML for expo-print. Written for whoever receives
 * it (a police officer, an insurance adjuster): plain words, times with their time zone, and
 * every file's fingerprint. Pure; unit-tested.
 */

import { tr } from '../i18n/index.ts';
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

function videoText(v: CameraOutcome['video']): string {
  const r = tr().exporting.report;
  return v === 'included' ? r.videoIncluded : v === 'partial' ? r.videoPartial : r.videoNone;
}

export function renderReport(d: ReportData): string {
  const e = escapeHtml;
  const r = tr().exporting.report;
  const off = d.meta.zone.offsetMin;
  const when = (t: number) => friendlyTime(t, off);
  const systems = d.meta.systems.length ? d.meta.systems.join(', ') : r.homeCameras;
  const missing = d.cameras.filter((c) => c.video === 'none');
  const max = d.maxEvents ?? 200;
  const events = [...d.events].sort((a, b) => a.start - b.start);
  const shown = events.slice(0, max);

  const cameraRows = d.cameras
    .map(
      (c) =>
        `<tr><td>${e(c.name)}</td><td>${e(c.system)}</td><td>${e(videoText(c.video))}</td><td>${c.events}</td><td>${e(c.note ?? '')}</td></tr>`,
    )
    .join('');

  const eventRows = shown
    .map(
      (ev) => `<tr>
  <td class="thumb">${ev.thumb ? `<img src="${e(ev.thumb)}" alt="">` : ''}</td>
  <td>${e(when(ev.start))}${ev.end ? `<br><span class="muted">${e(r.until(friendlyTime(ev.end, off)))}</span>` : ''}</td>
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
    ? `<p>${r.signed({
        manifest: '<b>manifest.json</b>',
        signature: `<b>${SIGNATURE_FILE}</b>`,
        publicKey: `<b>${PUBLIC_KEY_FILE}</b>`,
        fingerprint: `<span class="mono">${e(shortFingerprint(d.signer.publicKeyFingerprint))}</span>`,
      })}</p>
<p class="mono small">openssl dgst -sha256 -verify ${PUBLIC_KEY_FILE} -signature ${SIGNATURE_FILE} manifest.json</p>`
    : `<p>${r.unsigned}</p>`;

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${e(r.title)}</title>
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
<h1>${e(r.title)}</h1>
<div class="muted">${e(systems)}</div>

<h2>${e(r.summary)}</h2>
<table class="facts">
  <tr><td>${e(r.timeCovered)}</td><td>${e(describeWindow(d.meta.window, d.meta.zone))}<br><span class="muted">${e(durationText(d.meta.window.end - d.meta.window.start))} · ${e(r.isoRange(isoWithOffset(d.meta.window.start, off), isoWithOffset(d.meta.window.end, off)))}</span></td></tr>
  <tr><td>${e(r.cameras)}</td><td>${d.cameras.length}</td></tr>
  <tr><td>${e(r.eventsInTime)}</td><td>${events.length}</td></tr>
  <tr><td>${e(r.exported)}</td><td>${e(when(d.meta.createdAt))}</td></tr>
  <tr><td>${e(r.madeWith)}</td><td>${e(r.madeWithValue(`Sightline ${d.meta.appVersion}`, d.meta.device))}</td></tr>
</table>
${
  missing.length
    ? `<p class="note">${r.missing(missing.map((c) => e(c.name)).join(', '))}</p>`
    : ''
}

<h2>${e(r.cameras)}</h2>
<table><tr><th>${e(r.colCamera)}</th><th>${e(r.colSystem)}</th><th>${e(r.colVideo)}</th><th>${e(r.colEvents)}</th><th>${e(r.colNotes)}</th></tr>${cameraRows}</table>

<h2>${e(r.events)}</h2>
${
  shown.length
    ? `<table><tr><th></th><th>${e(r.colTime)}</th><th>${e(r.colCamera)}</th><th>${e(r.colWhat)}</th></tr>${eventRows}</table>${
        events.length > shown.length ? `<p class="muted">${e(r.more(events.length - shown.length))}</p>` : ''
      }`
    : `<p>${e(r.noEvents)}</p>`
}

<h2>${e(r.howToTell)}</h2>
<p>${r.howToTellBody('<b>manifest.json</b>')}</p>
${signed}

<h2>${e(r.files)}</h2>
<table><tr><th>${e(r.colFile)}</th><th>${e(r.colSize)}</th><th>SHA-256</th></tr>${fileRows}</table>

<p class="muted" style="margin-top:18pt">${e(r.timesShown(d.meta.zone.timeZone || r.phoneZone, `UTC${isoWithOffset(d.meta.window.start, off).slice(19)}`))}</p>
</body></html>`;
}

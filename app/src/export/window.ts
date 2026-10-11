/**
 * Time windows and camera choice for "Export for police or insurance". Pure (no React
 * Native imports) so it's unit-tested; all times are unix seconds.
 */

import { fmtDate, fmtNumber, tr } from '../i18n/index.ts';

export type WindowPreset = 'last30' | 'last2h' | 'lastNight' | 'custom';

export interface TimeWindow {
  start: number;
  end: number;
}

export const PRESETS: { id: Exclude<WindowPreset, 'custom'>; label: string }[] = [
  {
    id: 'last30',
    get label() {
      return tr().exporting.window.last30;
    },
  },
  {
    id: 'last2h',
    get label() {
      return tr().exporting.window.last2h;
    },
  },
  {
    id: 'lastNight',
    get label() {
      return tr().exporting.window.lastNight;
    },
  },
];

/** Longest window one export may cover. Longer ones get huge; split them instead. */
export const MAX_WINDOW_SEC = 24 * 3600;

const NIGHT_START_HOUR = 20;
const NIGHT_END_HOUR = 7;

/** The window a preset means right now (local time of `now`). */
export function presetWindow(preset: Exclude<WindowPreset, 'custom'>, now: Date): TimeWindow {
  const t = Math.floor(now.getTime() / 1000);
  if (preset === 'last30') return { start: t - 30 * 60, end: t };
  if (preset === 'last2h') return { start: t - 2 * 3600, end: t };
  // Last night: 8 PM the evening before through 7 AM (or until now if it isn't 7 AM yet).
  const morning = new Date(now);
  morning.setHours(NIGHT_END_HOUR, 0, 0, 0);
  // Before 7 AM the night isn't over: it runs until now. In the evening, "last night" is still
  // the one that ended this morning.
  const evening = new Date(morning);
  evening.setDate(evening.getDate() - 1);
  evening.setHours(NIGHT_START_HOUR, 0, 0, 0);
  const end = Math.min(t, Math.floor(morning.getTime() / 1000));
  return { start: Math.floor(evening.getTime() / 1000), end };
}

/**
 * A custom window from the day picked (0 = today, 1 = yesterday…) and two "HH:MM" times. An
 * end at or before the start means the next morning (e.g. 22:00 → 06:00).
 */
export function customWindow(daysAgo: number, startHHMM: string, endHHMM: string, now: Date): TimeWindow {
  const at = (hhmm: string, dayShift: number) => {
    const [h, m] = hhmm.split(':').map(Number);
    const d = new Date(now);
    d.setDate(d.getDate() - daysAgo + dayShift);
    d.setHours(h || 0, m || 0, 0, 0);
    return Math.floor(d.getTime() / 1000);
  };
  const start = at(startHHMM, 0);
  let end = at(endHHMM, 0);
  if (end <= start) end = at(endHHMM, 1);
  return { start, end };
}

/** "Today", "Yesterday", "Thu, Oct 8" for the day picker. */
export function dayLabel(daysAgo: number, now: Date): string {
  if (daysAgo === 0) return tr().common.today;
  if (daysAgo === 1) return tr().common.yesterday;
  const d = new Date(now);
  d.setDate(d.getDate() - daysAgo);
  return fmtDate(d, { weekday: 'short', month: 'short', day: 'numeric' });
}

/** A plain-language problem with a window, or null when it's fine. */
export function windowProblem(w: TimeWindow, nowSec: number): string | null {
  const t = tr().exporting.window;
  if (!(w.end > w.start)) return t.endBeforeStart;
  if (w.start >= nowSec) return t.notYet;
  if (w.end - w.start > MAX_WINDOW_SEC) return t.tooLong;
  return null;
}

/** Clamps the end to now (a window that runs into the future only has video up to now). */
export function clampToNow(w: TimeWindow, nowSec: number): TimeWindow {
  return { start: w.start, end: Math.min(w.end, Math.floor(nowSec)) };
}

const pad = (n: number) => String(Math.abs(Math.trunc(n))).padStart(2, '0');

/** "+02:00" / "-05:00" for an offset east of UTC in minutes. */
export function offsetLabel(offsetMin: number): string {
  const sign = offsetMin < 0 ? '-' : '+';
  const a = Math.abs(offsetMin);
  return `${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

/** ISO 8601 with the local offset, e.g. 2026-10-10T20:00:00-05:00 (what a report should show). */
export function isoWithOffset(unixSec: number, offsetMin: number): string {
  const d = new Date((unixSec + offsetMin * 60) * 1000);
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}${offsetLabel(offsetMin)}`
  );
}

/** "Oct 10, 2026, 8:05:09 PM" in the given offset, in the app's language. */
export function friendlyTime(unixSec: number, offsetMin: number, seconds = true): string {
  // Shifted by the offset and formatted as UTC, so it's the export's local time, not the device's.
  const d = new Date((unixSec + offsetMin * 60) * 1000);
  const text = fmtDate(d, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    ...(seconds ? { second: '2-digit' } : {}),
    timeZone: 'UTC',
  });
  // Some Intl versions put a narrow no-break space before AM/PM.
  return text.replace(/ /g, ' ');
}

export interface ZoneInfo {
  /** IANA name, e.g. America/Chicago ('' when unknown). */
  timeZone: string;
  /** Minutes east of UTC at the window's start. */
  offsetMin: number;
}

/** "Oct 10, 2026, 8:00 PM – Oct 11, 2026, 7:00 AM (America/Chicago, UTC-05:00)" */
export function describeWindow(w: TimeWindow, zone: ZoneInfo): string {
  const zoneText = `${zone.timeZone ? `${zone.timeZone}, ` : ''}UTC${offsetLabel(zone.offsetMin)}`;
  return `${friendlyTime(w.start, zone.offsetMin, false)} – ${friendlyTime(w.end, zone.offsetMin, false)} (${zoneText})`;
}

/** "12 minutes", "2 hours 5 minutes". */
export function durationText(sec: number): string {
  const c = tr().common;
  const m = Math.round(sec / 60);
  if (m < 1) return c.seconds(Math.max(1, Math.round(sec)));
  if (m < 60) return c.minutesCount(m);
  const h = Math.floor(m / 60);
  const r = m % 60;
  return `${c.hours(h)}${r ? ` ${c.minutesCount(r)}` : ''}`;
}

export interface CameraCandidate {
  key: string;
  /** Recordings in the window: true/false, or null when the system can't say. */
  hasRecordings: boolean | null;
  /** Events in the window. */
  events: number;
}

/**
 * Cameras picked by default: every camera with recordings or events in the window. When no
 * system can say (plain cameras, or nothing answered), all cameras are picked.
 */
export function defaultSelection(cands: CameraCandidate[]): string[] {
  const known = cands.filter((c) => c.hasRecordings === true || c.events > 0);
  if (known.length) return known.map((c) => c.key);
  if (cands.every((c) => c.hasRecordings === false)) return [];
  return cands.filter((c) => c.hasRecordings !== false).map((c) => c.key);
}

/** How each camera's video gets into the export. */
export type VideoMethod =
  /** The recorder makes an MP4 of the window (Frigate, Sightline Hub, UniFi Protect, Reolink). */
  | 'clip'
  /** The recorder's own files covering the window are downloaded (Agent DVR, Shinobi…). */
  | 'files'
  /** The recorder only replays a stream; it's recorded on this phone in real time. */
  | 'replay'
  /** No video this way: event snapshots only. */
  | 'none';

/** Rough recorded bitrate for estimates (bytes per second per camera, ~2 Mbit/s). */
export const EST_BYTES_PER_SEC = 250_000;
export const LARGE_EXPORT_BYTES = 1_000_000_000;

export function estimateBytes(w: TimeWindow, videoCameras: number): number {
  return Math.max(0, w.end - w.start) * videoCameras * EST_BYTES_PER_SEC;
}

/** "About 1.2 GB" */
export function sizeText(bytes: number): string {
  if (bytes >= 1e9) return `${fmtNumber(bytes / 1e9, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} GB`;
  if (bytes >= 1e6) return `${fmtNumber(Math.max(1, Math.round(bytes / 1e6)))} MB`;
  return `${fmtNumber(Math.max(1, Math.round(bytes / 1e3)))} KB`;
}

/** Warning for big exports (null when it's fine). */
export function sizeWarning(bytes: number): string | null {
  if (bytes < LARGE_EXPORT_BYTES) return null;
  return tr().exporting.window.sizeWarning(sizeText(bytes));
}

/** Replays play in real time, so recording them takes as long as the window. */
export function replayWarning(w: TimeWindow, replayCameras: number): string | null {
  if (replayCameras === 0) return null;
  const sec = w.end - w.start;
  if (sec < 5 * 60) return null;
  return tr().exporting.window.replayWarning(durationText(sec));
}

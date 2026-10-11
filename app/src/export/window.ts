/**
 * Time windows and camera choice for "Export for police or insurance". Pure (no React
 * Native imports) so it's unit-tested; all times are unix seconds.
 */

export type WindowPreset = 'last30' | 'last2h' | 'lastNight' | 'custom';

export interface TimeWindow {
  start: number;
  end: number;
}

export const PRESETS: { id: Exclude<WindowPreset, 'custom'>; label: string }[] = [
  { id: 'last30', label: 'Last 30 minutes' },
  { id: 'last2h', label: 'Last 2 hours' },
  { id: 'lastNight', label: 'Last night (8 PM – 7 AM)' },
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
  if (daysAgo === 0) return 'Today';
  if (daysAgo === 1) return 'Yesterday';
  const d = new Date(now);
  d.setDate(d.getDate() - daysAgo);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return `${days[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** A plain-language problem with a window, or null when it's fine. */
export function windowProblem(w: TimeWindow, nowSec: number): string | null {
  if (!(w.end > w.start)) return 'The end time must be after the start time.';
  if (w.start >= nowSec) return 'That time hasn’t happened yet.';
  if (w.end - w.start > MAX_WINDOW_SEC) return 'Pick 24 hours or less. For longer, make a few exports.';
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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Oct 10, 2026, 8:05:09 PM" in the given offset (no Intl, so it's the same everywhere). */
export function friendlyTime(unixSec: number, offsetMin: number, seconds = true): string {
  const d = new Date((unixSec + offsetMin * 60) * 1000);
  const h = d.getUTCHours();
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const clock = `${h12}:${pad(d.getUTCMinutes())}${seconds ? `:${pad(d.getUTCSeconds())}` : ''} ${h < 12 ? 'AM' : 'PM'}`;
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}, ${clock}`;
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
  const m = Math.round(sec / 60);
  if (m < 1) return `${Math.max(1, Math.round(sec))} seconds`;
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return `${h} hour${h === 1 ? '' : 's'}${r ? ` ${r} minute${r === 1 ? '' : 's'}` : ''}`;
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
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

/** Warning for big exports (null when it's fine). */
export function sizeWarning(bytes: number): string | null {
  if (bytes < LARGE_EXPORT_BYTES) return null;
  return `This could be about ${sizeText(bytes)}. That’s a lot to send by Mail or Messages. AirDrop or Save to Files works best, or pick a shorter time or fewer cameras.`;
}

/** Replays play in real time, so recording them takes as long as the window. */
export function replayWarning(w: TimeWindow, replayCameras: number): string | null {
  if (replayCameras === 0) return null;
  const sec = w.end - w.start;
  if (sec < 5 * 60) return null;
  return `Some of your cameras can only play back recordings at normal speed, so copying their video takes about ${durationText(sec)}. Keep Sightline open until it finishes.`;
}

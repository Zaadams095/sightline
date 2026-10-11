/**
 * Wall display logic (iPad on the wall): touring cameras, jumping to a ring or an alert and
 * back, night dimming, and small periodic shifts that keep a screen showing the same picture
 * all day from burning in. Pure (no React Native imports) so it's unit-tested.
 */

export type TourMode = 'grid' | 'single';

export interface NightSettings {
  enabled: boolean;
  /** "HH:MM" local. */
  start: string;
  end: string;
  /** 0–0.9: how much darker at night. */
  level: number;
}

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

/** Whether `at` falls in a daily window that may cross midnight (22:00–06:30). */
export function inDailyWindow(at: Date, start: string, end: string): boolean {
  const now = at.getHours() * 60 + at.getMinutes();
  const s = minutes(start);
  const e = minutes(end);
  if (s === e) return false;
  return s < e ? now >= s && now < e : now >= s || now < e;
}

/** Opacity of the black layer over the wall (0 in the day). */
export function dimOpacity(night: NightSettings, at: Date): number {
  if (!night.enabled || !inDailyWindow(at, night.start, night.end)) return 0;
  return Math.max(0, Math.min(0.9, night.level));
}

/** Cameras per page in grid mode: 4 on a small iPad, up to 9 on a big one. */
export function gridPageSize(width: number, height: number): number {
  const big = Math.max(width, height) >= 1300;
  return big ? 9 : 4;
}

/** The tour's pages: one camera each in single mode, a screenful each in grid mode. */
export function tourPages(keys: string[], mode: TourMode, perPage: number): string[][] {
  if (!keys.length) return [];
  if (mode === 'single') return keys.map((k) => [k]);
  const size = Math.max(1, perPage);
  const pages: string[][] = [];
  for (let i = 0; i < keys.length; i += size) pages.push(keys.slice(i, i + size));
  return pages;
}

/** Columns × rows that fit n tiles on a screen of this shape (tiles stay close to 16:9). */
export function gridShape(n: number, width: number, height: number): { cols: number; rows: number } {
  if (n <= 1) return { cols: 1, rows: 1 };
  let best = { cols: n, rows: 1, score: Infinity };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const tileAspect = width / cols / (height / rows);
    // Prefer 16:9 tiles and few empty cells.
    const score = Math.abs(Math.log(tileAspect / (16 / 9))) + (cols * rows - n) * 0.15;
    if (score < best.score) best = { cols, rows, score };
  }
  return { cols: best.cols, rows: best.rows };
}

/**
 * Burn-in protection: the whole picture drifts a few points every minute around a small
 * square, so no pixel shows the same edge (tile borders, the clock) all day.
 */
export function pixelShift(nowMs: number, amplitude = 6): { x: number; y: number } {
  const steps: [number, number][] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1],
    [0, -1],
    [1, -1],
  ];
  const [x, y] = steps[Math.floor(nowMs / 60_000) % steps.length];
  return { x: x * amplitude, y: y * amplitude };
}

/** Grid order rotates by one camera every `everyMin` minutes, so tiles trade places. */
export function rotateForBurnIn<T>(items: T[], nowMs: number, everyMin = 15): T[] {
  if (items.length < 2) return items;
  const n = Math.floor(nowMs / (everyMin * 60_000)) % items.length;
  return [...items.slice(n), ...items.slice(0, n)];
}

/** The clock moves to the other corner every half hour. */
export function clockCorner(nowMs: number): 'left' | 'right' {
  return Math.floor(nowMs / (30 * 60_000)) % 2 === 0 ? 'left' : 'right';
}

/** Something that takes over the wall for a while: a doorbell ring or an alert. */
export interface Takeover {
  kind: 'ring' | 'alert';
  cameraKey: string;
  /** ms */
  at: number;
  /** "Someone's at the door", "Person · Driveway" */
  title: string;
}

export const RING_HOLD_MS = 90_000;
export const ALERT_HOLD_MS = 30_000;

/**
 * Which takeover is showing now, if any: a ring always wins over an alert; otherwise the
 * newest. Each lasts its hold time, then the tour carries on where it was.
 */
export function activeTakeover(list: Takeover[], nowMs: number): Takeover | null {
  const live = list.filter((t) => nowMs - t.at < (t.kind === 'ring' ? RING_HOLD_MS : ALERT_HOLD_MS) && t.at <= nowMs + 5000);
  if (!live.length) return null;
  const rings = live.filter((t) => t.kind === 'ring');
  const pool = rings.length ? rings : live;
  return pool.reduce((a, b) => (b.at > a.at ? b : a));
}

/** Adds a takeover, dropping ones that have ended and repeats for the same camera. */
export function addTakeover(list: Takeover[], t: Takeover, nowMs: number): Takeover[] {
  const kept = list.filter((x) => nowMs - x.at < RING_HOLD_MS && !(x.cameraKey === t.cameraKey && x.kind === t.kind));
  return [...kept, t];
}

/** "Saturday, October 11" */
export function dateLine(at: Date): string {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${days[at.getDay()]}, ${months[at.getMonth()]} ${at.getDate()}`;
}

/** "9:41" (12-hour unless the phone uses 24-hour time) */
export function clockText(at: Date, h24 = false): string {
  const m = String(at.getMinutes()).padStart(2, '0');
  if (h24) return `${String(at.getHours()).padStart(2, '0')}:${m}`;
  const h = at.getHours() % 12 || 12;
  return `${h}:${m}`;
}

/** "6 cameras · all connected" / "6 cameras · 2 not connected" (no weather, no cloud). */
export function statusLine(total: number, offline: number): string {
  const cams = `${total} camera${total === 1 ? '' : 's'}`;
  if (!total) return 'No cameras';
  return offline ? `${cams} · ${offline} not connected` : `${cams} · all connected`;
}

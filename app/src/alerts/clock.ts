/**
 * Time-of-day helpers for smart alerts and check-ins: wall-clock time in a given time zone
 * (DST-safe), plain "9:15 PM" formatting, and day/night from the sun. Pure (no RN imports) and
 * mirrored by the Hub (bridge/clock.go), so both sides word and time things identically.
 */

export interface ZonedParts {
  y: number;
  m: number; // 1–12
  d: number;
  h: number; // 0–23
  mi: number;
  /** 0 = Sunday. */
  wd: number;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat | null {
  let f = formatters.get(tz);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: tz || undefined,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        weekday: 'short',
      });
    } catch {
      return null; // unknown zone: fall back to the phone's own
    }
    formatters.set(tz, f);
  }
  return f;
}

/** Wall-clock parts of unix time `ts` (seconds) in IANA zone `tz` ("" = this device's zone). */
export function zoned(ts: number, tz: string): ZonedParts {
  const f = tz ? formatter(tz) : null;
  if (f && typeof f.formatToParts === 'function') {
    const parts: Record<string, string> = {};
    for (const p of f.formatToParts(new Date(ts * 1000))) parts[p.type] = p.value;
    return {
      y: Number(parts.year),
      m: Number(parts.month),
      d: Number(parts.day),
      h: Number(parts.hour) % 24,
      mi: Number(parts.minute),
      wd: Math.max(0, WEEKDAYS.indexOf(parts.weekday)),
    };
  }
  const dt = new Date(ts * 1000);
  return { y: dt.getFullYear(), m: dt.getMonth() + 1, d: dt.getDate(), h: dt.getHours(), mi: dt.getMinutes(), wd: dt.getDay() };
}

/**
 * Unix seconds of a wall-clock time in `tz`, resolved exactly like Go's time.Date (the Hub must
 * agree): a repeated time (fall back) is its first occurrence; a skipped one (spring forward,
 * 02:30) uses the offset from after the jump, landing an hour earlier.
 */
export function zonedToUnix(y: number, m: number, d: number, h: number, mi: number, tz: string): number {
  const wall = Date.UTC(y, m - 1, d, h, mi) / 1000;
  const offsetAt = (t: number) => {
    const p = zoned(t, tz);
    return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) / 1000 - Math.floor(t / 60) * 60;
  };
  let offset = offsetAt(wall);
  const o2 = offsetAt(wall - offset);
  if (o2 !== offset) offset = o2;
  return wall - offset;
}

/** "2026-10-11" in tz: the calendar day a time belongs to. */
export function dayKey(ts: number, tz: string): string {
  const p = zoned(ts, tz);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/** Unix seconds of today's hh:mm in tz (for the day `ts` falls on). */
export function atTimeOfDay(ts: number, hhmm: string, tz: string): number {
  const p = zoned(ts, tz);
  const [h, mi] = parseHHMM(hhmm);
  return zonedToUnix(p.y, p.m, p.d, h, mi, tz);
}

export function parseHHMM(s: string): [number, number] {
  const m = /^(\d{1,2}):(\d{2})$/.exec((s ?? '').trim());
  if (!m) return [0, 0];
  return [Math.min(23, Number(m[1])), Math.min(59, Number(m[2]))];
}

/** "9:15 PM". */
export function clockText(h: number, mi: number): string {
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(mi).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "today at 9:15 AM" / "yesterday at 9:15 PM" / "on Monday at 9:15 PM" / "on Oct 3 at 9:15 PM". */
export function whenText(ts: number, now: number, tz: string): string {
  const p = zoned(ts, tz);
  const at = `at ${clockText(p.h, p.mi)}`;
  const today = zoned(now, tz);
  const days = Math.round((Date.UTC(today.y, today.m - 1, today.d) - Date.UTC(p.y, p.m - 1, p.d)) / 86_400_000);
  if (days <= 0) return `today ${at}`;
  if (days === 1) return `yesterday ${at}`;
  if (days < 7) return `on ${DAY_NAMES[p.wd]} ${at}`;
  return `on ${MONTHS[p.m - 1]} ${p.d} ${at}`;
}

export type Light = 'day' | 'night';
export type HourBucket = 'night' | 'morning' | 'afternoon' | 'evening';

export function hourBucket(h: number): HourBucket {
  if (h < 6) return 'night';
  if (h < 12) return 'morning';
  if (h < 18) return 'afternoon';
  return 'evening';
}

/** Approximate location (one decimal, ~10 km) for sunrise/sunset; never more precise than that. */
export interface SunPlace {
  lat: number;
  lon: number;
}

/**
 * Day or night at `ts`. With a location, from the sun's position (sunrise/sunset within a few
 * minutes; no service needed). Without one, 7 PM–6 AM local time counts as night.
 */
export function lightAt(ts: number, tz: string, sun?: SunPlace | null): Light {
  if (!sun || !Number.isFinite(sun.lat) || !Number.isFinite(sun.lon)) {
    const h = zoned(ts, tz).h;
    return h >= 19 || h < 6 ? 'night' : 'day';
  }
  const rad = Math.PI / 180;
  const date = new Date(ts * 1000);
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const n = Math.floor((ts * 1000 - start) / 86_400_000);
  const decl = -23.44 * Math.cos(((2 * Math.PI) / 365) * (n + 10));
  const lat = Math.max(-89.9, Math.min(89.9, sun.lat));
  const cosH = (Math.sin(-0.833 * rad) - Math.sin(lat * rad) * Math.sin(decl * rad)) / (Math.cos(lat * rad) * Math.cos(decl * rad));
  if (cosH >= 1) return 'night'; // polar night
  if (cosH <= -1) return 'day'; // midnight sun
  const half = Math.acos(cosH) / rad / 15; // hours from solar noon to sunset
  const noon = 12 - sun.lon / 15; // UTC hours
  const t = (ts % 86400) / 3600;
  const since = (((t - (noon - half)) % 24) + 24) % 24;
  return since < 2 * half ? 'day' : 'night';
}

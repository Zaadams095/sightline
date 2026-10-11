import type { RecordingSegment } from './types';
import { tr } from '../i18n/index.ts';

/**
 * Brand-neutral helpers shared by the HTTP-based adapters. Pure (no app imports) so they
 * can be unit tested with node:test.
 */

export type Query = Record<string, string | number | boolean | undefined | null>;

/** `a=1&b=x%20y`, skipping empty values. */
export function qs(q?: Query): string {
  if (!q) return '';
  return Object.entries(q)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}

/** Appends a query string, respecting one that's already on the URL. */
export function withQuery(url: string, q?: Query): string {
  const s = qs(q);
  if (!s) return url;
  return `${url}${url.includes('?') ? '&' : '?'}${s}`;
}

/** Sorted, merged spans (overlapping or within `tolerance` seconds of each other). */
export function mergeSpans(spans: RecordingSegment[], tolerance = 1): RecordingSegment[] {
  const out: RecordingSegment[] = [];
  for (const s of [...spans].filter((x) => x.end > x.start).sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1];
    if (last && s.start - last.end <= tolerance) last.end = Math.max(last.end, s.end);
    else out.push({ start: s.start, end: s.end });
  }
  return out;
}

/** Plain-language message for an HTTP status from a camera system. */
export function httpMessage(status: number, label: string): string {
  switch (status) {
    case 401:
      return tr().systems.http.badLogin(label);
    case 403:
      return tr().systems.http.forbidden(label);
    case 404:
      return tr().systems.http.notFound(label);
    case 502:
    case 504:
      return tr().systems.http.unreachable(label);
    default:
      return status >= 500 ? tr().systems.http.serverProblem(label, status) : tr().systems.http.httpError(label, status);
  }
}

export function titleCase(s: string): string {
  return s.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** Offset (ms) of an IANA time zone from UTC at a given instant; null if unknown. */
function zoneOffsetMs(utcMs: number, timeZone: string): number | null {
  try {
    const f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
    const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
    return asUtc - Math.floor(utcMs / 1000) * 1000;
  } catch {
    return null;
  }
}

/**
 * Parses a server wall-clock time like `2024-05-01 13:45:00` (or ISO with `T`) into unix
 * seconds. Strings with an explicit offset/Z are honored; otherwise `timeZone` (IANA) is
 * used, falling back to the phone's zone.
 */
export function parseLocalDateTime(s: string, timeZone?: string): number {
  const str = s.trim();
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(str)) return Date.parse(str.replace(' ', 'T')) / 1000;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(str);
  if (!m) return NaN;
  const [y, mo, d, h, mi, se] = m.slice(1).map((x) => Number(x ?? 0));
  if (!timeZone) return new Date(y, mo - 1, d, h, mi, se).getTime() / 1000;
  const guess = Date.UTC(y, mo - 1, d, h, mi, se);
  const off1 = zoneOffsetMs(guess, timeZone);
  if (off1 == null) return new Date(y, mo - 1, d, h, mi, se).getTime() / 1000;
  // Second pass corrects instants near a DST change.
  const off2 = zoneOffsetMs(guess - off1, timeZone) ?? off1;
  return (guess - off2) / 1000;
}

/** Unix seconds → `YYYY-MM-DD HH:mm:ss` in `timeZone` (or the phone's zone). */
export function formatLocalDateTime(t: number, timeZone?: string, sep = ' '): string {
  const ms = Math.floor(t) * 1000;
  const off = timeZone ? zoneOffsetMs(ms, timeZone) : null;
  const d = off == null ? new Date(ms) : new Date(ms + off);
  const get = off == null
    ? [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()]
    : [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()];
  const [y, mo, da, h, mi, se] = get;
  return `${y}-${pad(mo)}-${pad(da)}${sep}${pad(h)}:${pad(mi)}:${pad(se)}`;
}

/** Local dates (YYYY-MM-DD, phone time zone) touched by spans, newest first. */
export function daysOf(spans: RecordingSegment[]): string[] {
  const days = new Set<string>();
  for (const s of spans) {
    const d = new Date(s.start * 1000);
    d.setHours(0, 0, 0, 0);
    while (d.getTime() / 1000 < s.end) {
      days.add(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
      d.setDate(d.getDate() + 1);
    }
  }
  return [...days].sort().reverse();
}

/** Normalizes detector labels to the app's vocabulary (person, car, …). */
export function normalizeLabel(raw: string): string {
  const l = raw.trim().toLowerCase();
  if (['people', 'human', 'persons'].includes(l)) return 'person';
  if (['vehicle', 'vehicles', 'truck', 'bus', 'automobile'].includes(l)) return l === 'truck' || l === 'bus' ? l : 'car';
  if (['animal', 'animals'].includes(l)) return 'animal';
  return l;
}

export function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

/**
 * For recorders that store whole files: the file playing at `t`, else the first one that
 * starts after it (before `until`). Used to turn "play from t" into a file + its start time.
 */
export function fileAt<T extends { start: number; end: number }>(files: T[], t: number, until = Infinity): T | null {
  const sorted = [...files].sort((a, b) => a.start - b.start);
  return sorted.find((f) => f.start <= t && t < f.end) ?? sorted.find((f) => f.start > t && f.start < until) ?? null;
}

/** Splits a free-text label list ("person:87%, car;dog") into normalized labels. */
export function splitLabels(s: string | undefined | null): string[] {
  if (!s) return [];
  return unique(
    s
      .split(/[,;|]+/)
      .map((x) => normalizeLabel(x.replace(/[:\s]*\d+(\.\d+)?%?\s*$/, '')))
      .filter(Boolean),
  );
}

/** Basic-auth header value (for systems whose API may require it). */
export function basicAuth(user: string, pass: string): string {
  const bytes = new TextEncoder().encode(`${user}:${pass}`);
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return `Basic ${btoa(bin)}`;
}

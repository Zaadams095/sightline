/**
 * Timelapse scheduling, brand-neutral and pure (unit-tested in test/timelapse.test.ts).
 *
 * - Seekable recordings (`vod`): short windows play straight through at a high rate; long
 *   ones (a whole day) play a short burst every few minutes of recorded time, jumping ahead
 *   between bursts. Gaps in the recording are skipped because samples are spread over
 *   recorded time, not wall time.
 * - Forward-only recordings (`stream`): a few seconds from each step (every 15 min or hour).
 */

import { formatLocale, getLocale, tr } from '../i18n/index.ts';

export interface Span {
  start: number;
  end: number;
}

export interface Sample {
  /** Wall clock (unix seconds) where the burst starts. */
  wall: number;
  /** Position in the VOD playlist (seconds, gaps removed). */
  player: number;
}

export type VodPlan =
  | { mode: 'rate'; rate: number; durationSec: number }
  | { mode: 'jump'; rate: number; dwellSec: number; samples: Sample[]; durationSec: number };

export interface VodOptions {
  /** Roughly how long the timelapse should take to watch. */
  targetSec?: number;
  /** Highest playback rate to use when playing straight through (AVPlayer allows ~16). */
  maxRate?: number;
  /** Rate during each burst when jumping. */
  jumpRate?: number;
  /** Real seconds each burst plays before jumping. */
  dwellSec?: number;
  /** Allow playing straight through (false when the window spans several playlists). */
  straightThrough?: boolean;
}

const DEFAULTS: Required<VodOptions> = { targetSec: 60, maxRate: 16, jumpRate: 8, dwellSec: 1.5, straightThrough: true };

/** Sorted, clipped, non-empty recorded spans within [start, end]. */
export function clipSpans(spans: Span[], start: number, end: number): Span[] {
  return spans
    .filter((s) => s.end > start && s.start < end)
    .map((s) => ({ start: Math.max(s.start, start), end: Math.min(s.end, end) }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);
}

export function recordedSec(spans: Span[]): number {
  return spans.reduce((n, s) => n + (s.end - s.start), 0);
}

/** Player position (gaps removed) → wall clock. */
export function spanPlayerToWall(spans: Span[], player: number): number {
  let acc = 0;
  for (const s of spans) {
    const len = s.end - s.start;
    if (player < acc + len) return s.start + (player - acc);
    acc += len;
  }
  return spans.length ? spans[spans.length - 1].end : 0;
}

/** Wall clock → player position; a time inside a gap snaps to the next recording. */
export function spanWallToPlayer(spans: Span[], wall: number): number {
  let acc = 0;
  for (const s of spans) {
    if (wall < s.start) return acc;
    if (wall <= s.end) return acc + (wall - s.start);
    acc += s.end - s.start;
  }
  return acc;
}

/** Plans a VOD timelapse over already-clipped spans. Null when nothing was recorded. */
export function planVod(spans: Span[], opts: VodOptions = {}): VodPlan | null {
  const o = { ...DEFAULTS, ...opts };
  const total = recordedSec(spans);
  if (total <= 0) return null;

  // Fits in about the target time at an allowed rate: just play it fast.
  if (o.straightThrough && total / o.maxRate <= o.targetSec * 1.25) {
    const rate = Math.min(o.maxRate, Math.max(2, Math.ceil(total / o.targetSec)));
    return { mode: 'rate', rate, durationSec: total / rate };
  }

  const count = Math.max(2, Math.floor(o.targetSec / o.dwellSec));
  const every = total / count;
  const samples: Sample[] = [];
  for (let i = 0; i < count; i++) {
    const player = i * every;
    samples.push({ player, wall: spanPlayerToWall(spans, player) });
  }
  return { mode: 'jump', rate: o.jumpRate, dwellSec: o.dwellSec, samples, durationSec: count * o.dwellSec };
}

/** Index of the sample at or just before a wall time (for scrubbing). */
export function sampleIndexAt(samples: Sample[], wall: number): number {
  let idx = 0;
  for (let i = 0; i < samples.length; i++) {
    if (samples[i].wall <= wall) idx = i;
    else break;
  }
  return idx;
}

/** Windows to step through for forward-only (stream) recordings. */
export function streamSteps(start: number, end: number, stepSec?: number): Span[] {
  const step = stepSec ?? (end - start <= 3 * 3600 ? 15 * 60 : 3600);
  const out: Span[] = [];
  for (let t = start; t < end; t += step) out.push({ start: t, end: Math.min(end, t + step) });
  return out;
}

export interface Tick {
  t: number;
  /** "3 PM"-style label on major ticks only. */
  label?: string;
}

/** Local-hour ticks across a window; labels every `labelEvery` hours (auto by length). */
export function hourTicks(start: number, end: number, labelEvery?: number): Tick[] {
  const hours = (end - start) / 3600;
  const every = labelEvery ?? (hours <= 4 ? 1 : hours <= 12 ? 3 : 6);
  const d = new Date(start * 1000);
  d.setMinutes(0, 0, 0);
  if (d.getTime() / 1000 < start) d.setHours(d.getHours() + 1);
  const out: Tick[] = [];
  const twelve = uses12h();
  while (d.getTime() / 1000 <= end) {
    const h = d.getHours();
    const label = h % every === 0 ? hourLabel(h, twelve) : undefined;
    out.push({ t: d.getTime() / 1000, label });
    d.setHours(d.getHours() + 1);
  }
  return out;
}

/** Whether the active language/region shows a 12-hour clock ("3 PM") rather than "15 h". */
function uses12h(): boolean {
  try {
    return !!new Intl.DateTimeFormat(formatLocale(), { hour: 'numeric' }).resolvedOptions().hour12;
  } catch {
    return getLocale() === 'en';
  }
}

function hourLabel(h: number, twelve: boolean): string {
  const s = tr().viewing.timelapse;
  if (!twelve) return s.hour24(h);
  return h === 0 ? s.midnight : h === 12 ? s.noon : h < 12 ? s.hourAm(h) : s.hourPm(h - 12);
}

/**
 * Longest window to ask one playlist for. Some recorders cap VOD requests (Frigate: 2 hours),
 * so a day is loaded as consecutive chunks.
 */
export const CHUNK_SEC = 2 * 3600;

/** Which chunk of a window a wall time falls in, and that chunk's bounds. */
export function chunkAt(start: number, end: number, wall: number): { index: number; start: number; end: number } {
  const count = Math.max(1, Math.ceil((end - start) / CHUNK_SEC));
  const index = Math.min(count - 1, Math.max(0, Math.floor((wall - start) / CHUNK_SEC)));
  const s = start + index * CHUNK_SEC;
  return { index, start: s, end: Math.min(end, s + CHUNK_SEC) };
}

/** Clips over this length aren't offered for sharing (an hour of video is a big download). */
export const SHAREABLE_MAX_SEC = 3600;

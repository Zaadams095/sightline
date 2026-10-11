/**
 * Which pieces of video to ask each recorder for. Pure; unit-tested.
 */

import type { RecordingSegment } from '../systems/types';
import { isoWithOffset, type TimeWindow } from './window.ts';

/** Longest single clip asked of a recorder (long clips time out or fail on some). */
export const CLIP_PIECE_SEC = 30 * 60;

/** Joins overlapping spans, and gaps under a minute (recorders split files every few minutes). */
export function mergeSpans(spans: [number, number][]): [number, number][] {
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s[0] <= last[1] + 60) last[1] = Math.max(last[1], s[1]);
    else out.push([s[0], s[1]]);
  }
  return out;
}

/**
 * Clip requests of at most 30 minutes covering the window, skipping stretches with no
 * recordings when the recorder lists them (null = it can't say, so ask for everything).
 */
export function clipPieces(w: TimeWindow, segments: RecordingSegment[] | null): [number, number][] {
  let spans: [number, number][];
  if (segments == null) spans = [[w.start, w.end]];
  else
    spans = mergeSpans(
      segments.map((s) => [Math.max(w.start, s.start), Math.min(w.end, s.end)] as [number, number]).filter(([s, e]) => e > s),
    );
  const out: [number, number][] = [];
  for (const [s, e] of spans) for (let t = s; t < e; t += CLIP_PIECE_SEC) out.push([t, Math.min(e, t + CLIP_PIECE_SEC)]);
  return out;
}

/**
 * Moments to ask a file-based recorder for "the file playing at…": the window start, each
 * recording in the window, and each event (files found twice are skipped by the caller).
 */
export function fileAnchors(w: TimeWindow, segments: RecordingSegment[] | null, eventStarts: number[], max = 200): number[] {
  const set = new Set<number>([w.start]);
  for (const s of segments ?? []) if (s.end > w.start && s.start < w.end) set.add(Math.max(w.start, s.start));
  for (const t of eventStarts) if (t < w.end) set.add(Math.max(w.start, t));
  return [...set].sort((a, b) => a - b).slice(0, max);
}

/** Top folder of an export: "Sightline export 2026-10-11 0930". */
export function exportFolderName(createdAt: number, offsetMin: number): string {
  const iso = isoWithOffset(createdAt, offsetMin);
  return `Sightline export ${iso.slice(0, 10)} ${iso.slice(11, 13)}${iso.slice(14, 16)}`;
}

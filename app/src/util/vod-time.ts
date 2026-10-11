import type { RecordingSegment } from '@/systems/types';

/**
 * Frigate's VOD playlist concatenates recordings and drops the gaps between them, so
 * player time ≠ wall time − windowStart. These map between the two using the clipped
 * recording spans of the window.
 */
export function clipSegments(segs: RecordingSegment[], start: number, end: number): RecordingSegment[] {
  return segs
    .filter((s) => s.end > start && s.start < end)
    .map((s) => ({ start: Math.max(s.start, start), end: Math.min(s.end, end) }))
    .sort((a, b) => a.start - b.start);
}

export function wallToPlayer(segs: RecordingSegment[], wall: number): number {
  let acc = 0;
  for (const s of segs) {
    if (wall < s.start) return acc; // in a gap: snap to the next recording
    if (wall <= s.end) return acc + (wall - s.start);
    acc += s.end - s.start;
  }
  return acc;
}

export function playerToWall(segs: RecordingSegment[], player: number): number {
  let acc = 0;
  for (const s of segs) {
    const len = s.end - s.start;
    // Strict "<": a time exactly on a seam belongs to the next recording.
    if (player < acc + len) return s.start + (player - acc);
    acc += len;
  }
  return segs.length ? segs[segs.length - 1].end : 0;
}

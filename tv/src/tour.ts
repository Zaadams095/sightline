/**
 * Tour mode logic for the TV (pure, unit-tested): which camera is up, switching to the
 * doorbell when someone rings and back, night dimming and burn-in drift. Mirrors the iPad
 * wall display (app/src/wall/schedule.ts).
 */

export const TOUR_INTERVAL_MS = 15_000;
export const RING_HOLD_MS = 90_000;

/** Same default as the iPad wall: dim from 10 PM to 6:30 AM. */
export const NIGHT = { start: '22:00', end: '06:30', level: 0.55 };

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

export function inDailyWindow(at: Date, start: string, end: string): boolean {
  const now = at.getHours() * 60 + at.getMinutes();
  const s = minutes(start);
  const e = minutes(end);
  if (s === e) return false;
  return s < e ? now >= s && now < e : now >= s || now < e;
}

export function dimOpacity(at: Date, night = NIGHT): number {
  return inDailyWindow(at, night.start, night.end) ? night.level : 0;
}

/** The picture drifts a few points each minute around a small square (OLED TVs). */
export function pixelShift(nowMs: number, amplitude = 8): { x: number; y: number } {
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

export interface Ring {
  id: string;
  camera: string;
  /** Hub clock, unix seconds. */
  at: number;
}

export interface TourState {
  /** Camera index the tour is on. */
  index: number;
  /** While someone's at the door: the doorbell camera's index and when it ends (ms). */
  ring: { index: number; until: number } | null;
}

/** The camera on screen right now. */
export function shownIndex(s: TourState, nowMs: number): number {
  return s.ring && nowMs < s.ring.until ? s.ring.index : s.index;
}

/** Next camera in the tour (paused while a ring is showing). */
export function advance(s: TourState, count: number, nowMs: number): TourState {
  if (count <= 0) return s;
  if (s.ring && nowMs < s.ring.until) return s;
  return { index: (s.index + 1) % count, ring: null };
}

/** Rings switch to the doorbell camera (when the TV has it) for a while. */
export function onRings(s: TourState, rings: Ring[], cameraIds: string[], nowMs: number): TourState {
  const newest = [...rings].sort((a, b) => b.at - a.at).find((r) => cameraIds.includes(r.camera));
  if (!newest) return s;
  return { ...s, ring: { index: cameraIds.indexOf(newest.camera), until: nowMs + RING_HOLD_MS } };
}

/** "9:05 PM" */
export function clockText(at: Date): string {
  const h = at.getHours() % 12 || 12;
  return `${h}:${String(at.getMinutes()).padStart(2, '0')} ${at.getHours() < 12 ? 'AM' : 'PM'}`;
}

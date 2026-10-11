import type { CameraMap } from '@/state/store';

export interface Neighbor {
  key: string;
  transitSec: number;
  linked: boolean;
}

/**
 * Cameras near `key`: explicit links first, then the closest placed cameras. Used for
 * synced picture-in-picture during playback and for following someone across cameras.
 */
export function neighborsOf(map: CameraMap, key: string, limit = 2): Neighbor[] {
  const linked: Neighbor[] = map.links
    .filter((l) => l.a === key || l.b === key)
    .map((l) => ({ key: l.a === key ? l.b : l.a, transitSec: l.transitSec, linked: true }))
    .sort((x, y) => x.transitSec - y.transitSec);
  if (linked.length >= limit) return linked.slice(0, limit);

  const me = map.placements[key];
  if (!me) return linked;
  const taken = new Set([key, ...linked.map((n) => n.key)]);
  const near = Object.entries(map.placements)
    .filter(([k]) => !taken.has(k))
    .map(([k, p]) => ({ key: k, d: Math.hypot((p.x - me.x) * map.aspect, p.y - me.y) }))
    .filter((n) => n.d < 0.45)
    .sort((a, b) => a.d - b.d)
    // Rough default: assume a ~40 m wide property at walking pace.
    .map((n) => ({ key: n.key, transitSec: Math.round(10 + n.d * 40), linked: false }));
  return [...linked, ...near].slice(0, limit);
}

export interface PathStep<T> {
  cameraKey: string;
  item: T;
}

/**
 * Follows activity across neighboring cameras: from `start`, repeatedly picks the next
 * event on a neighbor that begins within its transit window (plus some slack).
 */
export function tracePath<T extends { startTime: number; endTime: number | null; key: string }>(
  map: CameraMap,
  start: T,
  all: T[],
  maxSteps = 6,
): PathStep<T>[] {
  const steps: PathStep<T>[] = [{ cameraKey: start.key, item: start }];
  const used = new Set<T>([start]);
  let cur = start;
  for (let i = 0; i < maxSteps; i++) {
    const end = cur.endTime ?? cur.startTime + 30;
    const from = cur;
    const candidates = neighborsOf(map, from.key, 6).flatMap((n) =>
      all
        .filter((e) => !used.has(e) && e.key === n.key)
        .filter((e) => e.startTime >= from.startTime && e.startTime <= end + n.transitSec * 2 + 15)
        .map((e) => ({ e, gap: e.startTime - end })),
    );
    if (!candidates.length) break;
    candidates.sort((a, b) => a.gap - b.gap);
    cur = candidates[0].e;
    used.add(cur);
    steps.push({ cameraKey: cur.key, item: cur });
  }
  return steps;
}

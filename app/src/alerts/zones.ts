/**
 * Activity zones ("Only alert me about the driveway"), one model for both "alert only here"
 * and "ignore here" (the older alert masks). Pure (no RN imports) so node tests and the Hub
 * (bridge/zones.go) can mirror it exactly. Keep the two in sync.
 *
 * Store shape (persisted, included in backups): `alertZones: Record<cameraKey, AlertZone[]>`,
 * camera key = `${systemId}:${cameraId}`. Points are normalized 0..1 from the picture's top-left,
 * so they don't depend on resolution.
 */

export interface Pt {
  x: number;
  y: number;
}

/** Kinds of things a zone can be about. An empty list means anything that moves. */
export type ZoneObject = 'person' | 'vehicle' | 'animal' | 'package';
export const ZONE_OBJECTS: { v: ZoneObject; label: string }[] = [
  { v: 'person', label: 'People' },
  { v: 'vehicle', label: 'Vehicles' },
  { v: 'animal', label: 'Animals' },
  { v: 'package', label: 'Packages' },
];

export interface AlertZone {
  id: string;
  /** Plain name the user picked ("Driveway", "Porch"). */
  name: string;
  /** include = only alert about things here; exclude = ignore things here. */
  mode: 'include' | 'exclude';
  /** Polygon, at least 3 points, normalized 0..1. */
  points: Pt[];
  /** What to alert on (include) or ignore (exclude) here. Empty = anything that moves. */
  objects: ZoneObject[];
}

export type AlertZones = Record<string, AlertZone[]>;

/**
 * How zones can work on a camera:
 * - precise: the system says where each object was, so Sightline filters alerts itself.
 * - device: no positions, but the area can be written to the camera's own motion detection.
 * - false: neither; zones can't work for this camera.
 */
export type ZoneSupport = 'precise' | 'device' | false;

export function zoneSupportFor<C>(
  adapter: { detectionPoints?: unknown; applyZones?: unknown; zoneSupport?(camera: C): ZoneSupport },
  camera: C,
): ZoneSupport {
  if (adapter.zoneSupport) return adapter.zoneSupport(camera);
  if (adapter.detectionPoints) return 'precise';
  if (adapter.applyZones) return 'device';
  return false;
}

/** Ray-casting point-in-polygon test (normalized coordinates). */
export function pointInPolygon(pt: Pt, poly: Pt[]): boolean {
  if (poly.length < 3) return false;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > pt.y !== b.y > pt.y && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Maps a system's object label ("car", "dog") to a zone category. */
export function objectCategory(label: string): string {
  const l = label.toLowerCase();
  if (['person', 'people', 'face', 'human'].includes(l)) return 'person';
  if (['car', 'truck', 'bus', 'motorcycle', 'bicycle', 'vehicle', 'boat', 'license_plate', 'van'].includes(l)) return 'vehicle';
  if (
    ['dog', 'cat', 'bird', 'horse', 'animal', 'deer', 'bear', 'cow', 'sheep', 'fox', 'raccoon', 'squirrel', 'rabbit', 'pet', 'dog_cat'].includes(l)
  )
    return 'animal';
  return l;
}

function applies(z: AlertZone, objects: string[]): boolean {
  if (!z.objects.length) return true;
  return objects.some((o) => (z.objects as string[]).includes(objectCategory(o)));
}

/**
 * Whether an event with these objects, whose objects' feet were seen at `points`, may alert.
 * - Exclude zones drop it when its objects never left them (they apply to their kinds only).
 * - With any include zone, something must have been inside an include zone about its kind.
 * - No positions known: never suppressed. Sightline only filters what it actually knows.
 */
export function zonesAllow(zones: AlertZone[], objects: string[], points: Pt[]): boolean {
  if (!zones.length || !points.length) return true;
  const valid = zones.filter((z) => z.points.length >= 3);
  const excl = valid.filter((z) => z.mode !== 'include' && applies(z, objects));
  const incl = valid.filter((z) => z.mode === 'include');
  const free = points.filter((p) => !excl.some((z) => pointInPolygon(p, z.points)));
  if (!free.length) return false;
  if (!incl.length) return true;
  const wanted = incl.filter((z) => applies(z, objects));
  return free.some((p) => wanted.some((z) => pointInPolygon(p, z.points)));
}

/**
 * Converts the older `masks` (polygons to ignore, per camera key) into exclude zones. Existing
 * zones are kept; a camera that already has zones isn't touched, so running it twice is safe.
 */
export function migrateMasks(masks: Record<string, Pt[][]> | undefined, zones: AlertZones | undefined): AlertZones {
  const out: AlertZones = { ...(zones ?? {}) };
  for (const [key, polys] of Object.entries(masks ?? {})) {
    if (out[key]?.length) continue;
    const usable = (polys ?? []).filter((p) => Array.isArray(p) && p.length >= 3);
    if (!usable.length) continue;
    out[key] = usable.map((points, i) => ({
      id: `mask-${i + 1}`,
      name: usable.length === 1 ? 'Ignored area' : `Ignored area ${i + 1}`,
      mode: 'exclude',
      points: points.map(clampPt),
      objects: [],
    }));
  }
  return out;
}

/** An id not used by any of the camera's zones ("z1", "z2"…). */
export function nextZoneId(zones: AlertZone[]): string {
  const ids = new Set(zones.map((z) => z.id));
  let n = zones.length + 1;
  while (ids.has(`z${n}`)) n++;
  return `z${n}`;
}

export function clampPt(p: Pt): Pt {
  const c = (v: number) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));
  return { x: c(p.x), y: c(p.y) };
}

/** The legacy `masks` format for older Hubs: plain "ignore here" zones only. */
export function legacyMasks(zones: AlertZone[]): Pt[][] {
  return zones.filter((z) => z.mode === 'exclude' && !z.objects.length && z.points.length >= 3).map((z) => z.points);
}

/** Quick shapes for people who'd rather not draw. */
export const ZONE_PRESETS: { label: string; name: string; points: Pt[] }[] = [
  { label: 'Whole picture', name: 'Whole picture', points: rect(0, 0, 1, 1) },
  { label: 'Left half', name: 'Left side', points: rect(0, 0, 0.5, 1) },
  { label: 'Right half', name: 'Right side', points: rect(0.5, 0, 1, 1) },
  { label: 'Top half', name: 'Far side', points: rect(0, 0, 1, 0.5) },
  { label: 'Bottom half', name: 'Near side', points: rect(0, 0.5, 1, 1) },
  { label: 'Bottom third', name: 'Close to the camera', points: rect(0, 2 / 3, 1, 1) },
  { label: 'Middle', name: 'Middle', points: rect(0.25, 0.25, 0.75, 0.75) },
];

function rect(x0: number, y0: number, x1: number, y1: number): Pt[] {
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}

/**
 * The area as a detection grid, row-major from the top-left, '1' = watch this cell. A cell is
 * watched when its center is inside an include zone (or there are none) and outside every
 * exclude zone. Used to write zones to cameras' own motion detection.
 */
export function rasterize(zones: AlertZone[], cols: number, rows: number): string {
  const valid = zones.filter((z) => z.points.length >= 3);
  const incl = valid.filter((z) => z.mode === 'include');
  const excl = valid.filter((z) => z.mode !== 'include');
  let out = '';
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const p = { x: (c + 0.5) / cols, y: (r + 0.5) / rows };
      const on = (!incl.length || incl.some((z) => pointInPolygon(p, z.points))) && !excl.some((z) => pointInPolygon(p, z.points));
      out += on ? '1' : '0';
    }
  }
  return out;
}

/**
 * A device's detection grid (`{cols, rows, table}` of '0'/'1', row-major from the top-left, as
 * cameras like Reolink report it) redrawn from the zones. Null when the grid isn't in that
 * shape, so nothing is written to a device Sightline doesn't understand.
 */
export function gridFromZones<T extends { cols?: unknown; rows?: unknown; table?: unknown }>(scope: T | null | undefined, zones: AlertZone[]): (T & { cols: number; rows: number; table: string }) | null {
  if (!scope) return null;
  const cols = Number(scope.cols);
  const rows = Number(scope.rows);
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 2 || cols * rows > 20_000) return null;
  if (typeof scope.table !== 'string' || scope.table.length !== cols * rows || /[^01]/.test(scope.table)) return null;
  return { ...scope, cols, rows, table: rasterize(zones, cols, rows) };
}

/** Index of the polygon vertex near `p` (within `radius`, normalized units), or -1. */
export function nearestVertex(points: Pt[], p: Pt, radius: number, aspect = 1): number {
  let best = -1;
  let bestD = radius * radius;
  points.forEach((q, i) => {
    const dx = (q.x - p.x) * aspect;
    const dy = q.y - p.y;
    const d = dx * dx + dy * dy;
    if (d <= bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

/** Plain-language summary: "Alert only for vehicles here" / "Ignore everything here". */
export function describeZone(z: AlertZone): string {
  const what = z.objects.length ? listOf(z.objects.map((o) => ZONE_OBJECTS.find((x) => x.v === o)?.label.toLowerCase() ?? o)) : null;
  if (z.mode === 'include') return what ? `Alert only for ${what} here` : 'Alert only for things here';
  return what ? `Ignore ${what} here` : 'Ignore everything here';
}

function listOf(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Polygon area (normalized units), for skipping slivers. */
export function polygonArea(points: Pt[]): number {
  let a = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) a += (points[j].x + points[i].x) * (points[j].y - points[i].y);
  return Math.abs(a / 2);
}

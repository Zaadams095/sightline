/**
 * Demo mode's sample cameras and everything that "happened" on them. Pure (no React Native),
 * so it's unit-tested in test/demo.test.ts.
 *
 * Events are laid out on a fixed grid of absolute time slots (one per camera every
 * `periodMin`), so the same moment always has the same id and objects, and the newest
 * events are never older than one slot: the demo always looks like it's happening now.
 */
import type { Camera, HealthReport, MotionPoint, RecordingSegment, ReviewItem, SearchHit, Severity } from '@/systems/types';

export const DEMO_SYSTEM_ID = 'demo';
export const DEMO_SYSTEM_NAME = 'Sample cameras';

/** Clip files bundled per camera (see systems/demo/media.ts). */
export type DemoClip = 'live' | 'event';

/** Still images bundled with the app. */
export type DemoStill =
  | 'front-door-live'
  | 'front-door-event'
  | 'front-door-ring'
  | 'front-door-package'
  | 'driveway-live'
  | 'driveway-street'
  | 'driveway-event'
  | 'backyard-live'
  | 'backyard-event'
  | 'garage-live'
  | 'garage-event'
  | 'living-room-live'
  | 'living-room-event';

export interface DemoEventKind {
  objects: string[];
  subLabels?: string[];
  severity: Severity;
  zones: string[];
  thumb: DemoStill;
  /** Which clip shows it, and how many seconds into that clip the action starts. */
  clip: DemoClip;
  lead: number;
  /** Seconds of activity. */
  duration: number;
  weight: number;
  /** Where the object's feet were (0–1), for alert masks. */
  at: { x: number; y: number };
}

export interface DemoCameraDef {
  id: string;
  name: string;
  aspect: number;
  ptz: boolean;
  zones: string[];
  objects: string[];
  /** Average minutes between events. */
  periodMin: number;
  /** Chance a slot has an event, by day (7–22 h) and night. */
  dayChance: number;
  nightChance: number;
  kinds: DemoEventKind[];
  /** Width/height of the bundled video when it's wider than the camera view (pannable). */
  panAspect?: number;
}

const COURIER = { clip: 'event' as const, lead: 1, duration: 13 };

export const DEMO_CAMERAS: DemoCameraDef[] = [
  {
    id: 'front-door',
    name: 'Front Door',
    aspect: 4 / 3,
    ptz: false,
    zones: ['Porch', 'Walkway'],
    // 'doorbell' marks it as a video doorbell (see alerts/rules isDoorbellCamera).
    objects: ['person', 'package', 'doorbell'],
    periodMin: 41,
    dayChance: 0.85,
    nightChance: 0.2,
    kinds: [
      { objects: ['person', 'doorbell'], severity: 'alert', zones: ['Porch'], thumb: 'front-door-ring', weight: 3, at: { x: 0.52, y: 0.94 }, ...COURIER },
      { objects: ['person', 'package'], severity: 'alert', zones: ['Porch', 'Walkway'], thumb: 'front-door-package', weight: 3, at: { x: 0.67, y: 0.9 }, ...COURIER },
      { objects: ['person'], severity: 'alert', zones: ['Walkway'], thumb: 'front-door-event', weight: 2, at: { x: 0.5, y: 0.7 }, ...COURIER },
      { objects: ['person'], subLabels: ['Sam'], severity: 'detection', zones: ['Walkway'], thumb: 'front-door-event', weight: 2, at: { x: 0.5, y: 0.7 }, ...COURIER },
    ],
  },
  {
    id: 'driveway',
    name: 'Driveway',
    aspect: 16 / 9,
    ptz: true,
    panAspect: 1280 / 480,
    zones: ['Driveway', 'Street'],
    objects: ['car', 'person'],
    periodMin: 67,
    dayChance: 0.8,
    nightChance: 0.25,
    kinds: [
      { objects: ['car'], subLabels: ['Family car'], severity: 'alert', zones: ['Driveway'], thumb: 'driveway-event', clip: 'event', lead: 1, duration: 11, weight: 2, at: { x: 0.5, y: 0.9 } },
      { objects: ['car'], severity: 'alert', zones: ['Driveway'], thumb: 'driveway-event', clip: 'event', lead: 1, duration: 11, weight: 2, at: { x: 0.5, y: 0.9 } },
      { objects: ['car'], severity: 'detection', zones: ['Street'], thumb: 'driveway-street', clip: 'live', lead: 2, duration: 6, weight: 4, at: { x: 0.5, y: 0.42 } },
    ],
  },
  {
    id: 'backyard',
    name: 'Backyard',
    aspect: 16 / 9,
    ptz: false,
    zones: ['Lawn', 'Patio'],
    objects: ['dog', 'person'],
    periodMin: 53,
    dayChance: 0.75,
    nightChance: 0.1,
    kinds: [
      { objects: ['dog'], severity: 'alert', zones: ['Lawn'], thumb: 'backyard-event', clip: 'event', lead: 0.6, duration: 10.5, weight: 2, at: { x: 0.45, y: 0.8 } },
      { objects: ['dog'], severity: 'detection', zones: ['Lawn'], thumb: 'backyard-event', clip: 'event', lead: 0.6, duration: 10.5, weight: 3, at: { x: 0.45, y: 0.8 } },
    ],
  },
  {
    id: 'garage',
    name: 'Garage',
    aspect: 16 / 9,
    ptz: false,
    zones: ['Side door'],
    objects: ['person', 'car'],
    periodMin: 127,
    dayChance: 0.7,
    nightChance: 0.3,
    kinds: [
      { objects: ['person'], subLabels: ['Alex'], severity: 'alert', zones: ['Side door'], thumb: 'garage-event', clip: 'event', lead: 1.4, duration: 10.5, weight: 3, at: { x: 0.35, y: 0.75 } },
      { objects: ['person'], severity: 'alert', zones: ['Side door'], thumb: 'garage-event', clip: 'event', lead: 1.4, duration: 10.5, weight: 1, at: { x: 0.35, y: 0.75 } },
    ],
  },
  {
    id: 'living-room',
    name: 'Living Room',
    aspect: 16 / 9,
    ptz: false,
    zones: [],
    objects: ['person'],
    periodMin: 59,
    dayChance: 0.7,
    nightChance: 0.05,
    kinds: [
      { objects: ['person'], subLabels: ['Sam'], severity: 'detection', zones: [], thumb: 'living-room-event', clip: 'event', lead: 0.8, duration: 9.6, weight: 3, at: { x: 0.5, y: 0.94 } },
      { objects: ['person'], severity: 'detection', zones: [], thumb: 'living-room-event', clip: 'event', lead: 0.8, duration: 9.6, weight: 1, at: { x: 0.5, y: 0.94 } },
    ],
  },
];

/** How far back the sample recorder "keeps" video. */
export const DEMO_RETENTION_DAYS = 7;
const DAY = 86400;

export function demoCamera(id: string): DemoCameraDef | undefined {
  return DEMO_CAMERAS.find((c) => c.id === id);
}

export function demoCameras(systemId = DEMO_SYSTEM_ID): Camera[] {
  return DEMO_CAMERAS.map((c) => ({
    key: `${systemId}:${c.id}`,
    systemId,
    id: c.id,
    name: c.name,
    enabled: true,
    zones: c.zones,
    objects: c.objects,
    ptz: c.ptz,
    aspect: c.aspect,
  }));
}

/** Deterministic 0–1 value for (text, n): the same slot always gets the same event. */
export function unit(text: string, n: number): number {
  let h = 2166136261 ^ n;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  h = Math.imul(h ^ (h >>> 15), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export interface DemoEvent extends ReviewItem {
  kind: DemoEventKind;
}

/** The event (if any) in one time slot of one camera. */
function eventInSlot(cam: DemoCameraDef, k: number, systemId: string): DemoEvent | null {
  const period = cam.periodMin * 60;
  const start = Math.floor(k * period + unit(cam.id, k) * period * 0.7);
  const hour = new Date(start * 1000).getHours();
  const chance = hour >= 7 && hour < 22 ? cam.dayChance : cam.nightChance;
  if (unit(`${cam.id}?`, k) >= chance) return null;
  const total = cam.kinds.reduce((s, x) => s + x.weight, 0);
  let pick = unit(`${cam.id}#`, k) * total;
  const kind = cam.kinds.find((x) => (pick -= x.weight) < 0) ?? cam.kinds[0];
  return {
    id: `${cam.id}-${k}`,
    systemId,
    cameraId: cam.id,
    startTime: start,
    endTime: start + kind.duration,
    severity: kind.severity,
    objects: kind.objects,
    subLabels: kind.subLabels ?? [],
    zones: kind.zones,
    reviewed: false,
    detections: [`${cam.id}-${k}`],
    kind,
  };
}

export interface DemoQuery {
  cameras?: string[];
  after?: number;
  before?: number;
  severity?: Severity;
  limit?: number;
}

/**
 * Sample events between `after` and `before` (default: the last 24 hours up to now), newest
 * first. Nothing is ever in the future or older than the retention window. Events still
 * going on at `now` are reported in progress (endTime null), like a real recorder.
 */
export function demoEvents(now: number, q: DemoQuery = {}, systemId = DEMO_SYSTEM_ID): DemoEvent[] {
  const oldest = now - DEMO_RETENTION_DAYS * DAY;
  const after = Math.max(q.after ?? now - DAY, oldest);
  const before = Math.min(q.before ?? now, now);
  if (before <= after) return [];
  const out: DemoEvent[] = [];
  for (const cam of DEMO_CAMERAS) {
    if (q.cameras && !q.cameras.includes(cam.id)) continue;
    const period = cam.periodMin * 60;
    for (let k = Math.floor(after / period) - 1; k <= Math.floor(before / period); k++) {
      const ev = eventInSlot(cam, k, systemId);
      if (!ev || ev.startTime < after || ev.startTime > before) continue;
      if (q.severity && ev.severity !== q.severity) continue;
      if (ev.endTime! > now) ev.endTime = null;
      out.push(ev);
    }
  }
  out.sort((a, b) => b.startTime - a.startTime);
  return q.limit ? out.slice(0, q.limit) : out;
}

/** The event whose clip should play when someone opens recordings at `t`. */
export function demoEventAt(cameraId: string, t: number, now: number): DemoEvent | null {
  // Openers start 5 s before an event; allow a little more either side.
  const near = demoEvents(now, { cameras: [cameraId], after: t - 120, before: t + 30 });
  return near.find((e) => t >= e.startTime - 30 && t <= (e.endTime ?? now) + 5) ?? null;
}

/**
 * What to play for recordings starting at `start`: the event's clip lined up so its action
 * begins at the event's start time, otherwise the quiet scene from `start`.
 */
export function demoPlayback(cameraId: string, start: number, now: number): { clip: DemoClip; fileStart: number } {
  const ev = demoEventAt(cameraId, start, now);
  if (ev) return { clip: ev.kind.clip, fileStart: ev.startTime - ev.kind.lead };
  return { clip: 'live', fileStart: start };
}

/** Continuous recording for the retention window. */
export function demoSegments(after: number, before: number, now: number): RecordingSegment[] {
  const start = Math.max(after, now - DEMO_RETENTION_DAYS * DAY);
  const end = Math.min(before, now);
  return end > start ? [{ start, end }] : [];
}

/** Motion (0–100) per bucket: a little background flicker plus peaks during events. */
export function demoMotion(cameraId: string, after: number, before: number, scaleSec: number, now: number): MotionPoint[] {
  const end = Math.min(before, now);
  if (end <= after || scaleSec <= 0) return [];
  const events = demoEvents(now, { cameras: [cameraId], after: after - 60, before: end });
  const out: MotionPoint[] = [];
  for (let t = Math.floor(after / scaleSec) * scaleSec; t < end; t += scaleSec) {
    let v = Math.round(unit(cameraId, t) * 6);
    for (const e of events) {
      const eEnd = e.endTime ?? now;
      if (t + scaleSec > e.startTime && t < eEnd) v = Math.max(v, 55 + Math.round(unit(e.id, t) * 40));
    }
    out.push({ t, v });
  }
  return out;
}

/** Local dates (YYYY-MM-DD) with recordings, newest first. */
export function demoRecordingDays(now: number): string[] {
  const days: string[] = [];
  for (let i = 0; i < DEMO_RETENTION_DAYS; i++) {
    const d = new Date((now - i * DAY) * 1000);
    days.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  }
  return [...new Set(days)];
}

export const DEMO_KNOWN_NAMES = ['Sam', 'Alex', 'Family car'];

export const DEMO_GROUPS = [
  { name: 'Outside', cameraIds: ['front-door', 'driveway', 'backyard'] },
  { name: 'Inside', cameraIds: ['garage', 'living-room'] },
];

export const DEMO_HEALTH: HealthReport = { offline: [], storage: [{ path: 'Recordings', usedPct: 64, freeGb: 1120 }] };

/** Words people type, mapped to what the sample detector reports. */
const SYNONYMS: Record<string, string[]> = {
  person: ['person', 'people', 'someone', 'somebody', 'man', 'woman', 'human', 'visitor', 'courier', 'delivery', 'driver', 'walking'],
  package: ['package', 'packages', 'parcel', 'box', 'delivery', 'delivered', 'carrying', 'courier'],
  doorbell: ['doorbell', 'ring', 'rang', 'bell', 'door', 'visitor'],
  car: ['car', 'cars', 'vehicle', 'truck', 'suv', 'van', 'pickup', 'auto', 'blue', 'white', 'drove', 'driving', 'parked'],
  dog: ['dog', 'dogs', 'pet', 'puppy', 'animal', 'yard', 'running'],
};

const STOP = new Set(['a', 'an', 'the', 'in', 'on', 'at', 'of', 'to', 'and', 'with', 'my', 'is', 'was', 'by', 'near', 'from']);

/**
 * Plain-words search over the sample events; best matches first, then newest. `still` turns
 * an event's still into an image URL.
 */
export function demoSearch(
  now: number,
  q: { query: string; cameras?: string[]; limit?: number },
  still: (s: DemoStill) => string = (s) => s,
  systemId = DEMO_SYSTEM_ID,
): SearchHit[] {
  const words = q.query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOP.has(w));
  if (!words.length) return [];
  const scored = demoEvents(now, { cameras: q.cameras, after: now - DEMO_RETENTION_DAYS * DAY }, systemId)
    .map((e) => {
      const cam = demoCamera(e.cameraId)!;
      const hay = [
        ...e.objects.flatMap((o) => SYNONYMS[o] ?? [o]),
        ...e.subLabels.map((s) => s.toLowerCase()),
        ...cam.name.toLowerCase().split(' '),
        ...e.zones.map((z) => z.toLowerCase()),
      ];
      const night = new Date(e.startTime * 1000).getHours();
      if (night < 6 || night >= 21) hay.push('night', 'dark');
      return { e, score: words.filter((w) => hay.includes(w)).length };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.e.startTime - a.e.startTime);
  return scored.slice(0, q.limit ?? 60).map(({ e }) => ({
    eventId: e.id,
    systemId: e.systemId,
    cameraId: e.cameraId,
    label: e.objects.includes('package') ? 'package' : e.objects[0],
    subLabel: e.subLabels[0],
    startTime: e.startTime,
    endTime: e.endTime,
    thumbnailUrl: still(e.kind.thumb),
  }));
}

/** Pan/zoom presets for the moving camera (see systems/demo/ptz.ts). */
export const DEMO_PRESETS: Record<string, { pan: number; tilt: number; zoom: number }> = {
  'Whole view': { pan: 0, tilt: 0, zoom: 1 },
  Driveway: { pan: 0, tilt: 0.6, zoom: 1.5 },
  Street: { pan: 0.1, tilt: -0.6, zoom: 1.8 },
  'Front lawn': { pan: -0.9, tilt: 0.4, zoom: 1.3 },
};

import type { CameraInfo, EventRecord } from './engine';

/**
 * What Siri / HomePod answers from ("Who's at the door?", "Any packages today?", "What happened
 * on the backyard?"). The App Intents extension can't reach the cameras (no VPN, no secrets),
 * so the app leaves a small summary in the App Group whenever it has fresh events, the same
 * way it feeds the widgets. Format must match targets/intents/Assistant.swift.
 *
 * Pure (type imports only): unit-tested in test/ask.test.ts.
 */
export const ASSISTANT_FILE = 'siri/events.json';
export const ASSISTANT_HOURS = 48;
const MAX_EVENTS = 150;

export interface AssistantEvent {
  id: string;
  key: string;
  camera: string;
  time: number;
  end: number | null;
  objects: string[];
  names: string[];
  package: boolean;
  doorbell: boolean;
  /** App Group path of a small picture of this event, when one was saved. */
  image: string | null;
}

export interface AssistantPackage {
  key: string;
  camera: string;
  since: number;
  image: string | null;
}

export interface AssistantData {
  version: 1;
  updatedAt: number;
  cameras: { key: string; name: string; door: boolean }[];
  /** Newest first. */
  events: AssistantEvent[];
  /** Packages that look like they're still outside. */
  packages: AssistantPackage[];
}

/** A picture to copy into the App Group. */
export interface ImageJob {
  url: string;
  path: string;
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_');

export interface OpenPackageLike {
  cameraKey: string;
  since: number;
  thumbnailUrl?: string;
  cameraName?: string;
}

/**
 * Builds the summary and the pictures to save: one per camera (its latest event) and one per
 * open package, so the folder stays the same size no matter how busy the cameras are.
 */
export function assistantSnapshot(
  index: EventRecord[],
  cameras: CameraInfo[],
  packages: OpenPackageLike[],
  now: number,
): { data: AssistantData; images: ImageJob[] } {
  const since = now - ASSISTANT_HOURS * 3600;
  const recent = index.filter((e) => e.start >= since).slice(0, MAX_EVENTS);
  const images: ImageJob[] = [];
  const pictured = new Set<string>();
  const httpUrl = (u?: string) => (u && /^https?:\/\//i.test(u) ? u : null);

  const events: AssistantEvent[] = recent.map((e) => {
    let image: string | null = null;
    const url = httpUrl(e.thumbnailUrl);
    if (url && !pictured.has(e.cameraKey)) {
      pictured.add(e.cameraKey);
      image = `siri/img/${safe(e.cameraKey)}.img`;
      images.push({ url, path: image });
    }
    return {
      id: e.id,
      key: e.cameraKey,
      camera: e.camera,
      time: Math.floor(e.start),
      end: e.end == null ? null : Math.floor(e.end),
      objects: e.labels,
      names: e.names,
      package: e.package,
      doorbell: e.doorbell,
      image,
    };
  });

  const nameOf = new Map(cameras.map((c) => [c.key, c.name]));
  const pkgs: AssistantPackage[] = packages.map((p) => {
    const url = httpUrl(p.thumbnailUrl);
    const image = url ? `siri/img/pkg-${safe(p.cameraKey)}.img` : null;
    if (url && image) images.push({ url, path: image });
    return { key: p.cameraKey, camera: nameOf.get(p.cameraKey) ?? p.cameraName ?? p.cameraKey, since: Math.floor(p.since), image };
  });

  return {
    data: {
      version: 1,
      updatedAt: Math.floor(now),
      cameras: cameras.map((c) => ({ key: c.key, name: c.name, door: !!c.door })),
      events,
      packages: pkgs,
    },
    images,
  };
}

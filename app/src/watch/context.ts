import type { Camera, ReviewItem, SystemConfig } from '@/systems/types';

/**
 * What the Apple Watch app gets as its WatchConnectivity application context. Kept pure (no
 * RN imports) so it's unit-tested. The format must match targets/watch/Model.swift.
 */

export const WATCH_CONTEXT_VERSION = 1;
export const MAX_WATCH_CAMERAS = 24;
export const MAX_WATCH_ALERTS = 15;
/** A ring this recent puts the watch on its "Someone's at the door" screen. */
export const WATCH_RING_SEC = 180;

export interface WatchCamera {
  key: string;
  /** The camera's id on its system (for a Hub: the Hub's camera id). */
  id: string;
  name: string;
  doorbell: boolean;
  /** Set when the camera comes from a Sightline Hub: that Hub's system id (see `hubs`). */
  hub?: string;
}

export interface WatchAlert {
  id: string;
  key: string;
  title: string;
  camera: string;
  /** Unix seconds. */
  time: number;
  doorbell: boolean;
}

export interface WatchHub {
  id: string;
  name: string;
  lanUrl: string;
  remoteUrl: string;
}

export interface WatchContext {
  v: number;
  cameras: WatchCamera[];
  alerts: WatchAlert[];
  ring: WatchAlert | null;
  hubs: WatchHub[];
  updatedAt: number;
}

export interface AlertInput {
  item: ReviewItem;
  title: string;
  cameraName: string;
}

const isDoorbellItem = (i: { objects: string[] }) => i.objects.includes('doorbell');
const isDoorbellCam = (c: { objects: string[]; name: string }) => c.objects.includes('doorbell') || /door\s*bell/i.test(c.name);

export function buildWatchContext(input: {
  cameras: Camera[];
  alerts: AlertInput[];
  systems: SystemConfig[];
  now: number;
  /** A ring the phone just saw (may not be in `alerts` yet). */
  ring?: WatchAlert | null;
}): WatchContext {
  const hubIds = new Set(input.systems.filter((s) => s.kind === 'hub').map((s) => s.id));
  const cameras: WatchCamera[] = input.cameras
    .filter((c) => c.enabled)
    .slice(0, MAX_WATCH_CAMERAS)
    .map((c) => ({
      key: c.key,
      id: c.id,
      name: c.name,
      doorbell: isDoorbellCam(c),
      ...(hubIds.has(c.systemId) ? { hub: c.systemId } : {}),
    }));

  const seen = new Set<string>();
  const alerts: WatchAlert[] = [...input.alerts]
    .sort((a, b) => b.item.startTime - a.item.startTime)
    .filter(({ item }) => {
      const id = `${item.systemId}:${item.id}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .slice(0, MAX_WATCH_ALERTS)
    .map(({ item, title, cameraName }) => ({
      id: item.id,
      key: `${item.systemId}:${item.cameraId}`,
      title,
      camera: cameraName,
      time: Math.floor(item.startTime),
      doorbell: isDoorbellItem(item),
    }));

  const fresh = (a: WatchAlert | null | undefined) => !!a && input.now - a.time <= WATCH_RING_SEC && a.time <= input.now + 30;
  const latestRing = alerts.find((a) => a.doorbell) ?? null;
  const candidates = [input.ring, latestRing].filter(fresh) as WatchAlert[];
  const ring = candidates.sort((a, b) => b.time - a.time)[0] ?? null;

  const hubs: WatchHub[] = input.systems
    .filter((s) => s.kind === 'hub')
    .map((s) => ({ id: s.id, name: s.extra?.hubName || s.name, lanUrl: s.endpoint.lanUrl.replace(/\/+$/, ''), remoteUrl: (s.extra?.remoteUrl ?? '').replace(/\/+$/, '') }));

  return { v: WATCH_CONTEXT_VERSION, cameras, alerts, ring, hubs, updatedAt: Math.floor(input.now) };
}

/** Parses a watch request body; null when it isn't one we know. */
export type WatchRequest = { type: 'snapshot'; key: string; size: number } | { type: 'refresh' };

export function parseWatchRequest(body: string): WatchRequest | null {
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (m.type === 'refresh') return { type: 'refresh' };
  if (m.type === 'snapshot' && typeof m.key === 'string' && m.key.includes(':')) {
    const size = typeof m.size === 'number' && m.size >= 64 && m.size <= 1024 ? Math.round(m.size) : 300;
    return { type: 'snapshot', key: m.key, size };
  }
  return null;
}

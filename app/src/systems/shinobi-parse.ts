import type { PtzAction } from './types';

/**
 * Pure mapping for Shinobi's API-key REST API (https://docs.shinobi.video/api). Routes are
 * `/{apiKey}/<what>/{groupKey}/...` (Shinobi libs/webServerPaths.js).
 */

export interface ShinobiMonitor {
  mid?: string;
  ke?: string;
  name?: string;
  mode?: string;
  status?: string;
  width?: number | string;
  height?: number | string;
  /** An object in current builds, a JSON string in older ones. */
  details?: string | Record<string, unknown>;
}

export interface ShinobiCamera {
  id: string;
  name: string;
  enabled: boolean;
  ptz: boolean;
  aspect: number;
  streamType: string;
  /** Running per its status text (watching / recording / started). */
  online: boolean;
  /** Supposed to run (mode start/record) but isn't. */
  failed: boolean;
}

/** Auth failures come back as HTTP 200 `{ok:false, msg:"Not Authorized"}` (libs/auth.js). */
export function authFailure(body: unknown): string | null {
  if (body && typeof body === 'object' && !Array.isArray(body) && (body as { ok?: boolean }).ok === false) {
    return (body as { msg?: string }).msg ?? 'refused';
  }
  return null;
}

export function details(m: { details?: string | Record<string, unknown> }): Record<string, unknown> {
  if (!m.details) return {};
  if (typeof m.details === 'object') return m.details;
  try {
    return JSON.parse(m.details) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const ONLINE = ['watching', 'recording', 'started'];
const TRANSIENT = ['starting', 'restarting', 'stopping'];

export function parseMonitors(list: ShinobiMonitor[]): ShinobiCamera[] {
  return list
    .filter((m) => m.mid)
    .map((m) => {
      const d = details(m);
      const w = Number(m.width);
      const h = Number(m.height);
      const status = (m.status ?? '').toLowerCase();
      const enabled = m.mode !== 'stop';
      return {
        id: m.mid!,
        name: m.name?.trim() || m.mid!,
        enabled,
        ptz: d.control === '1' || d.control === 1,
        aspect: w > 0 && h > 0 ? w / h : 16 / 9,
        streamType: String(d.stream_type ?? 'hls'),
        online: ONLINE.includes(status),
        failed: enabled && !!status && !ONLINE.includes(status) && !TRANSIENT.includes(status),
      };
    });
}

/**
 * Live path for a monitor's configured Stream Type (docs "Get Streams"). Only HLS and MJPEG
 * play on iPhone; FLV, raw H.264, "Poseidon" MP4 and websocket JPEG don't.
 */
export function livePath(key: string, group: string, mid: string, streamType: string): { kind: 'hls' | 'mjpeg'; path: string } | null {
  const base = `/${encodeURIComponent(key)}`;
  const tail = `${encodeURIComponent(group)}/${encodeURIComponent(mid)}`;
  if (streamType === 'hls') return { kind: 'hls', path: `${base}/hls/${tail}/s.m3u8` };
  if (streamType === 'mjpeg') return { kind: 'mjpeg', path: `${base}/mjpeg/${tail}` };
  return null;
}

export interface ShinobiVideo {
  mid?: string;
  time?: string;
  end?: string;
  ext?: string;
  href?: string;
  filename?: string;
  status?: number;
}

export interface Video {
  cameraId: string;
  start: number;
  end: number;
  href: string;
  ext: string;
}

/**
 * `/videos` rows. `time`/`end` are ISO with the server's UTC offset (moment.format(), see
 * libs/videos.js), so Date.parse is exact. `href` plays the file (use it as given).
 */
export function parseVideos(body: { videos?: ShinobiVideo[] }, parse: (s: string) => number): Video[] {
  return (body.videos ?? [])
    .filter((v) => v.mid && v.time && v.href)
    .map((v) => {
      const start = parse(v.time!);
      const end = v.end ? parse(v.end) : NaN;
      return { cameraId: v.mid!, start, end: Number.isFinite(end) && end > start ? end : start + 60, href: v.href!, ext: (v.ext ?? 'mp4').toLowerCase() };
    })
    .filter((v) => Number.isFinite(v.start));
}

export interface ShinobiEvent {
  mid?: string;
  time?: string;
  details?: string | { reason?: string; confidence?: number; plug?: string; matrices?: { tag?: string }[] };
}

export interface EventGroup {
  cameraId: string;
  start: number;
  end: number;
  objects: string[];
  motionOnly: boolean;
}

/**
 * Shinobi logs one event row per trigger (often several per second), so rows on the same
 * camera less than `gapSec` apart are merged into one review item.
 */
export function groupEvents(rows: ShinobiEvent[], parse: (s: string) => number, gapSec = 30): EventGroup[] {
  const parsed = rows
    .filter((r) => r.mid && r.time)
    .map((r) => {
      const d = details(r as { details?: string | Record<string, unknown> }) as {
        reason?: string;
        matrices?: { tag?: string }[];
      };
      const tags = (d.matrices ?? []).map((m) => (m.tag ?? '').toLowerCase()).filter(Boolean);
      return { cameraId: r.mid!, t: parse(r.time!), tags };
    })
    .filter((r) => Number.isFinite(r.t))
    .sort((a, b) => a.t - b.t);
  const open = new Map<string, EventGroup>();
  const out: EventGroup[] = [];
  for (const r of parsed) {
    let g = open.get(r.cameraId);
    if (!g || r.t - g.end > gapSec) {
      g = { cameraId: r.cameraId, start: r.t, end: r.t, objects: [], motionOnly: true };
      open.set(r.cameraId, g);
      out.push(g);
    }
    g.end = Math.max(g.end, r.t);
    for (const t of r.tags) if (!g.objects.includes(t)) g.objects.push(t);
    if (r.tags.length) g.motionOnly = false;
  }
  // Give instantaneous groups a minimal length so they show on a timeline.
  for (const g of out) if (g.end - g.start < 5) g.end = g.start + 5;
  return out.sort((a, b) => b.start - a.start);
}

/** `/control/{group}/{mid}/{direction}` names (libs/control/ptz.js). */
export const PTZ_DIRECTION: Record<PtzAction, string> = {
  MOVE_UP: 'up',
  MOVE_DOWN: 'down',
  MOVE_LEFT: 'left',
  MOVE_RIGHT: 'right',
  ZOOM_IN: 'zoom_in',
  ZOOM_OUT: 'zoom_out',
  STOP: 'stopMove',
};

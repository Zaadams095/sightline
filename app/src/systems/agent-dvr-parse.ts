import type { HealthReport } from './types';
import { tr } from '../i18n/index.ts';

/**
 * Pure mapping for Agent DVR (iSpy). Reference: the official Swagger spec
 * https://ispysoftware.github.io/Agent_API/swagger.yaml (v8), agent-py
 * (github.com/ispysoftware/agent-py, used by Home Assistant) and the ioBroker adapter.
 */

export interface AgentObject {
  id?: number;
  oid?: number;
  typeID?: number;
  ot?: number;
  name?: string;
  groups?: string;
  data?: {
    online?: boolean;
    connected?: boolean;
    recording?: boolean;
    ptzid?: number;
    width?: number;
    height?: number;
    mjpegStreamWidth?: number;
    mjpegStreamHeight?: number;
  };
}

export interface AgentCamera {
  id: string;
  name: string;
  ptz: boolean;
  aspect: number;
  enabled: boolean;
  connected: boolean;
}

/** `typeID` 2 = camera (1 = microphone). PTZ when `ptzid` isn't -1 (agent-py `has_ptz`). */
export function parseObjects(body: { objectList?: AgentObject[] } | AgentObject[]): AgentCamera[] {
  const list = Array.isArray(body) ? body : (body.objectList ?? []);
  return list
    .filter((o) => (o.typeID ?? o.ot) === 2)
    .map((o) => {
      const d = o.data ?? {};
      const w = d.width || d.mjpegStreamWidth;
      const h = d.height || d.mjpegStreamHeight;
      const id = String(o.id ?? o.oid);
      return {
        id,
        name: o.name?.trim() || tr().systems.common.cameraN(id),
        ptz: d.ptzid != null && d.ptzid !== -1,
        aspect: w && h ? w / h : 16 / 9,
        enabled: d.online !== false,
        connected: d.connected !== false,
      };
    });
}

/** One recording from `/q/getEvents`: `fn` file name, `tg` tags (AI labels), `c` .NET ticks, `d` seconds. */
export interface AgentEvent {
  fn?: string;
  tg?: string;
  c?: number | string;
  d?: number | string;
  sb?: number;
}

export interface AgentRecording {
  cameraId: string;
  fn: string;
  start: number;
  end: number;
  labels: string[];
}

/** .NET ticks (100 ns since 0001-01-01, UTC per the spec's "UTC javascript ticks") → unix seconds. */
export function ticksToUnix(c: number | string): number {
  return (Number(c) - 621355968000000000) / 1e7;
}

export function parseEvents(cameraId: string, body: { events?: AgentEvent[] } | AgentEvent[]): AgentRecording[] {
  const list = Array.isArray(body) ? body : (body.events ?? []);
  return list
    .filter((e) => e.fn && e.c != null)
    .map((e) => {
      const start = ticksToUnix(e.c!);
      const dur = Math.max(1, Number(e.d) || 0);
      return {
        cameraId,
        fn: e.fn!,
        start,
        end: start + dur,
        // Tags are free text the user or AI adds ("person,car" or "person car").
        labels: [...new Set((e.tg ?? '').toLowerCase().split(/[\s,;]+/).filter(Boolean))],
      };
    })
    .filter((r) => Number.isFinite(r.start));
}

/** Thumbnail name the web UI uses: the recording name with `_large.jpg` instead of its extension. */
export function thumbName(fn: string): string {
  const dot = fn.lastIndexOf('.');
  return `${dot > 0 ? fn.slice(0, dot) : fn}_large.jpg`;
}

/** Recording id that round-trips to (camera, file). */
export const recordingId = (cameraId: string, fn: string) => `${cameraId}|${fn}`;

/** PTZ direction codes for `/ptz.cgi?dir=` (spec: 0 center, 1 left, 3 up, 5 right, 7 down, 9/10 zoom, 11 stop). */
export const PTZ_DIR = {
  MOVE_LEFT: 1,
  MOVE_UP: 3,
  MOVE_RIGHT: 5,
  MOVE_DOWN: 7,
  ZOOM_IN: 9,
  ZOOM_OUT: 10,
  STOP: 11,
} as const;

/** Sizes like "123.4 GB" / "512 MB" → GB. */
export function sizeToGb(s: string | number | undefined): number {
  if (typeof s === 'number') return s;
  const m = /([\d.]+)\s*([KMGT]?)B?/i.exec(s ?? '');
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  const f = unit === 'T' ? 1024 : unit === 'G' ? 1 : unit === 'M' ? 1 / 1024 : unit === 'K' ? 1 / 1048576 : 1 / 1073741824;
  return Math.round(n * f * 10) / 10;
}

/** `/command/getSystemStats`: disks [{n: name, d: free, u: used, p: percent used}]. */
export function parseStorage(stats: { disks?: { n?: string; d?: string; u?: string; p?: number }[] }): HealthReport['storage'] {
  return (stats.disks ?? []).map((k) => ({
    path: k.n ?? '',
    usedPct: Math.round(Number(k.p) || 0),
    freeGb: sizeToGb(k.d),
  }));
}

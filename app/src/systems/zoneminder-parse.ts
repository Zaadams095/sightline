import type { PtzAction } from './types';

/**
 * Pure mapping for the ZoneMinder 1.36/1.37 API (https://zoneminder.readthedocs.io/en/latest/api.html),
 * following zmNinja (the official mobile client, www/js/NVR.js) where the docs are thin.
 */

export interface ZmLogin {
  access_token?: string;
  access_token_expires?: number | string;
  refresh_token?: string;
  credentials?: string;
  append_password?: number | string;
  version?: string;
}

export type ZmAuth = { kind: 'none' } | { kind: 'token'; token: string; expiresAt: number } | { kind: 'legacy'; query: string };

/**
 * login.json → how to authorize later requests. `access_token_expires` is a duration in
 * seconds. No token and no legacy credentials means authentication is off (zmNinja).
 */
export function parseLogin(r: ZmLogin, password: string, now: number): ZmAuth {
  if (r.access_token) {
    return { kind: 'token', token: r.access_token, expiresAt: now + (Number(r.access_token_expires) || 3600) };
  }
  if (r.credentials) {
    const query = String(r.append_password) === '1' ? `${r.credentials}${encodeURIComponent(password)}` : r.credentials;
    return { kind: 'legacy', query };
  }
  return { kind: 'none' };
}

/** Query string fragment that authorizes a URL (`token=…` or legacy `auth=…`). */
export function authQuery(a: ZmAuth): string {
  if (a.kind === 'token') return `token=${encodeURIComponent(a.token)}`;
  if (a.kind === 'legacy') return a.query;
  return '';
}

/**
 * ZM_PATH_ZMS (e.g. "/zm/cgi-bin/nph-zms") is relative to the web root. When the saved
 * address already includes a path (http://host/zm), that prefix is already in the base URL.
 */
export function zmsPath(value: string | undefined, basePath: string, portal: string): string {
  const prefix = basePath.replace(/\/$/, '');
  if (!value) return `${portal}/cgi-bin/nph-zms`;
  if (prefix && value.startsWith(`${prefix}/`)) return value.slice(prefix.length);
  return value;
}

export interface ZmMonitorRow {
  Monitor?: {
    Id?: string;
    Name?: string;
    Type?: string;
    Function?: string;
    Capturing?: string;
    Enabled?: string;
    Deleted?: string | boolean;
    Width?: string;
    Height?: string;
    Controllable?: string;
    ControlId?: string;
    Sequence?: string;
  };
  Monitor_Status?: { Status?: string; CaptureFPS?: string };
}

export interface ZmMonitor {
  id: string;
  name: string;
  enabled: boolean;
  ptz: boolean;
  controlId: string;
  width: number;
  height: number;
  /** Supposed to capture but not connected. */
  offline: boolean;
}

export function parseMonitors(rows: ZmMonitorRow[]): ZmMonitor[] {
  return rows
    .map((r) => ({ m: r.Monitor ?? {}, s: r.Monitor_Status ?? {} }))
    .filter(({ m }) => m.Id && m.Type !== 'WebSite' && m.Deleted !== true && m.Deleted !== '1')
    .sort((a, b) => Number(a.m.Sequence ?? 0) - Number(b.m.Sequence ?? 0))
    .map(({ m, s }) => {
      // 1.36: Function None = off. 1.37 adds Capturing (None/Ondemand/Always).
      const capturing = m.Capturing ? m.Capturing !== 'None' : m.Function !== 'None';
      const enabled = capturing && m.Enabled !== '0';
      const status = s.Status ?? '';
      return {
        id: String(m.Id),
        name: m.Name?.trim() || `Camera ${m.Id}`,
        enabled,
        ptz: m.Controllable === '1',
        controlId: m.ControlId ?? '',
        width: Number(m.Width) || 0,
        height: Number(m.Height) || 0,
        offline: enabled && !!status && status !== 'Connected' && status !== 'Signal' && status !== 'Running',
      };
    });
}

/**
 * Event filter path: `/events/index/MonitorId:N/EndTime >=:A/StartTime <=:B.json` (zmNinja).
 * Spaces are %20, the operator's `:` stays literal, comparison signs are percent-encoded.
 */
export function eventsPath(api: string, opts: { monitorId?: string; after: string; before: string; startedAfter?: boolean }): string {
  const enc = (s: string) => encodeURIComponent(s).replace(/%3A/gi, ':');
  const parts = [
    opts.monitorId ? `MonitorId:${enc(opts.monitorId)}` : null,
    // An event still recording has no EndTime yet (NULL), so `EndTime >=` never matches it;
    // `startedAfter` filters on StartTime instead to find those.
    `${opts.startedAfter ? 'StartTime' : 'EndTime'}${enc(' >=')}:${enc(opts.after)}`,
    `StartTime${enc(' <=')}:${enc(opts.before)}`,
  ].filter(Boolean);
  return `${api}/events/index/${parts.join('/')}.json`;
}

/**
 * Whether a cached events query can answer [after, before]: the cache spans it, and either it
 * holds every match or (results being newest first and cut at a limit) its oldest event is
 * already at or before `after`.
 */
export function eventCacheCovers(
  hit: { after: number; before: number; complete: boolean; events: { start: number }[] } | undefined,
  after: number,
  before: number,
): boolean {
  if (!hit || hit.after > after || hit.before < before) return false;
  if (hit.complete) return true;
  return hit.events.length > 0 && Math.min(...hit.events.map((e) => e.start)) <= after;
}

export interface ZmEventRow {
  Event?: {
    Id?: string;
    MonitorId?: string;
    Cause?: string;
    Notes?: string;
    StartTime?: string;
    StartDateTime?: string;
    EndTime?: string | null;
    EndDateTime?: string | null;
    Length?: string;
    Frames?: string;
    DefaultVideo?: string;
    Archived?: string;
  };
}

export interface ZmEvent {
  id: string;
  cameraId: string;
  start: number;
  end: number | null;
  length: number;
  frames: number;
  objects: string[];
  cause: string;
  video: boolean;
}

/**
 * Object labels from Notes. zmeventnotification writes e.g.
 * "[a] detected:person:97% car:61%  Motion: Driveway"; anything after "Motion:" is zones.
 */
export function notesObjects(notes: string | undefined): string[] {
  const m = /detected:(.*)/i.exec(notes ?? '');
  if (!m) return [];
  const body = m[1].split(/\bmotion:/i)[0];
  const out: string[] = [];
  for (const tok of body.split(/[\s,]+/)) {
    const label = tok.replace(/:?\d+(\.\d+)?%$/, '').replace(/^\[.\]$/, '').trim().toLowerCase();
    if (label && /^[a-z][a-z _-]*$/.test(label) && !out.includes(label)) out.push(label);
  }
  return out;
}

export function parseEvents(rows: ZmEventRow[], parseTime: (s: string) => number): ZmEvent[] {
  return rows
    .map((r) => r.Event ?? {})
    .filter((e) => e.Id && e.MonitorId && (e.StartDateTime || e.StartTime))
    .map((e) => {
      const start = parseTime((e.StartDateTime || e.StartTime)!);
      const endStr = e.EndDateTime || e.EndTime;
      const end = endStr ? parseTime(endStr) : null;
      return {
        id: String(e.Id),
        cameraId: String(e.MonitorId),
        start,
        end: end != null && Number.isFinite(end) ? end : null,
        length: Number(e.Length) || 0,
        frames: Number(e.Frames) || 0,
        objects: notesObjects(e.Notes),
        cause: e.Cause ?? '',
        video: !!e.DefaultVideo,
      };
    })
    .filter((e) => Number.isFinite(e.start));
}

/** Frame to start an MJPEG event replay at `offsetSec` (events store Frames over Length seconds). */
export function frameAt(e: { length: number; frames: number }, offsetSec: number): number {
  if (e.length <= 0 || e.frames <= 0 || offsetSec <= 0) return 1;
  return Math.min(e.frames, Math.max(1, Math.round((offsetSec * e.frames) / e.length)));
}

export interface ZmControl {
  CanMoveCon?: string;
  CanMoveRel?: string;
  CanMoveAbs?: string;
  CanMove?: string;
  CanZoom?: string;
  CanZoomCon?: string;
  CanZoomRel?: string;
  HasPresets?: string;
  NumPresets?: string;
  HasHomePreset?: string;
}

export interface PtzCaps {
  movePrefix: string;
  zoomPrefix: string;
  canMove: boolean;
  canZoom: boolean;
  presets: string[];
}

/** Move commands follow the control's capabilities: moveCon > moveRel > moveAbs (zmNinja). */
export function ptzCaps(c: ZmControl | undefined): PtzCaps {
  const on = (v?: string) => v === '1';
  const movePrefix = on(c?.CanMoveCon) ? 'moveCon' : on(c?.CanMoveRel) ? 'moveRel' : on(c?.CanMoveAbs) ? 'moveAbs' : 'moveCon';
  const zoomPrefix = on(c?.CanZoomCon) ? 'zoomCon' : 'zoomRel';
  const n = on(c?.HasPresets) ? Math.min(20, Number(c?.NumPresets) || 0) : 0;
  const presets = [...(on(c?.HasHomePreset) ? ['Home'] : []), ...Array.from({ length: n }, (_, i) => `Preset ${i + 1}`)];
  return {
    movePrefix,
    zoomPrefix,
    canMove: !c || on(c.CanMove) || on(c.CanMoveCon) || on(c.CanMoveRel) || on(c.CanMoveAbs),
    canZoom: !!c && (on(c.CanZoom) || on(c.CanZoomCon) || on(c.CanZoomRel)),
    presets,
  };
}

/** The `control=` value for a PTZ action or preset name. */
export function ptzCommand(caps: PtzCaps, action: PtzAction | `preset_${string}`): string | null {
  if (action.startsWith('preset_')) {
    const name = action.slice('preset_'.length);
    if (name === 'Home') return 'presetHome';
    const n = /(\d+)$/.exec(name)?.[1];
    return n ? `presetGoto${n}` : null;
  }
  switch (action as PtzAction) {
    case 'MOVE_UP':
      return `${caps.movePrefix}Up`;
    case 'MOVE_DOWN':
      return `${caps.movePrefix}Down`;
    case 'MOVE_LEFT':
      return `${caps.movePrefix}Left`;
    case 'MOVE_RIGHT':
      return `${caps.movePrefix}Right`;
    case 'ZOOM_IN':
      return `${caps.zoomPrefix}Tele`;
    case 'ZOOM_OUT':
      return `${caps.zoomPrefix}Wide`;
    case 'STOP':
      return 'moveStop';
  }
  return null;
}

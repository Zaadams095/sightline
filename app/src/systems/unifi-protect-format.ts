import type { Camera, PtzAction, ReviewItem, Severity } from '@/systems/types';
import { tr } from '../i18n/index.ts';

/**
 * Pure helpers for the UniFi Protect private API on UniFi OS consoles (no React Native
 * imports, so they run under `node --test`). The API is unofficial; field names follow the
 * open-source `uiprotect` library used by Home Assistant (github.com/uilibs/uiprotect) and
 * hjdhjd's `unifi-protect` / homebridge-unifi-protect.
 */

// ---------------------------------------------------------------------------------------------
// Bootstrap (GET /proxy/protect/api/bootstrap)

export interface ProtectChannel {
  /** 0 = high, 1 = medium, 2 = low, 3 = package camera (uiprotect quality_for_channel_id). */
  id: number;
  name?: string;
  enabled?: boolean;
  isRtspEnabled?: boolean;
  rtspAlias?: string | null;
  width?: number;
  height?: number;
}

export interface ProtectStepRange {
  steps?: { min?: number | null; max?: number | null; step?: number | null };
}

export interface ProtectCamera {
  id: string;
  name?: string | null;
  displayName?: string | null;
  marketName?: string;
  type?: string;
  state?: string;
  isConnected?: boolean;
  isAdopted?: boolean;
  isAdoptedByOther?: boolean;
  isRecording?: boolean;
  isThirdPartyCamera?: boolean;
  channels?: ProtectChannel[];
  featureFlags?: {
    isDoorbell?: boolean;
    hasChime?: boolean;
    hasSmartDetect?: boolean;
    smartDetectTypes?: string[];
    smartDetectAudioTypes?: string[];
    canOpticalZoom?: boolean;
    isPtz?: boolean | null;
    hasPackageCamera?: boolean;
    zoom?: ProtectStepRange;
  };
  ispSettings?: { zoomPosition?: number };
}

export interface ProtectBootstrap {
  nvr?: {
    name?: string;
    host?: string;
    hosts?: string[];
    version?: string;
    ports?: { rtsp?: number; rtsps?: number };
    systemInfo?: { storage?: { size?: number; used?: number; available?: number } };
  };
  cameras?: ProtectCamera[];
}

const isDoorbell = (c: ProtectCamera) => !!(c.featureFlags?.isDoorbell ?? c.featureFlags?.hasChime);

/** Detection labels Protect can produce, normalized to the app's vocabulary. */
const SMART_LABELS: Record<string, string> = {
  person: 'person',
  vehicle: 'vehicle',
  car: 'vehicle',
  animal: 'animal',
  pet: 'animal',
  package: 'package',
  licensePlate: 'vehicle',
  face: 'person',
  alrmSmoke: 'smoke alarm',
  alrmCmonx: 'CO alarm',
  smoke_cmonx: 'smoke alarm',
  alrmSiren: 'siren',
  alrmBabyCry: 'baby crying',
  alrmSpeak: 'speech',
  alrmBark: 'dog barking',
  alrmBurglar: 'burglar alarm',
  alrmCarHorn: 'car horn',
  alrmGlassBreak: 'glass breaking',
};

export function smartLabel(t: string): string {
  return SMART_LABELS[t] ?? t.replace(/^alrm/, '').toLowerCase();
}

export function mapCameras(boot: ProtectBootstrap, systemId: string): Camera[] {
  return (boot.cameras ?? [])
    .filter((c) => c.isAdopted !== false && !c.isAdoptedByOther)
    .map((c) => {
      const f = c.featureFlags ?? {};
      const main = c.channels?.find((ch) => ch.id === 0) ?? c.channels?.[0];
      const objects = new Set<string>(['motion']);
      if (f.hasSmartDetect !== false) for (const t of f.smartDetectTypes ?? []) objects.add(smartLabel(t));
      for (const t of f.smartDetectAudioTypes ?? []) objects.add(smartLabel(t));
      if (isDoorbell(c)) objects.add('doorbell');
      return {
        key: `${systemId}:${c.id}`,
        systemId,
        id: c.id,
        name: c.displayName || c.name || c.marketName || tr().systems.common.camera,
        enabled: true,
        zones: [],
        objects: [...objects],
        ptz: !!f.isPtz || !!f.canOpticalZoom,
        aspect: main?.width && main?.height ? main.width / main.height : 16 / 9,
      };
    });
}

/** Cameras that are adopted but not connected to the console. */
export function offlineCameras(boot: ProtectBootstrap): string[] {
  return (boot.cameras ?? [])
    .filter((c) => c.isAdopted !== false && !c.isAdoptedByOther)
    .filter((c) => (c.isConnected === undefined ? c.state !== 'CONNECTED' : !c.isConnected))
    .map((c) => c.id);
}

export function storageOf(boot: ProtectBootstrap): { path: string; usedPct: number; freeGb: number }[] {
  const s = boot.nvr?.systemInfo?.storage;
  if (!s?.size) return [];
  const used = s.used ?? s.size - (s.available ?? 0);
  return [
    {
      path: tr().systems.common.recordingDrive,
      usedPct: Math.round((used / s.size) * 100),
      freeGb: Math.round(((s.available ?? s.size - used) / 1e9) * 10) / 10,
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// Live video

/**
 * The stream channel to use. Main = the highest quality (id 0); sub = the lowest available.
 * The package camera (id 3, on doorbells with two lenses) is never chosen.
 */
export function pickChannel(cam: ProtectCamera, quality: 'main' | 'sub'): ProtectChannel | null {
  const chans = (cam.channels ?? []).filter((c) => c.id !== 3 && c.enabled !== false).sort((a, b) => a.id - b.id);
  if (!chans.length) return null;
  const withRtsp = chans.filter((c) => c.isRtspEnabled && c.rtspAlias);
  const pool = withRtsp.length ? withRtsp : chans;
  return quality === 'sub' ? pool[pool.length - 1] : pool[0];
}

/**
 * Protect restreams every RTSP-enabled channel as `rtsps://<console>:7441/<alias>?enableSrtp`
 * (uiprotect CameraChannel.rtsps_url) and, unencrypted, at `rtsp://<console>:7447/<alias>`.
 * The in-app restreamer verifies TLS certificates, which Protect's self-signed one would fail,
 * so the plain RTSP port is used. It only carries video on your own network/VPN.
 */
export function protectRtspUrl(host: string, alias: string, port = 7447): string {
  const h = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `rtsp://${h}:${port}/${encodeURIComponent(alias)}`;
}

/** Channels list with RTSP turned on for every channel (homebridge-unifi-protect does the same). */
export function withRtspEnabled(cam: ProtectCamera): ProtectChannel[] {
  return (cam.channels ?? []).map((c) => (c.id === 3 ? c : { ...c, isRtspEnabled: true }));
}

// ---------------------------------------------------------------------------------------------
// Events (GET /proxy/protect/api/events)

export interface ProtectEvent {
  id: string;
  type: string;
  start: number; // ms
  end?: number | null; // ms, null while in progress
  score?: number;
  camera?: string | null;
  cameraId?: string | null;
  smartDetectTypes?: string[];
  thumbnail?: string | null;
  isFavorite?: boolean;
  metadata?: {
    detectedThumbnails?: { type?: string; name?: string | null; group?: { name?: string | null; matchedName?: string | null } | null }[];
    licensePlate?: { name?: string };
  } | null;
}

/** Event types worth showing as review items. */
export const REVIEW_EVENT_TYPES = ['motion', 'smartDetectZone', 'smartDetectLine', 'smartAudioDetect', 'ring'] as const;

/**
 * Query string for /events. start/end are milliseconds; `types` is repeated, and must be given
 * whenever start/end are (uiprotect TYPES_BUG_MESSAGE: Protect ignores the time range without it).
 * There's no documented camera filter, so cameras are filtered after the fact.
 */
export function eventsQuery(q: { after: number; before: number; limit?: number }): string {
  const parts = [
    `start=${Math.floor(q.after * 1000)}`,
    `end=${Math.ceil(q.before * 1000)}`,
    `limit=${q.limit ?? 100}`,
    'orderDirection=DESC',
    ...REVIEW_EVENT_TYPES.map((t) => `types=${t}`),
  ];
  return parts.join('&');
}

export function eventToReview(
  e: ProtectEvent,
  opts: { systemId: string; thumbUrl: (eventId: string) => string },
): ReviewItem | null {
  const cameraId = e.camera ?? e.cameraId;
  if (!cameraId || !e.id || !Number.isFinite(e.start)) return null;
  let objects: string[];
  let severity: Severity;
  switch (e.type) {
    case 'ring':
      // The doorbell call screen keys on 'doorbell'.
      objects = ['doorbell'];
      severity = 'alert';
      break;
    case 'smartDetectZone':
    case 'smartDetectLine':
    case 'smartAudioDetect':
      objects = [...new Set((e.smartDetectTypes ?? []).map(smartLabel))];
      if (!objects.length) objects = ['motion'];
      severity = 'alert';
      break;
    case 'motion':
      objects = ['motion'];
      severity = 'detection';
      break;
    default:
      return null;
  }
  const names = new Set<string>();
  for (const t of e.metadata?.detectedThumbnails ?? []) {
    const n = t.group?.matchedName || t.group?.name || t.name;
    if (n) names.add(n);
  }
  if (e.metadata?.licensePlate?.name) names.add(e.metadata.licensePlate.name);
  return {
    id: e.id,
    systemId: opts.systemId,
    cameraId,
    startTime: e.start / 1000,
    endTime: e.end == null ? null : e.end / 1000,
    severity,
    objects,
    subLabels: [...names],
    zones: [],
    reviewed: false,
    // Protect renders the thumbnail when the event ends (uiprotect get_event_thumbnail).
    thumbnailUrl: opts.thumbUrl(e.id),
  };
}

// ---------------------------------------------------------------------------------------------
// Recordings

/** Longest window one export is asked for (an MP4 has to be built before it plays). */
export const MAX_EXPORT_SEC = 600;

/** `GET /proxy/protect/api/video/export?camera=&start=&end=&channel=0` (ms). */
export function exportPath(cameraId: string, start: number, end: number): string {
  const s = Math.floor(start * 1000);
  const e = Math.ceil(end * 1000);
  return `/proxy/protect/api/video/export?camera=${encodeURIComponent(cameraId)}&start=${s}&end=${e}&channel=0`;
}

// ---------------------------------------------------------------------------------------------
// PTZ

export interface ProtectPreset {
  id?: string;
  name?: string;
  slot: number;
}

/** Preset names for the pad: Home first (slot -1), then the camera's saved positions. */
export function presetNames(presets: ProtectPreset[]): { name: string; slot: number }[] {
  const home = tr().systems.common.presetHome;
  const out = [{ name: home, slot: -1 }];
  const used = new Set([home]);
  for (const p of [...presets].sort((a, b) => a.slot - b.slot)) {
    if (p.slot < 0) continue;
    let name = p.name?.trim() || tr().systems.common.presetN(p.slot + 1);
    if (used.has(name)) name = `${name} (${p.slot + 1})`;
    used.add(name);
    out.push({ name, slot: p.slot });
  }
  return out;
}

/**
 * Protect PTZ only does *relative* steps (POST /cameras/{id}/move type "relative"), so each
 * press nudges the camera; STOP does nothing. Steps are native units; uiprotect notes a move
 * can't exceed 4095 and that 4095 steps ≈ 41° pan / 45° tilt on the G4 PTZ, so ±1000 ≈ 10°.
 * Sign convention (positive = right / up) is assumed and unverified on hardware.
 */
export function relativeMove(action: PtzAction): { panPos: number; tiltPos: number } | null {
  const STEP = 1000;
  switch (action) {
    case 'MOVE_LEFT':
      return { panPos: -STEP, tiltPos: 0 };
    case 'MOVE_RIGHT':
      return { panPos: STEP, tiltPos: 0 };
    case 'MOVE_UP':
      return { panPos: 0, tiltPos: STEP };
    case 'MOVE_DOWN':
      return { panPos: 0, tiltPos: -STEP };
    default:
      return null;
  }
}

/** Next zoom position in native steps, one tenth of the range per press, clamped. */
export function nextZoom(current: number, dir: 1 | -1, range?: ProtectStepRange): number {
  const min = range?.steps?.min ?? 0;
  const max = range?.steps?.max ?? 2010; // G4 PTZ: 0 (1x) … 2010 (22x), per uiprotect
  const step = Math.max(1, Math.round((max - min) / 10));
  return Math.min(max, Math.max(min, current + dir * step));
}

/** Optical-zoom (non-PTZ) cameras: ispSettings.zoomPosition is a 0–100 percentage. */
export function nextOpticalZoom(current: number, dir: 1 | -1): number {
  return Math.min(100, Math.max(0, Math.round(current + dir * 10)));
}

// ---------------------------------------------------------------------------------------------
// Messages

export function protectLoginMessage(status: number, body = ''): string {
  if (status === 429 || /too many/i.test(body))
    return tr().systems.unifi.tooManyAttempts;
  if (status === 401 || status === 403 || status === 400) {
    if (/mfa|2fa|two.?factor|token required/i.test(body))
      return tr().systems.unifi.twoStep;
    return tr().systems.unifi.badLogin;
  }
  if (status === 404)
    return tr().systems.unifi.notConsole;
  return protectHttpMessage(status);
}

export function protectHttpMessage(status: number): string {
  switch (status) {
    case 401:
      return tr().systems.unifi.signedOut;
    case 403:
      return tr().systems.unifi.forbidden;
    case 404:
      return tr().systems.unifi.notRunning;
    case 502:
    case 503:
    case 504:
      return tr().systems.unifi.unreachable;
    default:
      return tr().systems.unifi.httpError(status);
  }
}

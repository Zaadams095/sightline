import type { PtzAction, RecordingSegment, ReviewItem, Severity } from '@/systems/types';

/**
 * Pure helpers for the Dahua / Amcrest / Lorex CGI API (no React Native imports, so they run
 * under `node --test`). References:
 * - Amcrest HTTP API 3.2017 (Dahua CGI): https://s3.amazonaws.com/amcrest-files/Amcrest+HTTP+API+3.2017.pdf
 * - python-amcrest media.py (mediaFileFind workflow), rroller/dahua Home Assistant client.
 */

/** Parses Dahua's `key=value` line bodies. Whitespace inside keys is dropped (some firmware/docs pad it). */
export function parseKv(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    out[line.slice(0, eq).replace(/\s+/g, '')] = line.slice(eq + 1).trim();
  }
  return out;
}

/** A CGI "OK" / "Error" style reply. Dahua answers 200 with a body of `Error` for many failures. */
export function isErrorBody(body: string): boolean {
  return /^\s*error\b/i.test(body);
}

// ---------------------------------------------------------------------------------------------
// Channels

export interface DahuaChannel {
  /** 1-based channel number as used by snapshot.cgi, RTSP, ptz.cgi and mediaFileFind. */
  channel: number;
  name: string;
  /** false when the recorder says this slot has no camera attached (best effort). */
  enabled: boolean;
}

/**
 * `configManager.cgi?action=getConfig&name=ChannelTitle` → `table.ChannelTitle[0].Name=Front`.
 * The table index is 0-based; every other API uses the 1-based channel number (index + 1).
 * `remote` (from `getConfig&name=RemoteDevice` on recorders) marks empty NVR slots.
 */
export function parseChannels(titles: Record<string, string>, remote?: Record<string, string>): DahuaChannel[] {
  const names = new Map<number, string>();
  for (const [k, v] of Object.entries(titles)) {
    const m = /ChannelTitle\[(\d+)\]\.Name$/.exec(k);
    if (m) names.set(Number(m[1]), v);
  }
  const enabled = remote ? parseRemoteEnabled(remote) : new Map<number, boolean>();
  return [...names.keys()]
    .sort((a, b) => a - b)
    .map((i) => ({
      channel: i + 1,
      name: names.get(i)?.trim() || `Camera ${i + 1}`,
      enabled: enabled.get(i) ?? true,
    }));
}

/**
 * Recorders list attached IP cameras as `table.RemoteDevice.uuid:System_CONFIG_NETCAMERA_INFO_<i>`
 * where <i> is the 0-based channel index. A slot with Enable=false has no camera.
 */
export function parseRemoteEnabled(kv: Record<string, string>): Map<number, boolean> {
  const out = new Map<number, boolean>();
  for (const [k, v] of Object.entries(kv)) {
    const m = /NETCAMERA_INFO_(\d+)\.Enable$/.exec(k);
    if (m) out.set(Number(m[1]), v.toLowerCase() === 'true');
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Time. Dahua devices speak *local device time* everywhere (search conditions, file times,
// RTSP playback start times) with no zone attached. We measure the device's offset from real
// UTC (global.cgi?action=getCurrentTime vs. the phone clock), as Reolink/Hikvision do:
// - When that offset, rounded to 15 minutes, equals the phone's current offset, the device is
//   taken to be in the phone's time zone and times convert with the phone's zone rules, which
//   know historic DST changes (a recording from before a DST change keeps its right hour).
//   The leftover seconds (a device clock a little fast or slow) are applied on top, since
//   recordings are labelled with that same clock.
// - Otherwise a fixed offset is used both ways. Limitation: for a recorder in a different zone
//   from the phone, recordings made before a DST change there are off by the DST difference.

export interface DeviceClock {
  /** Device wall clock minus real UTC, in seconds (includes any clock drift). */
  offsetSec: number;
  /** The device is in the phone's time zone: convert with the phone's zone rules. */
  phoneZone: boolean;
  /** Device clock error (seconds fast) on top of the zone offset; only used with phoneZone. */
  driftSec: number;
}

/** A clock, or a plain fixed offset in seconds. */
export type ClockArg = DeviceClock | number;

const asClock = (c: ClockArg): DeviceClock => (typeof c === 'number' ? { offsetSec: c, phoneZone: false, driftSec: 0 } : c);

/** "The device is in the phone's zone", used when the device clock can't be read. */
export function phoneClock(): DeviceClock {
  return { offsetSec: -new Date().getTimezoneOffset() * 60, phoneZone: true, driftSec: 0 };
}

/** Wall-clock fields of a Dahua time string ("2011-7-3 21:02:32", also 2011-07-03T21:02:32 or underscores). */
function wallFields(s: string): number[] | null {
  const m = /(\d{4})[-_/](\d{1,2})[-_/](\d{1,2})[ T_]+(\d{1,2})[:_-](\d{1,2})[:_-](\d{1,2})/.exec(s.trim());
  return m ? m.slice(1).map(Number) : null;
}

/** Seconds since epoch of a device-local wall time read *as if* it were UTC. */
function wallAsUtc(s: string): number | null {
  const f = wallFields(s);
  if (!f) return null;
  const [y, mo, d, h, mi, se] = f;
  return Date.UTC(y, mo - 1, d, h, mi, se) / 1000;
}

/**
 * Device offset in seconds (device wall clock minus real UTC), from a getCurrentTime reply
 * (`result=2011-7-3 21:02:32`) and the phone's clock at the time of the reply.
 */
export function deviceOffset(currentTimeBody: string, phoneNowMs: number): number {
  const kv = parseKv(currentTimeBody);
  const wall = wallAsUtc(kv.result ?? currentTimeBody);
  if (wall == null) throw new Error('Unreadable device time');
  return Math.round(wall - phoneNowMs / 1000);
}

/**
 * The device clock from a getCurrentTime reply. `phoneOffsetMin` is the phone's current UTC
 * offset in minutes (-new Date().getTimezoneOffset()).
 */
export function deviceClock(currentTimeBody: string, phoneNowMs: number, phoneOffsetMin: number): DeviceClock {
  const offsetSec = deviceOffset(currentTimeBody, phoneNowMs);
  const zoneMin = Math.round(offsetSec / 900) * 15;
  return { offsetSec, phoneZone: zoneMin === phoneOffsetMin, driftSec: offsetSec - zoneMin * 60 };
}

/** Device-local time string → unix seconds. */
export function fromDeviceTime(s: string, clock: ClockArg): number | null {
  const c = asClock(clock);
  if (c.phoneZone) {
    const f = wallFields(s);
    if (!f) return null;
    const [y, mo, d, h, mi, se] = f;
    return new Date(y, mo - 1, d, h, mi, se).getTime() / 1000 - c.driftSec;
  }
  const w = wallAsUtc(s);
  return w == null ? null : w - c.offsetSec;
}

const pad = (n: number) => String(n).padStart(2, '0');

function wallParts(unixSec: number, clock: ClockArg) {
  const c = asClock(clock);
  if (c.phoneZone) {
    const l = new Date((Math.floor(unixSec) + c.driftSec) * 1000);
    return {
      y: String(l.getFullYear()),
      mo: pad(l.getMonth() + 1),
      d: pad(l.getDate()),
      h: pad(l.getHours()),
      mi: pad(l.getMinutes()),
      s: pad(l.getSeconds()),
    };
  }
  const d = new Date((Math.floor(unixSec) + c.offsetSec) * 1000);
  return {
    y: String(d.getUTCFullYear()),
    mo: pad(d.getUTCMonth() + 1),
    d: pad(d.getUTCDate()),
    h: pad(d.getUTCHours()),
    mi: pad(d.getUTCMinutes()),
    s: pad(d.getUTCSeconds()),
  };
}

/** unix seconds → "2026-10-10 21:02:32" (device local), for CGI search conditions. */
export function toDeviceTime(unixSec: number, clock: ClockArg): string {
  const p = wallParts(unixSec, clock);
  return `${p.y}-${p.mo}-${p.d} ${p.h}:${p.mi}:${p.s}`;
}

/** unix seconds → "2026_10_10_21_02_32" (device local), for RTSP playback `starttime`. */
export function toPlaybackTime(unixSec: number, clock: ClockArg): string {
  const p = wallParts(unixSec, clock);
  return `${p.y}_${p.mo}_${p.d}_${p.h}_${p.mi}_${p.s}`;
}

/** Device-local calendar date (YYYY-MM-DD) of a Dahua time string. */
export function deviceDate(s: string): string | null {
  const f = wallFields(s);
  return f ? `${f[0]}-${pad(f[1])}-${pad(f[2])}` : null;
}

/**
 * Splits [after, before] into device-local calendar days, newest first, as [from, to] unix
 * pairs. File searches page oldest first with a cap, so busy recorders are searched one day
 * at a time from the newest; otherwise the most recent recordings are the ones cut off.
 */
export function dayRanges(after: number, before: number, clock: ClockArg, maxDays = 62): [number, number][] {
  const out: [number, number][] = [];
  let end = before;
  while (end > after && out.length < maxDays) {
    const day = toDeviceTime(end - 1, clock).slice(0, 10);
    const dayStart = fromDeviceTime(`${day} 00:00:00`, clock) ?? end - 86400;
    const from = Math.max(after, Math.min(dayStart, end - 1));
    out.push([from, end]);
    end = from;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Media file search (mediaFileFind.cgi)

export interface DahuaFile {
  /** 1-based channel (the reply's Channel is 0-based: "equals findFile condition.Channel - 1"). */
  channel: number;
  startTime: string;
  endTime: string;
  type: string;
  filePath: string;
  events: string[];
  flags: string[];
  videoStream?: string;
}

/**
 * Search conditions for `mediaFileFind.cgi?action=findFile`. Times are device local. Arrays use
 * 0-based indexes. Note: `condition.Channel` is 1-based. `types` (dav, jpg, mp4), `flags`
 * (Timing, Manual, Marker, Event, …) and `videoStream` (Main, Extra1, …) narrow the search, as
 * in the Amcrest HTTP API's findFile example.
 */
export function findFileQuery(c: {
  objectId: string;
  channel: number;
  start: string;
  end: string;
  types?: string[];
  flags?: string[];
  events?: string[];
  videoStream?: string;
}): string {
  const parts = [
    'action=findFile',
    `object=${encodeURIComponent(c.objectId)}`,
    `condition.Channel=${c.channel}`,
    `condition.StartTime=${encodeURIComponent(c.start)}`,
    `condition.EndTime=${encodeURIComponent(c.end)}`,
    ...(c.types ?? []).map((t, i) => `condition.Types[${i}]=${encodeURIComponent(t)}`),
    ...(c.flags ?? []).map((f, i) => `condition.Flag[${i}]=${encodeURIComponent(f)}`),
    ...(c.events ?? []).map((e, i) => `condition.Events[${i}]=${encodeURIComponent(e)}`),
    ...(c.videoStream ? [`condition.VideoStream=${encodeURIComponent(c.videoStream)}`] : []),
  ];
  return parts.join('&');
}

/** `factory.create` → `result=2086170840`. */
export function parseFinderId(body: string): string | null {
  const v = parseKv(body).result;
  return v && /^\d+$/.test(v) ? v : null;
}

/** `findNextFile` reply: `found=N` then `items[i].Field=...`. */
export function parseFindNext(body: string): { found: number; files: DahuaFile[] } {
  const kv = parseKv(body);
  const found = Number(kv.found ?? 0) || 0;
  const byIdx = new Map<number, Record<string, string>>();
  const arrays = new Map<number, { events: [number, string][]; flags: [number, string][] }>();
  for (const [k, v] of Object.entries(kv)) {
    const m = /^items\[(\d+)\]\.(\w+)(?:\[(\d+)\])?$/.exec(k);
    if (!m) continue;
    const i = Number(m[1]);
    if (m[3] != null) {
      const a = arrays.get(i) ?? { events: [], flags: [] };
      if (m[2] === 'Events') a.events.push([Number(m[3]), v]);
      if (m[2] === 'Flags' || m[2] === 'Flag') a.flags.push([Number(m[3]), v]);
      arrays.set(i, a);
    } else {
      byIdx.set(i, { ...(byIdx.get(i) ?? {}), [m[2]]: v });
    }
  }
  const files: DahuaFile[] = [];
  for (const i of [...byIdx.keys()].sort((a, b) => a - b)) {
    const f = byIdx.get(i)!;
    if (!f.StartTime || !f.EndTime) continue;
    const a = arrays.get(i) ?? { events: [], flags: [] };
    files.push({
      channel: (Number(f.Channel ?? 0) || 0) + 1,
      startTime: f.StartTime,
      endTime: f.EndTime,
      type: (f.Type ?? '').toLowerCase(),
      filePath: f.FilePath ?? '',
      events: a.events.sort((x, y) => x[0] - y[0]).map(([, v]) => v),
      flags: a.flags.sort((x, y) => x[0] - y[0]).map(([, v]) => v),
      videoStream: f.VideoStream,
    });
  }
  return { found, files };
}

const isVideo = (f: DahuaFile) => f.type !== 'jpg';

/** Video files → merged recording spans (unix seconds). Gaps up to `gapSec` are joined. */
export function filesToSegments(files: DahuaFile[], clock: ClockArg, gapSec = 2): RecordingSegment[] {
  const spans = files
    .filter(isVideo)
    .map((f) => ({ start: fromDeviceTime(f.startTime, clock), end: fromDeviceTime(f.endTime, clock) }))
    .filter((s): s is RecordingSegment => s.start != null && s.end != null && s.end > s.start)
    .sort((a, b) => a.start - b.start);
  const out: RecordingSegment[] = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    if (last && s.start - last.end <= gapSec) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}

/** Device-local dates that have video, newest first. */
export function filesToDays(files: DahuaFile[]): string[] {
  const days = new Set<string>();
  for (const f of files.filter(isVideo)) {
    for (const t of [f.startTime, f.endTime]) {
      const d = deviceDate(t);
      if (d) days.add(d);
    }
  }
  return [...days].sort().reverse();
}

// ---------------------------------------------------------------------------------------------
// Events

/**
 * Dahua event codes found on recordings → brand-neutral labels. Smart Motion Detection (SMD)
 * and IVS codes come from the Dahua event list (eventManager codes); unknown codes are ignored.
 */
const EVENT_LABELS: Record<string, string> = {
  SmartMotionHuman: 'person',
  HumanTrait: 'person',
  FaceDetection: 'person',
  FaceRecognition: 'person',
  SmartMotionVehicle: 'vehicle',
  VehicleDetection: 'vehicle',
  TrafficJunction: 'vehicle',
  TrafficParking: 'vehicle',
  ParkingDetection: 'vehicle',
  VideoMotion: 'motion',
  MotionDetect: 'motion',
  CrossLineDetection: 'motion',
  CrossRegionDetection: 'motion',
  AlarmLocal: 'alarm',
  AudioMutation: 'sound',
  AudioAnomaly: 'sound',
  DoorBell: 'doorbell',
  BackKeyLight: 'doorbell',
  CallNoAnswered: 'doorbell',
  Invite: 'doorbell',
};
/** Perimeter rules (tripwire / intrusion) are deliberate user setups, so they count as alerts. */
const ALERT_CODES = new Set(['CrossLineDetection', 'CrossRegionDetection', 'AlarmLocal']);
const ALERT_LABELS = new Set(['person', 'vehicle', 'doorbell']);

export function classifyEvents(codes: string[]): { objects: string[]; severity: Severity } | null {
  const objects = [...new Set(codes.map((c) => EVENT_LABELS[c]).filter((l): l is string => !!l))];
  if (!objects.length) return null;
  // "motion" next to a real object adds nothing.
  const shown = objects.length > 1 ? objects.filter((o) => o !== 'motion') : objects;
  const severity: Severity =
    shown.some((o) => ALERT_LABELS.has(o)) || codes.some((c) => ALERT_CODES.has(c)) ? 'alert' : 'detection';
  return { objects: shown, severity };
}

/**
 * Event-triggered recordings → review items. Pictures (jpg) the recorder saved for the same
 * channel during an event become its thumbnail. `thumbUrl` maps a device file path to a URL.
 */
export function filesToReview(
  files: DahuaFile[],
  opts: { systemId: string; clock: ClockArg; thumbUrl: (filePath: string) => string },
): ReviewItem[] {
  const pictures = files
    .filter((f) => f.type === 'jpg' && f.filePath)
    .map((f) => ({ f, t: fromDeviceTime(f.startTime, opts.clock) ?? 0 }));
  const items: ReviewItem[] = [];
  for (const f of files) {
    if (!isVideo(f)) continue;
    const cls = classifyEvents(f.events);
    if (!cls) continue;
    const start = fromDeviceTime(f.startTime, opts.clock);
    const end = fromDeviceTime(f.endTime, opts.clock);
    if (start == null) continue;
    const pic = pictures.find((p) => p.f.channel === f.channel && p.t >= start - 5 && p.t <= (end ?? start) + 5);
    items.push({
      id: `${f.channel}@${start}`,
      systemId: opts.systemId,
      cameraId: String(f.channel),
      startTime: start,
      endTime: end,
      severity: cls.severity,
      objects: cls.objects,
      subLabels: [],
      zones: [],
      reviewed: false,
      thumbnailUrl: pic ? opts.thumbUrl(pic.f.filePath) : undefined,
    });
  }
  // Main and sub-stream copies of the same event share channel + start: keep one.
  const unique = new Map<string, ReviewItem>();
  for (const i of items) if (!unique.has(i.id)) unique.set(i.id, i);
  return [...unique.values()].sort((a, b) => b.startTime - a.startTime);
}

// ---------------------------------------------------------------------------------------------
// PTZ

/** Codes for `ptz.cgi?action=start|stop&code=…` (Amcrest HTTP API §4.10.7). */
export function ptzCode(action: PtzAction): string | null {
  switch (action) {
    case 'MOVE_UP':
      return 'Up';
    case 'MOVE_DOWN':
      return 'Down';
    case 'MOVE_LEFT':
      return 'Left';
    case 'MOVE_RIGHT':
      return 'Right';
    case 'ZOOM_IN':
      return 'ZoomTele';
    case 'ZOOM_OUT':
      return 'ZoomWide';
    default:
      return null;
  }
}

/** `ptz.cgi?action=getPresets` → `presets[0].Index=1`, `presets[0].Name=Gate`. Names are made unique. */
export function parsePresets(kv: Record<string, string>): { index: number; name: string }[] {
  const byIdx = new Map<number, { index?: number; name?: string }>();
  for (const [k, v] of Object.entries(kv)) {
    const m = /presets\[(\d+)\]\.(Index|Name)$/.exec(k);
    if (!m) continue;
    const e = byIdx.get(Number(m[1])) ?? {};
    if (m[2] === 'Index') e.index = Number(v);
    else e.name = v;
    byIdx.set(Number(m[1]), e);
  }
  const used = new Set<string>();
  return [...byIdx.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, e]) => e)
    .filter((e): e is { index: number; name?: string } => Number.isFinite(e.index) && (e.index ?? 0) > 0)
    .map((e) => {
      let name = e.name?.trim() || `Preset ${e.index}`;
      if (used.has(name)) name = `${name} (${e.index})`;
      used.add(name);
      return { index: e.index, name };
    });
}

/** `ptz.cgi?action=getCurrentProtocolCaps` → can it pan/tilt, zoom? */
export function parsePtzCaps(kv: Record<string, string>): { canMove: boolean; canZoom: boolean } {
  const t = (k: string) => (kv[`caps.${k}`] ?? '').toLowerCase() === 'true';
  return { canMove: t('Pan') || t('Tile') || t('Tilt'), canZoom: t('Zoom') };
}

// ---------------------------------------------------------------------------------------------
// Health

/** `eventManager.cgi?action=getEventIndexes&code=VideoLoss` → 0-based channel indexes → 1-based numbers. */
export function parseEventChannels(body: string): number[] {
  if (isErrorBody(body)) return [];
  return Object.entries(parseKv(body))
    .filter(([k]) => /^channels\[\d+\]$/.test(k))
    .map(([, v]) => Number(v) + 1)
    .filter((n) => Number.isFinite(n) && n > 0);
}

/** `storageDevice.cgi?action=getDeviceAllInfo` → disks (list[i].Detail[j].Path/TotalBytes/UsedBytes). */
export function parseStorage(kv: Record<string, string>): { path: string; usedPct: number; freeGb: number }[] {
  const parts = new Map<string, { path?: string; total?: number; used?: number }>();
  for (const [k, v] of Object.entries(kv)) {
    const m = /^list\.?info\[(\d+)\]\.Detail\[(\d+)\]\.(Path|TotalBytes|UsedBytes)$|^list\[(\d+)\]\.Detail\[(\d+)\]\.(Path|TotalBytes|UsedBytes)$/.exec(k);
    if (!m) continue;
    const key = `${m[1] ?? m[4]}/${m[2] ?? m[5]}`;
    const field = m[3] ?? m[6];
    const e = parts.get(key) ?? {};
    if (field === 'Path') e.path = v;
    if (field === 'TotalBytes') e.total = Number(v);
    if (field === 'UsedBytes') e.used = Number(v);
    parts.set(key, e);
  }
  return [...parts.entries()]
    .filter(([, e]) => (e.total ?? 0) > 0)
    .map(([key, e]) => ({
      path: e.path || `Disk ${Number(key.split('/')[0]) + 1}`,
      usedPct: Math.round(((e.used ?? 0) / e.total!) * 100),
      freeGb: Math.round(((e.total! - (e.used ?? 0)) / 1e9) * 10) / 10,
    }));
}

// ---------------------------------------------------------------------------------------------
// URLs and messages

/** RTSP URL straight to the device. Credentials are percent-encoded (passwords often contain @ or #). */
export function rtspUrl(o: {
  host: string;
  port: number;
  user: string;
  pass: string;
  path: string;
}): string {
  const auth = o.user ? `${encodeURIComponent(o.user)}:${encodeURIComponent(o.pass)}@` : '';
  const host = o.host.includes(':') && !o.host.startsWith('[') ? `[${o.host}]` : o.host;
  return `rtsp://${auth}${host}:${o.port}${o.path}`;
}

/** Live: `/cam/realmonitor?channel=N&subtype=0|1` (0 = main stream, 1 = sub stream). */
export function livePath(channel: number, quality: 'main' | 'sub'): string {
  return `/cam/realmonitor?channel=${channel}&subtype=${quality === 'sub' ? 1 : 0}`;
}

/** Playback: `/cam/playback?channel=N&starttime=YYYY_MM_DD_HH_MM_SS&endtime=…` in device-local time. */
export function playbackPath(channel: number, start: number, end: number, clock: ClockArg): string {
  return `/cam/playback?channel=${channel}&starttime=${toPlaybackTime(start, clock)}&endtime=${toPlaybackTime(end, clock)}`;
}

/**
 * A failed request that never got an HTTP answer (timeout, refused, dropped). The raw errors
 * ("Network request failed", "No response from 127.0.0.1:53817 after 10s") mean nothing to
 * people, and the loopback port is an app detail.
 */
export function dahuaNetworkMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.startsWith('No response')) return 'The recorder didn’t answer in time. Check that it’s on and reachable.';
  return 'Couldn’t reach the recorder. Check the address and that your phone is on the same network.';
}

export function dahuaHttpMessage(status: number, body = ''): string {
  if (/locked/i.test(body)) return 'The recorder has locked this account after too many wrong passwords. Wait 30 minutes, or unlock it from the recorder’s screen.';
  switch (status) {
    case 401:
      return 'The recorder didn’t accept that username and password. Check them and try again (they’re the ones you use on the recorder’s screen or in its app).';
    case 403:
      return 'This user isn’t allowed to do that on the recorder. Sign in with the admin account, or give this user more permissions on the recorder.';
    case 404:
      return 'The recorder doesn’t support this feature.';
    case 502:
    case 504:
      return 'Couldn’t reach the recorder. Check that it’s turned on and connected to your network.';
    default:
      return `The recorder answered with an error (HTTP ${status}). Try again in a moment.`;
  }
}

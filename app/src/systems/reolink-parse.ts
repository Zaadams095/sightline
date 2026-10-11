import type { RecordingSegment, ReviewItem, Severity } from './types';
import { tr } from '../i18n/index.ts';

/**
 * Pure helpers for the Reolink HTTP API (`/cgi-bin/api.cgi`). No app imports, so they run
 * under `node --test`.
 *
 * References:
 * - Reolink "Camera HTTP API User Guide" (Login/Search/Snap/PtzCtrl/GetNetPort/...).
 * - reolink_aio (the library behind Home Assistant's Reolink integration):
 *   https://github.com/starkillerOG/reolink_aio (api.py, typings.py)
 */

/** One command's result in a Reolink JSON response array. */
export interface ReolinkItem {
  cmd: string;
  code: number;
  value?: any;
  error?: { detail?: string; rspCode?: number };
}

/** Reolink date/time object (used by Search, GetTime, NvrDownload). Month is 1-based. */
export interface Wall {
  year: number;
  mon: number;
  day: number;
  hour: number;
  min: number;
  sec: number;
}

/**
 * How to turn the device's local wall clock into real time. Reolink reports recording times
 * in the device's local time. When the device's current offset equals the phone's, we use
 * the phone's time zone (which also knows historic DST changes); otherwise a fixed offset.
 */
export interface DeviceClock {
  offsetMin: number;
  phoneZone: boolean;
}

export const PHONE_CLOCK: DeviceClock = { offsetMin: 0, phoneZone: true };

export class ReolinkError extends Error {
  readonly rspCode?: number;
  constructor(message: string, rspCode?: number) {
    super(message);
    this.rspCode = rspCode;
  }
}

// ---------------------------------------------------------------------------------------------
// Time

export function clockFromDeviceNow(deviceNow: Wall, nowMs: number, phoneOffsetMin: number): DeviceClock {
  const asUtc = Date.UTC(deviceNow.year, deviceNow.mon - 1, deviceNow.day, deviceNow.hour, deviceNow.min, deviceNow.sec);
  // Round to 15 minutes: absorbs a slightly wrong device clock; real offsets are multiples of 15.
  const offsetMin = Math.round((asUtc - nowMs) / 60000 / 15) * 15;
  return { offsetMin, phoneZone: offsetMin === phoneOffsetMin };
}

export function wallToUnix(w: Wall, clock: DeviceClock): number {
  if (clock.phoneZone) return new Date(w.year, w.mon - 1, w.day, w.hour, w.min, w.sec).getTime() / 1000;
  return Date.UTC(w.year, w.mon - 1, w.day, w.hour, w.min, w.sec) / 1000 - clock.offsetMin * 60;
}

export function unixToWall(t: number, clock: DeviceClock): Wall {
  if (clock.phoneZone) {
    const d = new Date(Math.floor(t) * 1000);
    return { year: d.getFullYear(), mon: d.getMonth() + 1, day: d.getDate(), hour: d.getHours(), min: d.getMinutes(), sec: d.getSeconds() };
  }
  const d = new Date((Math.floor(t) + clock.offsetMin * 60) * 1000);
  return {
    year: d.getUTCFullYear(),
    mon: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    min: d.getUTCMinutes(),
    sec: d.getUTCSeconds(),
  };
}

const p2 = (n: number) => String(n).padStart(2, '0');

/** "20240317153000": the `start=` format of the Playback/Download commands. */
export function compactTime(w: Wall): string {
  return `${w.year}${p2(w.mon)}${p2(w.day)}${p2(w.hour)}${p2(w.min)}${p2(w.sec)}`;
}

export function dayKey(w: Pick<Wall, 'year' | 'mon' | 'day'>): string {
  return `${w.year}-${p2(w.mon)}-${p2(w.day)}`;
}

/** Splits [after, before] into device-local calendar days, newest first (Search works per day). */
export function dayChunks(after: number, before: number, clock: DeviceClock, maxDays = 8): [Wall, Wall][] {
  const out: [Wall, Wall][] = [];
  let end = before;
  while (end > after && out.length < maxDays) {
    const w = unixToWall(end, clock);
    const dayStart = wallToUnix({ ...w, hour: 0, min: 0, sec: 0 }, clock);
    const from = Math.max(after, dayStart);
    out.push([unixToWall(from, clock), w]);
    end = dayStart - 1;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Errors and login

/** Parses a response body. Reolink answers JSON with content-type text/html. */
export function parseResponse(text: string): ReolinkItem[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ReolinkError(tr().systems.device.notThisBrand('Reolink'));
  }
  if (!Array.isArray(data)) throw new ReolinkError(tr().systems.reolink.unexpectedReply);
  return data as ReolinkItem[];
}

/** rspCode -6 / "please login first": the token expired or the device rebooted. */
export function isLoginExpired(item: ReolinkItem | undefined): boolean {
  if (!item || item.code === 0) return false;
  return item.error?.rspCode === -6 || /please login first/i.test(item.error?.detail ?? '');
}

/**
 * After the device rejected token `used` ("please login first"): can the current token be
 * used instead of signing in again? Yes when another request already replaced `used` with a
 * token that's still within its lease; signing in again would only open another session.
 */
export function canReuseAfterRejection(current: { token: string; expires: number }, used: string, nowMs: number): boolean {
  return current.token !== used && current.expires > nowMs;
}

/** Plain-language message for a failed command. */
export function errorMessage(item: ReolinkItem | undefined): string {
  const detail = (item?.error?.detail ?? '').toLowerCase();
  const code = item?.error?.rspCode;
  if (detail.includes('locked')) {
    return tr().systems.reolink.locked;
  }
  // Detail strings as matched by reolink_aio's send() ("invalid user", "login failed", "password wrong").
  if (/invalid user|login failed|password wrong/.test(detail)) {
    return tr().systems.device.rejectedLogin('Reolink');
  }
  if (detail.includes('max session')) {
    return tr().systems.reolink.tooManySessions;
  }
  if (isLoginExpired(item)) return tr().systems.reolink.signedOut;
  if (detail.includes('ability') || detail.includes('not support') || code === -9) {
    return tr().systems.device.notSupported('Reolink');
  }
  return item?.error?.detail ? tr().systems.device.couldntDoDetail('Reolink', item.error.detail) : tr().systems.device.couldntDo('Reolink');
}

export function loginBody(user: string, password: string) {
  return [{ cmd: 'Login', action: 0, param: { User: { userName: user, password } } }];
}

export function parseLogin(items: ReolinkItem[]): { token: string; leaseSec: number } {
  const item = items.find((i) => i.cmd === 'Login') ?? items[0];
  if (!item || item.code !== 0) throw new ReolinkError(errorMessage(item), item?.error?.rspCode);
  const tok = item.value?.Token;
  if (!tok?.name) throw new ReolinkError(tr().systems.reolink.unexpectedLogin);
  return { token: String(tok.name), leaseSec: Number(tok.leaseTime) || 3600 };
}

// ---------------------------------------------------------------------------------------------
// Device and channels

export interface DevInfo {
  name: string;
  model: string;
  channelNum: number;
  /** NVRs and the Home Hub: several channels, and different download commands. */
  isNvr: boolean;
  isHub: boolean;
}

/** GetDevInfo → device summary (reolink_aio: exactType/type in NVR, WIFI_NVR, HOMEHUB). */
export function parseDevInfo(value: any): DevInfo {
  const d = value?.DevInfo ?? {};
  const kinds = ['NVR', 'WIFI_NVR', 'HOMEHUB'];
  const exact = String(d.exactType ?? d.type ?? 'IPC').toUpperCase();
  const type = String(d.type ?? 'IPC').toUpperCase();
  return {
    name: String(d.name ?? '').trim() || String(d.model ?? 'Reolink'),
    model: String(d.model ?? ''),
    channelNum: Math.max(1, Number(d.channelNum) || 1),
    isNvr: kinds.includes(exact) || kinds.includes(type),
    isHub: exact === 'HOMEHUB' || type === 'HOMEHUB',
  };
}

export interface ChannelInfo {
  channel: number;
  name: string;
  online: boolean;
  /** A video doorbell (from the model / typeInfo), so ring alerts work whatever it's named. */
  doorbell?: boolean;
}

/** Reolink doorbells: "Reolink Video Doorbell …" or model D340P/D340W. */
export const isReolinkDoorbellModel = (model: unknown): boolean => /doorbell|^D3\d\d/i.test(String(model ?? '').trim());

/**
 * Cameras of a device. NVR/Hub: online channels from GetChannelstatus (empty slots report
 * online 0; reolink_aio skips them too). A single camera is channel 0.
 */
export function parseChannels(dev: DevInfo, channelStatus: any | undefined): ChannelInfo[] {
  if (!dev.isNvr) return [{ channel: 0, name: dev.name, online: true, ...(isReolinkDoorbellModel(dev.model) && { doorbell: true }) }];
  const status: any[] = Array.isArray(channelStatus?.status) ? channelStatus.status : [];
  if (status.length) {
    return status
      .filter((s) => Number(s.online) === 1)
      .map((s) => ({
        channel: Number(s.channel),
        name: String(s.name ?? '').trim() || tr().systems.common.cameraN(Number(s.channel) + 1),
        online: true,
        ...(isReolinkDoorbellModel(s.typeInfo) && { doorbell: true }),
      }))
      .sort((a, b) => a.channel - b.channel);
  }
  return Array.from({ length: dev.channelNum }, (_, ch) => ({ channel: ch, name: tr().systems.common.cameraN(ch + 1), online: true }));
}

/** GetAbility → per-channel `ver` of a capability (0 when missing). */
export function abilityVer(ability: any, channel: number, key: string): number {
  const chn: any[] = ability?.Ability?.abilityChn ?? ability?.abilityChn ?? [];
  const entry = chn[channel] ?? (chn.length === 1 ? chn[0] : undefined);
  return Number(entry?.[key]?.ver ?? 0) || 0;
}

/**
 * PTZ support from `ptzType` (reolink_aio api.py): 1/2/5 can zoom, 2/3/5/6/7 can pan and tilt.
 * Version 0 means a fixed camera.
 */
export function ptzSupport(ability: any, channel: number): { canMove: boolean; canZoom: boolean } {
  const v = abilityVer(ability, channel, 'ptzType');
  return { canMove: [2, 3, 5, 6, 7].includes(v), canZoom: [1, 2, 5].includes(v) };
}

export interface NetPort {
  rtspPort: number;
  rtspEnabled: boolean;
  /** The raw object, needed to send SetNetPort back with only RTSP changed. */
  raw: any;
}

export function parseNetPort(value: any): NetPort {
  const n = value?.NetPort ?? {};
  return { rtspPort: Number(n.rtspPort) || 554, rtspEnabled: Number(n.rtspEnable ?? 1) === 1, raw: value };
}

/** SetNetPort body that turns RTSP on and leaves every other port setting as it was. */
export function enableRtspBody(net: NetPort) {
  return [{ cmd: 'SetNetPort', action: 0, param: { ...net.raw, NetPort: { ...(net.raw?.NetPort ?? {}), rtspEnable: 1 } } }];
}

export interface StreamInfo {
  vType: 'h264' | 'h265';
  width?: number;
  height?: number;
}

export function parseEnc(value: any): { main: StreamInfo; sub: StreamInfo } {
  const enc = value?.Enc ?? {};
  const one = (s: any): StreamInfo => ({
    vType: String(s?.vType ?? 'h264').toLowerCase() === 'h265' ? 'h265' : 'h264',
    width: Number(s?.width) || undefined,
    height: Number(s?.height) || undefined,
  });
  return { main: one(enc.mainStream), sub: one(enc.subStream) };
}

/** GetRtspUrl (newer firmware) → the stream paths, e.g. "/Preview_01_main". */
export function parseRtspUrls(value: any): { main?: string; sub?: string } {
  const r = value?.rtspUrl ?? {};
  return { main: rtspPath(r.mainStream), sub: rtspPath(r.subStream) };
}

function rtspPath(url: unknown): string | undefined {
  if (typeof url !== 'string' || !url) return undefined;
  const m = url.match(/^rtsps?:\/\/[^/]+(\/.*)$/i);
  return m ? m[1] : undefined;
}

/**
 * Classic RTSP path: /h264Preview_01_main (channel numbering starts at 01). H.265 cameras use
 * h265Preview_…; reolink_aio picks the prefix from GetEnc's vType.
 */
export function defaultRtspPath(channel: number, quality: 'main' | 'sub', vType: 'h264' | 'h265' = 'h264'): string {
  return `/${vType}Preview_${p2(channel + 1)}_${quality}`;
}

export function buildRtspUrl(o: { host: string; port: number; user: string; password: string; path: string }): string {
  const host = o.host.includes(':') && !o.host.startsWith('[') ? `[${o.host}]` : o.host;
  const auth = o.user ? `${encodeURIComponent(o.user)}:${encodeURIComponent(o.password)}@` : '';
  return `rtsp://${auth}${host}:${o.port}${o.path.startsWith('/') ? o.path : `/${o.path}`}`;
}

// ---------------------------------------------------------------------------------------------
// PTZ

export const PTZ_OPS: Record<string, string> = {
  MOVE_UP: 'Up',
  MOVE_DOWN: 'Down',
  MOVE_LEFT: 'Left',
  MOVE_RIGHT: 'Right',
  ZOOM_IN: 'ZoomInc',
  ZOOM_OUT: 'ZoomDec',
  STOP: 'Stop',
};

/** PtzCtrl body. Speed (1–64) only applies to moves. */
export function ptzBody(channel: number, op: string, extra: { id?: number; speed?: number } = {}) {
  const param: Record<string, unknown> = { channel, op };
  if (extra.speed && /^(Up|Down|Left|Right)$/.test(op)) param.speed = extra.speed;
  if (extra.id != null) param.id = extra.id;
  return [{ cmd: 'PtzCtrl', action: 0, param }];
}

/**
 * Spotlight and siren from GetAbility, as reolink_aio reads them: a spotlight (WhiteLed) when
 * `floodLight` or `supportFLswitch` is set, a siren when `alarmAudio` or `supportAudioAlarm` is.
 */
export function deterSupport(ability: any, channel: number): { light: boolean; siren: boolean } {
  const v = (k: string) => abilityVer(ability, channel, k) > 0;
  return { light: v('floodLight') || v('supportFLswitch'), siren: v('alarmAudio') || v('supportAudioAlarm') };
}

/** SetWhiteLed: turn the spotlight on (state 1) or off (state 0). */
export function whiteLedBody(channel: number, on: boolean) {
  return [{ cmd: 'SetWhiteLed', action: 0, param: { WhiteLed: { channel, state: on ? 1 : 0 } } }];
}

/** AudioAlarmPlay once: the siren sounds for a few seconds and stops by itself. */
export function sirenBody(channel: number) {
  return [{ cmd: 'AudioAlarmPlay', action: 0, param: { alarm_mode: 'times', times: 1, channel } }];
}

/** GetPtzPreset → enabled presets as name → id. */
export function parsePresets(value: any): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of value?.PtzPreset ?? []) {
    if (Number(p.enable) !== 1) continue;
    const name = String(p.name ?? '').trim() || tr().systems.common.presetN(p.id);
    if (!out.has(name)) out.set(name, Number(p.id));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Recordings

export function searchBody(channel: number, from: Wall, to: Wall, onlyStatus: boolean, stream: 'main' | 'sub' = 'main') {
  return {
    cmd: 'Search',
    action: 0,
    param: { Search: { channel, onlyStatus: onlyStatus ? 1 : 0, streamType: stream, StartTime: from, EndTime: to } },
  };
}

export interface Trigger {
  timer: boolean;
  motion: boolean;
  person: boolean;
  vehicle: boolean;
  animal: boolean;
  doorbell: boolean;
  package: boolean;
}

export interface VodFile {
  /** Unix seconds. */
  start: number;
  end: number;
  /** Device file name (cameras, Home Hub, newer NVRs). Older NVRs omit it. */
  name?: string;
  /** Device-local start/end, needed by NvrDownload. */
  startWall: Wall;
  endWall: Wall;
  /** Null when the file name doesn't carry trigger flags. */
  triggers: Trigger | null;
}

/** Bit positions (MSB-first) of the flags in the file name's hex field (reolink_aio typings.py). */
const FLAGS_CAM = { person: 17, vehicle: 19, animal: 20, timer: 23, motion: 24, doorbell: 26 } as const;
const FLAGS_HUB_V0 = { ...FLAGS_CAM, package: 37 } as const;
const FLAGS_HUB_V2 = { person: 17, vehicle: 19, animal: 20, timer: 24, motion: 25, doorbell: 27, package: 37 } as const;

/**
 * Decodes the trigger flags in a recording file name, e.g.
 *   Mp4Record/2020-12-22/RecM01_20201222_075939_080140_6D28808_1A468F9.mp4   (camera)
 *   RecS07_20250219_111146_111238_0_A714C0A000_21E67C.mp4                    (camera, newer)
 *   …/RecM02_DST20240827_090302_090334_0_800_800_033C820000_61B6F0.mp4       (Home Hub)
 * Format reverse-engineered in https://github.com/sven337/ReolinkLinux/wiki/Figuring-out-the-file-names
 * and implemented in reolink_aio's parse_file_name/decode_hex_to_flags (ported 1:1 here).
 */
export function parseVodName(fileName: string): Trigger | null {
  const dot = fileName.lastIndexOf('.');
  if (dot < 0) return null;
  const base = fileName.slice(0, dot).split('/').pop() ?? '';
  const parts = base.split('_');
  if (!parts[0].startsWith('Rec') || parts[0].length !== 6) return null;
  const version = parseInt(parts[0].slice(4, 6), 16);

  let hex: string;
  let flags: Record<string, number>;
  if (parts.length === 6) {
    hex = parts[4];
    flags = FLAGS_CAM;
  } else if (parts.length === 7) {
    hex = parts[5];
    flags = FLAGS_CAM;
  } else if (parts.length === 9) {
    hex = parts[7];
    flags = version >= 2 ? FLAGS_HUB_V2 : FLAGS_HUB_V0;
  } else {
    return null;
  }
  if (!/^[0-9a-f]+$/i.test(hex)) return null;
  const bits = [...hex].map((c) => parseInt(c, 16).toString(2).padStart(4, '0')).join('');
  const bit = (k: string) => (flags[k] != null && bits[flags[k]] === '1');
  return {
    person: bit('person'),
    vehicle: bit('vehicle'),
    animal: bit('animal'),
    timer: bit('timer'),
    motion: bit('motion'),
    doorbell: bit('doorbell'),
    package: bit('package'),
  };
}

const wallOf = (o: any): Wall | null =>
  o && Number(o.year)
    ? { year: Number(o.year), mon: Number(o.mon), day: Number(o.day), hour: Number(o.hour), min: Number(o.min), sec: Number(o.sec) }
    : null;

/** Search (onlyStatus 0) → recording files, oldest first. */
export function parseSearchFiles(value: any, clock: DeviceClock): VodFile[] {
  const files: any[] = value?.SearchResult?.File ?? [];
  const out: VodFile[] = [];
  for (const f of files) {
    const s = wallOf(f.StartTime);
    const e = wallOf(f.EndTime);
    if (!s || !e) continue;
    const name = typeof f.name === 'string' && f.name ? f.name : undefined;
    out.push({
      start: wallToUnix(s, clock),
      end: wallToUnix(e, clock),
      name,
      startWall: s,
      endWall: e,
      triggers: name ? parseVodName(name) : null,
    });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Search (onlyStatus 1) → days with recordings, e.g. {year:2023, mon:4, table:"0010…"}. */
export function parseSearchStatus(value: any): string[] {
  const out: string[] = [];
  for (const s of value?.SearchResult?.Status ?? []) {
    const table = String(s.table ?? '');
    for (let i = 0; i < table.length; i++) {
      if (table[i] === '1') out.push(dayKey({ year: Number(s.year), mon: Number(s.mon), day: i + 1 }));
    }
  }
  return out;
}

/** Merges files into continuous spans (Reolink splits recordings into files of a few minutes). */
export function mergeSegments(files: { start: number; end: number }[], toleranceSec = 2): RecordingSegment[] {
  const spans: RecordingSegment[] = [];
  for (const f of [...files].sort((a, b) => a.start - b.start)) {
    if (f.end <= f.start) continue;
    const last = spans[spans.length - 1];
    if (last && f.start - last.end <= toleranceSec) last.end = Math.max(last.end, f.end);
    else spans.push({ start: f.start, end: f.end });
  }
  return spans;
}

/** The files from one search of a camera, and what that search covered. */
export interface FileCache {
  /** Searched span, unix seconds. */
  after: number;
  before: number;
  /** When the search ran (unix seconds): later recordings can't be in it. */
  at: number;
  files: VodFile[];
}

/**
 * Whether a cached search can say which file plays at `start` (for a window up to `end`): a
 * cached file contains `start`, or the search covered the whole window (and had already
 * happened by `end`). Otherwise the device must be searched again, or a stale list could
 * open the wrong recording (say 09:58 for a seek to 09:30).
 */
export function fileCacheCovers(c: FileCache | undefined, start: number, end: number): boolean {
  if (!c) return false;
  if (c.files.some((f) => f.start <= start && start < f.end)) return true;
  return c.after <= start && Math.min(c.before, c.at) >= end;
}

/**
 * `cmd=Snap` URL. With a session token when there is one; before the first sign-in, with the
 * username and password instead (the API accepts both), so pictures don't wait for a login.
 */
export function snapUrl(o: {
  base: string;
  channel: number;
  token?: string;
  user?: string;
  password?: string;
  sub?: { width: number; height: number };
}): string {
  const size = o.sub ? `&snapType=sub&width=${o.sub.width}&height=${o.sub.height}` : '';
  const auth = o.token
    ? `&token=${encodeURIComponent(o.token)}`
    : `&user=${encodeURIComponent(o.user ?? '')}&password=${encodeURIComponent(o.password ?? '')}`;
  return `${o.base}/cgi-bin/api.cgi?cmd=Snap&channel=${o.channel}&rs=sightline${size}${auth}`;
}

/** The file to play for a moment: the one containing `t`, else the next one before `until`. */
export function fileAt(files: VodFile[], t: number, until = Infinity): VodFile | undefined {
  const sorted = [...files].sort((a, b) => a.start - b.start);
  return sorted.find((f) => f.start <= t && t < f.end) ?? sorted.find((f) => f.start >= t && f.start < until);
}

/**
 * Recording files → review items. Only files whose names carry trigger flags can be classified;
 * schedule-only (continuous) recordings are not events.
 */
export function filesToReview(files: VodFile[], systemId: string, cameraId: string): ReviewItem[] {
  const out: ReviewItem[] = [];
  for (const f of files) {
    const t = f.triggers;
    if (!t) continue;
    const objects: string[] = [];
    if (t.person) objects.push('person');
    if (t.vehicle) objects.push('vehicle');
    if (t.animal) objects.push('animal');
    if (t.package) objects.push('package');
    if (t.doorbell) objects.push('doorbell');
    if (!objects.length && !t.motion) continue;
    const severity: Severity = objects.length ? 'alert' : 'detection';
    out.push({
      id: `${cameraId}:${Math.floor(f.start)}`,
      systemId,
      cameraId,
      startTime: f.start,
      endTime: f.end,
      severity,
      objects,
      subLabels: [],
      zones: [],
      reviewed: false,
    });
  }
  return out;
}

/**
 * URL that streams one recording file as MP4. Mirrors Home Assistant's choice
 * (homeassistant/components/reolink/media_source.py): `Download` on NVRs/Hub, `Playback` on
 * cameras. Both return video/mp4 and honor HTTP Range, which AVPlayer needs.
 */
export function vodFileUrl(o: { base: string; fileName: string; startWall: Wall; nvr: boolean; token: string }): string {
  const cmd = o.nvr ? 'Download' : 'Playback';
  const start = compactTime(o.startWall);
  const source = o.fileName.replace(/ /g, '%20');
  return `${o.base}/cgi-bin/api.cgi?cmd=${cmd}&source=${source}&output=sightline_${start}.mp4&start=${start}&token=${encodeURIComponent(o.token)}`;
}

/** NvrDownload prepares a file for a time range on NVRs whose search results have no file name. */
export function nvrDownloadBody(channel: number, from: Wall, to: Wall, stream: 'main' | 'sub' = 'main') {
  return [
    {
      cmd: 'NvrDownload',
      action: 1,
      param: { NvrDownload: { channel, iLogicChannel: 0, streamType: stream, StartTime: from, EndTime: to } },
    },
  ];
}

/** NvrDownload → the prepared file name (the largest, as reolink_aio does). */
export function parseNvrDownload(value: any): string | null {
  let best: { name: string; size: number } | null = null;
  for (const f of value?.fileList ?? []) {
    const size = Number(f.fileSize) || 0;
    if (f.fileName && (!best || size > best.size)) best = { name: String(f.fileName), size };
  }
  return best?.name ?? null;
}

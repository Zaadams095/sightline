import type { RecordingSegment, ReviewItem, Severity } from './types';
import { tr } from '../i18n/index.ts';

/**
 * Pure helpers for Hikvision ISAPI (XML over HTTP, Digest auth handled by the gateway). No app
 * imports, so they run under `node --test`.
 *
 * References:
 * - Hikvision "IP Surveillance API (RaCM part) 2.0": ContentMgmt/search, dailyDistribution,
 *   archive streaming (`/Streaming/tracks/<id>?starttime=…`).
 * - hikvision_next (Home Assistant integration): https://github.com/maciej-or/hikvision_next
 *   (isapi/isapi.py: deviceInfo, capabilities, InputProxy and video input channels, RTSP port).
 */

// ---------------------------------------------------------------------------------------------
// Minimal XML reading. ISAPI documents are small and regular; namespaces are ignored.

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[e.toLowerCase()] ?? '';
  });
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Raw inner XML of every `<tag>` element (optionally namespace-prefixed), in order. */
export function xmlBlocks(xml: string, tag: string): string[] {
  const t = esc(tag);
  const re = new RegExp(`<(?:[\\w.-]+:)?${t}(?:\\s[^>]*?)?(?:/>|>([\\s\\S]*?)</(?:[\\w.-]+:)?${t}\\s*>)`, 'g');
  const out: string[] = [];
  for (const m of xml.matchAll(re)) out.push(m[1] ?? '');
  return out;
}

/** Text of the first `<tag>` element, decoded and trimmed. */
export function xmlText(xml: string, tag: string): string | undefined {
  const b = xmlBlocks(xml, tag)[0];
  return b === undefined ? undefined : decodeXml(b.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).trim();
}

export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------------------------
// Errors

export class HikvisionError extends Error {
  readonly status?: number;
  readonly notSupported: boolean;
  constructor(message: string, status?: number, notSupported = false) {
    super(message);
    this.status = status;
    this.notSupported = notSupported;
  }
}

/**
 * The device itself answered "not supported" / "not allowed" (as opposed to a timeout, a busy
 * device or a network failure, which are worth retrying later).
 */
export function isDefinitiveNo(e: unknown): boolean {
  return e instanceof HikvisionError && (e.notSupported || e.status === 400 || e.status === 403 || e.status === 404);
}

/** Plain-language message for an ISAPI failure (HTTP status plus the ResponseStatus body). */
export function errorFor(status: number, body: string): HikvisionError {
  const sub = (xmlText(body, 'subStatusCode') ?? '').toLowerCase();
  const statusCode = Number(xmlText(body, 'statusCode') ?? 0);
  if (status === 401) {
    if (/lock/.test(sub) || /lock/i.test(body)) {
      return new HikvisionError(tr().systems.hikvision.locked, status);
    }
    return new HikvisionError(tr().systems.device.rejectedLogin('Hikvision'), status);
  }
  if (status === 403 || sub === 'nopermission' || sub === 'lowprivilege') {
    return new HikvisionError(tr().systems.hikvision.forbidden, status);
  }
  if (status === 404 || sub === 'notsupport' || sub === 'invalidoperation' || statusCode === 4) {
    return new HikvisionError(tr().systems.device.notSupported('Hikvision'), status, true);
  }
  if (status === 502 || status === 504) {
    return new HikvisionError(tr().systems.device.cantReach('Hikvision'), status);
  }
  if (sub === 'devicebusy' || statusCode === 2) return new HikvisionError(tr().systems.hikvision.busy, status);
  if (statusCode === 3) return new HikvisionError(tr().systems.hikvision.reportedError, status);
  return new HikvisionError(sub ? tr().systems.device.couldntDoDetail('Hikvision', sub) : tr().systems.device.couldntDo('Hikvision'), status);
}

// ---------------------------------------------------------------------------------------------
// Time. Hikvision recorders write their *local* wall clock with a "Z" suffix in search results
// and in playback URLs ("fake Z"; see e.g. https://github.com/odanree/wildlife-detector/pull/222,
// verified against Hikvision-OEM firmware: a real-UTC starttime is rejected). An explicit
// offset (+02:00) is honored.

export interface DeviceClock {
  offsetMin: number;
  /** Device offset equals the phone's: use the phone's zone (it knows historic DST changes). */
  phoneZone: boolean;
}

export const PHONE_CLOCK: DeviceClock = { offsetMin: 0, phoneZone: true };

interface Wall {
  year: number;
  mon: number;
  day: number;
  hour: number;
  min: number;
  sec: number;
}

function wallToUnix(w: Wall, clock: DeviceClock): number {
  if (clock.phoneZone) return new Date(w.year, w.mon - 1, w.day, w.hour, w.min, w.sec).getTime() / 1000;
  return Date.UTC(w.year, w.mon - 1, w.day, w.hour, w.min, w.sec) / 1000 - clock.offsetMin * 60;
}

function unixToWall(t: number, clock: DeviceClock): Wall {
  if (clock.phoneZone) {
    const d = new Date(Math.floor(t) * 1000);
    return { year: d.getFullYear(), mon: d.getMonth() + 1, day: d.getDate(), hour: d.getHours(), min: d.getMinutes(), sec: d.getSeconds() };
  }
  const d = new Date((Math.floor(t) + clock.offsetMin * 60) * 1000);
  return { year: d.getUTCFullYear(), mon: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), min: d.getUTCMinutes(), sec: d.getUTCSeconds() };
}

const p2 = (n: number) => String(n).padStart(2, '0');

/**
 * `/ISAPI/System/time` → device clock. `<localTime>2024-05-01T10:00:00+02:00</localTime>`
 * carries the current offset; without one, compare the wall clock with the phone's.
 */
export function parseDeviceClock(xml: string, nowMs: number, phoneOffsetMin: number): DeviceClock {
  const local = xmlText(xml, 'localTime') ?? '';
  const m = local.match(/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?(Z|[+-]\d\d:?\d\d)?$/);
  if (!m) return PHONE_CLOCK;
  let offsetMin: number;
  const tz = m[7];
  if (tz && tz !== 'Z') {
    const sign = tz[0] === '-' ? -1 : 1;
    const digits = tz.slice(1).replace(':', '');
    offsetMin = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
  } else {
    const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    offsetMin = Math.round((asUtc - nowMs) / 60000 / 15) * 15;
  }
  return { offsetMin, phoneZone: offsetMin === phoneOffsetMin };
}

/** "2024-05-01T10:00:00Z" (device-local, fake Z) or with an explicit offset → unix seconds. */
export function parseHikTime(s: string, clock: DeviceClock): number | null {
  const m = s.trim().match(/^(\d{4})-?(\d\d)-?(\d\d)T(\d\d):?(\d\d):?(\d\d)(?:\.\d+)?(Z|[+-]\d\d:?\d\d)?$/);
  if (!m) return null;
  const w: Wall = { year: +m[1], mon: +m[2], day: +m[3], hour: +m[4], min: +m[5], sec: +m[6] };
  const tz = m[7];
  if (tz && tz !== 'Z') {
    const sign = tz[0] === '-' ? -1 : 1;
    const digits = tz.slice(1).replace(':', '');
    const off = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
    return Date.UTC(w.year, w.mon - 1, w.day, w.hour, w.min, w.sec) / 1000 - off * 60;
  }
  return wallToUnix(w, clock);
}

/** Search request time: "2024-05-01T10:00:00Z" in device-local time. */
export function searchTime(t: number, clock: DeviceClock): string {
  const w = unixToWall(t, clock);
  return `${w.year}-${p2(w.mon)}-${p2(w.day)}T${p2(w.hour)}:${p2(w.min)}:${p2(w.sec)}Z`;
}

/** Playback URL time: "20240501T100000Z" in device-local time (RFC 2326 absolute time format). */
export function rtspTime(t: number, clock: DeviceClock): string {
  const w = unixToWall(t, clock);
  return `${w.year}${p2(w.mon)}${p2(w.day)}T${p2(w.hour)}${p2(w.min)}${p2(w.sec)}Z`;
}

/**
 * Splits [after, before] into device-local calendar days, newest first, as [from, to] unix
 * pairs. Searches page oldest-first, so walking day by day from the newest keeps a busy day
 * from crowding out the most recent recordings.
 */
export function dayRanges(after: number, before: number, clock: DeviceClock, maxDays = 62): [number, number][] {
  const out: [number, number][] = [];
  let end = before;
  while (end > after && out.length < maxDays) {
    const w = unixToWall(end - 1, clock);
    const dayStart = wallToUnix({ ...w, hour: 0, min: 0, sec: 0 }, clock);
    const from = Math.max(after, Math.min(dayStart, end - 1));
    out.push([from, end]);
    end = from;
  }
  return out;
}

export function deviceToday(nowSec: number, clock: DeviceClock): { year: number; mon: number; day: number } {
  const w = unixToWall(nowSec, clock);
  return { year: w.year, mon: w.mon, day: w.day };
}

// ---------------------------------------------------------------------------------------------
// Device and channels

export interface DeviceInfo {
  name: string;
  model: string;
  deviceType: string;
}

export function parseDeviceInfo(xml: string): DeviceInfo {
  if (!/<(?:\w+:)?DeviceInfo[\s>]/.test(xml)) throw new HikvisionError(tr().systems.device.notThisBrand('Hikvision'));
  const model = xmlText(xml, 'model') ?? '';
  return {
    name: xmlText(xml, 'deviceName') || model || 'Hikvision',
    model,
    deviceType: xmlText(xml, 'deviceType') ?? '',
  };
}

export interface Channel {
  /** Channel number; stream ids are channel*100 + 1 (main) / 2 (sub). */
  id: number;
  name: string;
  online: boolean;
  /** Camera connected over the network to a recorder (PTZ goes through PTZCtrlProxy). */
  proxied: boolean;
  width?: number;
  height?: number;
}

/** `/ISAPI/ContentMgmt/InputProxy/channels`: network cameras added to an NVR. */
export function parseInputProxyChannels(xml: string): { id: number; name: string }[] {
  return xmlBlocks(xml, 'InputProxyChannel')
    .map((b) => ({ id: Number(xmlText(b, 'id')), name: xmlText(b, 'name') ?? '' }))
    .filter((c) => Number.isInteger(c.id) && c.id > 0);
}

/** `/ISAPI/ContentMgmt/InputProxy/channels/status` → channel id → online. */
export function parseInputProxyStatus(xml: string): Map<number, boolean> {
  const out = new Map<number, boolean>();
  for (const b of xmlBlocks(xml, 'InputProxyChannelStatus')) {
    const id = Number(xmlText(b, 'id'));
    if (Number.isInteger(id)) out.set(id, (xmlText(b, 'online') ?? 'true') === 'true');
  }
  return out;
}

/** `/ISAPI/System/Video/inputs/channels`: analog inputs of a DVR, or a camera's own sensor(s). */
export function parseVideoInputs(xml: string): { id: number; name: string; enabled: boolean; noVideo: boolean }[] {
  return xmlBlocks(xml, 'VideoInputChannel')
    .map((b) => ({
      id: Number(xmlText(b, 'id')),
      name: xmlText(b, 'name') ?? '',
      enabled: (xmlText(b, 'videoInputEnabled') ?? 'true') !== 'false',
      noVideo: /no video/i.test(xmlText(b, 'resDesc') ?? ''),
    }))
    .filter((c) => Number.isInteger(c.id) && c.id > 0);
}

export interface StreamingChannel {
  id: number;
  channel: number;
  name: string;
  width?: number;
  height?: number;
}

/** `/ISAPI/Streaming/channels`: every stream (101, 102, 201, …). */
export function parseStreamingChannels(xml: string): StreamingChannel[] {
  return xmlBlocks(xml, 'StreamingChannel')
    .map((b) => {
      const id = Number(xmlText(b, 'id'));
      const input = Number(xmlText(b, 'videoInputChannelID'));
      return {
        id,
        channel: Number.isInteger(input) && input > 0 ? input : Math.floor(id / 100),
        name: xmlText(b, 'channelName') ?? '',
        width: Number(xmlText(b, 'videoResolutionWidth')) || undefined,
        height: Number(xmlText(b, 'videoResolutionHeight')) || undefined,
      };
    })
    .filter((s) => Number.isInteger(s.id) && s.id > 0);
}

/**
 * Cameras of a device, the way hikvision_next finds them: network cameras on a recorder
 * (InputProxy), analog inputs (video inputs; unused DVR inputs report "NO VIDEO" and are left
 * out), else the streaming channels of a single camera.
 */
export function buildChannels(o: {
  device: DeviceInfo;
  proxy: { id: number; name: string }[];
  proxyStatus: Map<number, boolean>;
  inputs: { id: number; name: string; enabled: boolean; noVideo: boolean }[];
  streams: StreamingChannel[];
}): Channel[] {
  const byId = new Map<number, Channel>();
  const size = (ch: number) => {
    const s = o.streams.find((x) => x.id === ch * 100 + 1) ?? o.streams.find((x) => x.channel === ch);
    return { width: s?.width, height: s?.height };
  };
  for (const c of o.proxy) {
    byId.set(c.id, { id: c.id, name: c.name || tr().systems.common.cameraN(c.id), online: o.proxyStatus.get(c.id) ?? true, proxied: true, ...size(c.id) });
  }
  for (const c of o.inputs) {
    if (byId.has(c.id) || c.noVideo) continue;
    byId.set(c.id, { id: c.id, name: c.name || tr().systems.common.cameraN(c.id), online: c.enabled, proxied: false, ...size(c.id) });
  }
  if (!byId.size) {
    for (const s of o.streams) {
      if (byId.has(s.channel)) continue;
      byId.set(s.channel, { id: s.channel, name: s.name || '', online: true, proxied: false, ...size(s.channel) });
    }
  }
  const list = [...byId.values()].sort((a, b) => a.id - b.id);
  // A single camera: its own name is the friendliest label.
  if (list.length === 1 && !o.proxy.length) list[0].name = o.device.name || list[0].name || 'Camera';
  for (const c of list) if (!c.name) c.name = `${o.device.name} ${c.id}`;
  return list;
}

/** `/ISAPI/Security/adminAccesses` → RTSP port (554 unless changed; one NVR in the wild uses 10554). */
export function parseRtspPort(xml: string): number {
  for (const b of xmlBlocks(xml, 'AdminAccessProtocol')) {
    if ((xmlText(b, 'protocol') ?? '').toUpperCase() === 'RTSP') return Number(xmlText(b, 'portNo')) || 554;
  }
  return 554;
}

export function streamId(channel: number, quality: 'main' | 'sub'): number {
  return channel * 100 + (quality === 'sub' ? 2 : 1);
}

function rtspBase(o: { host: string; port: number; user: string; password: string }): string {
  const host = o.host.includes(':') && !o.host.startsWith('[') ? `[${o.host}]` : o.host;
  const auth = o.user ? `${encodeURIComponent(o.user)}:${encodeURIComponent(o.password)}@` : '';
  return `rtsp://${auth}${host}:${o.port}`;
}

/** Live: rtsp://user:pass@host:554/Streaming/Channels/101 (main) or …/102 (sub). */
export function liveUrl(o: { host: string; port: number; user: string; password: string; channel: number; quality: 'main' | 'sub' }): string {
  return `${rtspBase(o)}/Streaming/Channels/${streamId(o.channel, o.quality)}`;
}

/**
 * Two-way audio: Hikvision cameras take the phone's voice through ISAPI
 * (/ISAPI/System/TwoWayAudio), not the ONVIF RTSP backchannel. Only for a camera on its own
 * (a recorder's two-way audio is the recorder's own audio out) and over plain http (the
 * audio stream isn't sent over TLS). null when talking isn't possible this way.
 */
export function isapiTalkUrl(o: { lanUrl: string; user: string; password: string; channels: { proxied: boolean }[] }): string | null {
  if (o.channels.length !== 1 || o.channels[0].proxied) return null;
  let u: URL;
  try {
    u = new URL(/^\w+:\/\//.test(o.lanUrl) ? o.lanUrl : `http://${o.lanUrl}`);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:') return null;
  return `http://${encodeURIComponent(o.user)}:${encodeURIComponent(o.password)}@${u.host}`;
}

/** Recorded: rtsp://user:pass@host:554/Streaming/tracks/101?starttime=20240501T100000Z&endtime=… */
export function playbackUrl(o: {
  host: string;
  port: number;
  user: string;
  password: string;
  channel: number;
  start: number;
  end: number;
  clock: DeviceClock;
}): string {
  return `${rtspBase(o)}/Streaming/tracks/${streamId(o.channel, 'main')}?starttime=${rtspTime(o.start, o.clock)}&endtime=${rtspTime(o.end, o.clock)}`;
}

// ---------------------------------------------------------------------------------------------
// Recordings search

/** Searches all recordings unless `metadata` narrows it (e.g. "AllEvent" = event recordings only). */
export function searchXml(o: {
  searchId: string;
  track: number;
  start: number;
  end: number;
  clock: DeviceClock;
  position: number;
  maxResults: number;
  metadata?: string;
}): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<CMSearchDescription>' +
    `<searchID>${escapeXml(o.searchId)}</searchID>` +
    `<trackIDList><trackID>${o.track}</trackID></trackIDList>` +
    `<timeSpanList><timeSpan><startTime>${searchTime(o.start, o.clock)}</startTime><endTime>${searchTime(o.end, o.clock)}</endTime></timeSpan></timeSpanList>` +
    `<maxResults>${o.maxResults}</maxResults>` +
    // Sic: Hikvision's schema spells it "Postion".
    `<searchResultPostion>${o.position}</searchResultPostion>` +
    (o.metadata ? `<metadataList><metadataDescriptor>//recordType.meta.std-cgi.com/${escapeXml(o.metadata)}</metadataDescriptor></metadataList>` : '') +
    '</CMSearchDescription>'
  );
}

export interface SearchMatch {
  track: number;
  start: number;
  end: number;
  playbackUri: string;
  /** e.g. "recordType.meta.std-cgi.com/VMD" (may be empty). */
  recordType: string;
}

export interface SearchPage {
  matches: SearchMatch[];
  /** "MORE" when another page is waiting. */
  more: boolean;
}

/** CMSearchResult → matches. Devices use `searchMatchItem`; the spec says `matchElement`. */
export function parseSearchResult(xml: string, clock: DeviceClock): SearchPage {
  const status = (xmlText(xml, 'responseStatusStrg') ?? '').toUpperCase();
  const blocks = [...xmlBlocks(xml, 'searchMatchItem'), ...xmlBlocks(xml, 'matchElement')];
  const matches: SearchMatch[] = [];
  for (const b of blocks) {
    const span = xmlBlocks(b, 'timeSpan')[0] ?? b;
    const start = parseHikTime(xmlText(span, 'startTime') ?? '', clock);
    const end = parseHikTime(xmlText(span, 'endTime') ?? '', clock);
    if (start == null || end == null) continue;
    matches.push({
      track: Number(xmlText(b, 'trackID')) || 0,
      start,
      end,
      playbackUri: xmlText(b, 'playbackURI') ?? '',
      recordType: xmlText(b, 'metadataDescriptor') ?? '',
    });
  }
  return { matches, more: status === 'MORE' };
}

export function mergeSegments(spans: { start: number; end: number }[], toleranceSec = 2): RecordingSegment[] {
  const out: RecordingSegment[] = [];
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    if (s.end <= s.start) continue;
    const last = out[out.length - 1];
    if (last && s.start - last.end <= toleranceSec) last.end = Math.max(last.end, s.end);
    else out.push({ start: s.start, end: s.end });
  }
  return out;
}

/**
 * What a recording's type means for events. Continuous/scheduled/manual recordings are not
 * events. Smart events (line crossing, intrusion, region entry/exit) are alerts; plain motion is
 * a detection; AcuSense human/vehicle types name the object.
 */
export function classifyRecordType(descriptor: string): { objects: string[]; severity: Severity } | null {
  const t = (descriptor.split('/').pop() ?? '').toLowerCase();
  if (/^(cmr|timing|time|continuous|manual|command|schedule)$/.test(t)) return null;
  if (/human|person|pedestrian|face/.test(t)) return { objects: ['person'], severity: 'alert' };
  if (/vehicle|car|plate|lpr|anpr/.test(t)) return { objects: ['vehicle'], severity: 'alert' };
  if (/line|field|intrusion|region|perimeter|smart|alarm|^io/.test(t)) return { objects: [], severity: 'alert' };
  return { objects: [], severity: 'detection' };
}

export function matchesToReview(matches: SearchMatch[], systemId: string, cameraId: string): ReviewItem[] {
  const out: ReviewItem[] = [];
  const seen = new Set<string>();
  for (const m of matches) {
    const kind = classifyRecordType(m.recordType);
    if (!kind) continue;
    const id = `${cameraId}:${Math.floor(m.start)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      systemId,
      cameraId,
      startTime: m.start,
      endTime: m.end,
      severity: kind.severity,
      objects: kind.objects,
      subLabels: [],
      zones: [],
      reviewed: false,
    });
  }
  return out;
}

/** dailyDistribution request for one month. */
export function dailyDistributionXml(year: number, month: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?><trackDailyParam><year>${year}</year><monthOfYear>${month}</monthOfYear></trackDailyParam>`;
}

/** trackDailyDistribution → "YYYY-MM-DD" days that have recordings. */
export function parseDailyDistribution(xml: string, year: number, month: number): string[] {
  const out: string[] = [];
  for (const b of xmlBlocks(xml, 'day')) {
    const day = Number(xmlText(b, 'dayOfMonth') ?? xmlText(b, 'id'));
    if (day > 0 && (xmlText(b, 'record') ?? '').toLowerCase() === 'true') out.push(`${year}-${p2(month)}-${p2(day)}`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// PTZ

/** PTZ capabilities: pan/tilt and zoom spaces advertised by `/PTZCtrl/channels/<n>/capabilities`. */
export function parsePtzCaps(xml: string): { canMove: boolean; canZoom: boolean } {
  return {
    canMove: /<(?:\w+:)?(ContinuousPanTiltSpace|AbsolutePanTiltPositionSpace)[\s>]/.test(xml),
    canZoom: /<(?:\w+:)?(ContinuousZoomSpace|AbsoluteZoomPositionSpace)[\s>]/.test(xml),
  };
}

/** PTZPresetList → enabled presets as name → id (cameras list all 256 slots, most unused). */
export function parsePtzPresets(xml: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const b of xmlBlocks(xml, 'PTZPreset')) {
    if ((xmlText(b, 'enabled') ?? 'true') === 'false') continue;
    const id = Number(xmlText(b, 'id'));
    if (!Number.isInteger(id)) continue;
    const name = xmlText(b, 'presetName') || tr().systems.common.presetN(id);
    if (!out.has(name)) out.set(name, id);
  }
  return out;
}

/** Continuous move body; speeds are -100…100 and a zero body stops. */
export function ptzXml(action: string, speed = 60): string | null {
  const v: Record<string, [number, number, number]> = {
    MOVE_UP: [0, speed, 0],
    MOVE_DOWN: [0, -speed, 0],
    MOVE_LEFT: [-speed, 0, 0],
    MOVE_RIGHT: [speed, 0, 0],
    ZOOM_IN: [0, 0, speed],
    ZOOM_OUT: [0, 0, -speed],
    STOP: [0, 0, 0],
  };
  const m = v[action];
  if (!m) return null;
  return `<?xml version="1.0" encoding="UTF-8"?><PTZData><pan>${m[0]}</pan><tilt>${m[1]}</tilt><zoom>${m[2]}</zoom></PTZData>`;
}

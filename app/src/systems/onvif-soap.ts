/**
 * Pure ONVIF helpers: SOAP envelope building, WS-Security UsernameToken, and small
 * namespace-agnostic XML extractors for the responses Sightline needs. No platform imports
 * (unit tested under plain Node in test/onvif.test.ts).
 *
 * The extractors are deliberately simple: ONVIF responses are machine-generated, so matching
 * elements by local name (ignoring the prefix, which differs between vendors) is reliable.
 */

export const NS = {
  soap: 'http://www.w3.org/2003/05/soap-envelope',
  tds: 'http://www.onvif.org/ver10/device/wsdl',
  trt: 'http://www.onvif.org/ver10/media/wsdl',
  tr2: 'http://www.onvif.org/ver20/media/wsdl',
  tptz: 'http://www.onvif.org/ver20/ptz/wsdl',
  tev: 'http://www.onvif.org/ver10/events/wsdl',
  tt: 'http://www.onvif.org/ver10/schema',
  wsse: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd',
  wsu: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd',
} as const;

const PASSWORD_DIGEST =
  'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest';
const BASE64_BINARY =
  'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary';

// ---------------------------------------------------------------------------------------------
// Encoding

export function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
}

export function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'amp') return '&';
    if (k === 'quot') return '"';
    if (k === 'apos') return "'";
    const code = k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : m;
  });
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function base64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const n = (a << 16) | (b << 8) | c;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? B64[n & 63] : '=';
  }
  return out;
}

export function utf8(s: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(s) as Uint8Array<ArrayBuffer>;
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// WS-Security UsernameToken

export type Sha1 = (data: Uint8Array<ArrayBuffer>) => Promise<Uint8Array>;

/** PasswordDigest = Base64(SHA1(nonce + created + password)), nonce as raw bytes. */
export async function passwordDigest(nonce: Uint8Array, created: string, password: string, sha1: Sha1): Promise<string> {
  return base64(await sha1(concat(nonce, utf8(created), utf8(password))));
}

/** ONVIF devices are picky about timestamps: UTC, whole seconds, trailing Z. */
export function onvifTimestamp(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export async function securityHeader(opts: {
  username: string;
  password: string;
  nonce: Uint8Array;
  created: string;
  sha1: Sha1;
}): Promise<string> {
  const digest = await passwordDigest(opts.nonce, opts.created, opts.password, opts.sha1);
  return (
    `<wsse:Security s:mustUnderstand="1" xmlns:wsse="${NS.wsse}" xmlns:wsu="${NS.wsu}">` +
    `<wsse:UsernameToken>` +
    `<wsse:Username>${escapeXml(opts.username)}</wsse:Username>` +
    `<wsse:Password Type="${PASSWORD_DIGEST}">${digest}</wsse:Password>` +
    `<wsse:Nonce EncodingType="${BASE64_BINARY}">${base64(opts.nonce)}</wsse:Nonce>` +
    `<wsu:Created>${opts.created}</wsu:Created>` +
    `</wsse:UsernameToken></wsse:Security>`
  );
}

/** SOAP 1.2 envelope with every namespace the request bodies use. */
export function envelope(body: string, header = ''): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<s:Envelope xmlns:s="${NS.soap}" xmlns:tds="${NS.tds}" xmlns:trt="${NS.trt}" xmlns:tr2="${NS.tr2}" ` +
    `xmlns:tptz="${NS.tptz}" xmlns:tt="${NS.tt}">` +
    (header ? `<s:Header>${header}</s:Header>` : '') +
    `<s:Body>${body}</s:Body></s:Envelope>`
  );
}

// ---------------------------------------------------------------------------------------------
// Request bodies

const tok = (tag: string, value: string) => `<${tag}>${escapeXml(value)}</${tag}>`;

export const body = {
  getSystemDateAndTime: () => '<tds:GetSystemDateAndTime/>',
  getDeviceInformation: () => '<tds:GetDeviceInformation/>',
  getServices: () => '<tds:GetServices><tds:IncludeCapability>false</tds:IncludeCapability></tds:GetServices>',
  getCapabilities: () => '<tds:GetCapabilities><tds:Category>All</tds:Category></tds:GetCapabilities>',

  getProfiles: (media2: boolean) => (media2 ? '<tr2:GetProfiles><tr2:Type>All</tr2:Type></tr2:GetProfiles>' : '<trt:GetProfiles/>'),
  getStreamUri: (profile: string, media2: boolean) =>
    media2
      ? `<tr2:GetStreamUri><tr2:Protocol>RTSP</tr2:Protocol>${tok('tr2:ProfileToken', profile)}</tr2:GetStreamUri>`
      : `<trt:GetStreamUri><trt:StreamSetup><tt:Stream>RTP-Unicast</tt:Stream><tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport></trt:StreamSetup>${tok('trt:ProfileToken', profile)}</trt:GetStreamUri>`,
  getSnapshotUri: (profile: string, media2: boolean) =>
    media2
      ? `<tr2:GetSnapshotUri>${tok('tr2:ProfileToken', profile)}</tr2:GetSnapshotUri>`
      : `<trt:GetSnapshotUri>${tok('trt:ProfileToken', profile)}</trt:GetSnapshotUri>`,

  getNodes: () => '<tptz:GetNodes/>',
  getPresets: (profile: string) => `<tptz:GetPresets>${tok('tptz:ProfileToken', profile)}</tptz:GetPresets>`,
  gotoPreset: (profile: string, preset: string) =>
    `<tptz:GotoPreset>${tok('tptz:ProfileToken', profile)}${tok('tptz:PresetToken', preset)}</tptz:GotoPreset>`,
  continuousMove: (profile: string, v: { x: number; y: number } | { zoom: number }) =>
    `<tptz:ContinuousMove>${tok('tptz:ProfileToken', profile)}<tptz:Velocity>` +
    ('zoom' in v ? `<tt:Zoom x="${v.zoom}"/>` : `<tt:PanTilt x="${v.x}" y="${v.y}"/>`) +
    `</tptz:Velocity></tptz:ContinuousMove>`,
  stop: (profile: string) =>
    `<tptz:Stop>${tok('tptz:ProfileToken', profile)}<tptz:PanTilt>true</tptz:PanTilt><tptz:Zoom>true</tptz:Zoom></tptz:Stop>`,
};

// ---------------------------------------------------------------------------------------------
// Namespace-agnostic XML extraction

export interface XmlElement {
  attrs: Record<string, string>;
  inner: string;
}

const NAME_PREFIX = '(?:[A-Za-z_][\\w.-]*:)?';

function parseAttrs(s: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const name = m[1].includes(':') ? m[1].slice(m[1].indexOf(':') + 1) : m[1];
    attrs[name] = decodeXml(m[2] ?? m[3] ?? '');
  }
  return attrs;
}

/**
 * All outermost elements with this local name (any or no prefix), in document order.
 * Elements of the same name nested inside a match are part of its `inner`.
 */
export function elements(xml: string, local: string): XmlElement[] {
  const src = xml.replace(/<!--[\s\S]*?-->/g, '');
  const re = new RegExp(`<(/)?${NAME_PREFIX}${local}(?=[\\s/>])([^>]*)>`, 'g');
  const out: XmlElement[] = [];
  let depth = 0;
  let start = 0;
  let attrs: Record<string, string> = {};
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const closing = !!m[1];
    const selfClosing = !closing && m[2].trimEnd().endsWith('/');
    if (closing) {
      if (depth === 0) continue;
      depth--;
      if (depth === 0) out.push({ attrs, inner: src.slice(start, m.index) });
    } else if (selfClosing) {
      if (depth === 0) out.push({ attrs: parseAttrs(m[2].replace(/\/\s*$/, '')), inner: '' });
    } else {
      if (depth === 0) {
        attrs = parseAttrs(m[2]);
        start = m.index + m[0].length;
      }
      depth++;
    }
  }
  return out;
}

export function child(xml: string, local: string): XmlElement | undefined {
  return elements(xml, local)[0];
}

/** Decoded, trimmed text of the first element with this local name ('' when missing). */
export function text(xml: string, local: string): string {
  const el = child(xml, local);
  return el ? decodeXml(el.inner.replace(/<[^>]*>/g, '')).trim() : '';
}

/** Local part of a QName like "ter:NotAuthorized". */
const localPart = (q: string) => q.slice(q.indexOf(':') + 1);

// ---------------------------------------------------------------------------------------------
// Faults

export interface SoapFault {
  /** Code and subcode values, local parts only (e.g. ["Sender", "NotAuthorized"]). */
  codes: string[];
  reason: string;
}

export function parseFault(xml: string): SoapFault | null {
  const fault = child(xml, 'Fault');
  if (!fault) return null;
  const code = child(fault.inner, 'Code');
  const codes: string[] = [];
  if (code) {
    const re = new RegExp(`<${NAME_PREFIX}Value[^>]*>([^<]*)<`, 'g');
    for (let m = re.exec(code.inner); m; m = re.exec(code.inner)) codes.push(localPart(decodeXml(m[1]).trim()));
  }
  const legacy = text(fault.inner, 'faultcode');
  if (legacy) codes.push(localPart(legacy));
  const reason = text(fault.inner, 'Text') || text(fault.inner, 'faultstring') || text(fault.inner, 'Reason');
  return { codes, reason };
}

export function isAuthFault(f: SoapFault): boolean {
  return (
    f.codes.some((c) => /NotAuthori[sz]ed|FailedAuthentication|InvalidSecurity|Unauthori[sz]ed|FailedCheck/i.test(c)) ||
    /not authori[sz]ed|unauthori[sz]ed|authenticat|password|credential/i.test(f.reason)
  );
}

/** Plain-language message for a fault (no SOAP jargon). */
export function faultMessage(f: SoapFault): string {
  if (isAuthFault(f)) return 'Wrong username or password.';
  if (f.codes.some((c) => /ActionNotSupported|NotSupported|NoSuchService/i.test(c))) {
    return 'The camera doesn’t support this feature.';
  }
  return f.reason ? `The camera refused the request: ${f.reason}` : 'The camera refused the request.';
}

// ---------------------------------------------------------------------------------------------
// Responses

export interface DeviceInfo {
  manufacturer: string;
  model: string;
  firmware: string;
  serial: string;
}

export function parseDeviceInfo(xml: string): DeviceInfo {
  return {
    manufacturer: text(xml, 'Manufacturer'),
    model: text(xml, 'Model'),
    firmware: text(xml, 'FirmwareVersion'),
    serial: text(xml, 'SerialNumber'),
  };
}

/** A human name for the device: "Amcrest IP4M-1041B", without repeating the brand. */
export function deviceName(d: DeviceInfo): string {
  const brand = d.manufacturer.trim();
  const model = d.model.trim();
  if (!brand) return model;
  if (!model || model.toLowerCase().includes(brand.toLowerCase())) return model || brand;
  return `${brand} ${model}`;
}

/** Camera clock in ms since epoch (UTC), or null if the camera doesn't report UTC. */
export function parseSystemTime(xml: string): number | null {
  const utc = child(xml, 'UTCDateTime');
  if (!utc) return null;
  const n = (name: string) => Number(text(utc.inner, name));
  const v = [n('Year'), n('Month'), n('Day'), n('Hour'), n('Minute'), n('Second')];
  if (v.some((x) => !Number.isFinite(x)) || v[0] < 2000) return null;
  return Date.UTC(v[0], v[1] - 1, v[2], v[3], v[4], v[5]);
}

export interface ServiceAddrs {
  device?: string;
  media?: string;
  media2?: string;
  ptz?: string;
  events?: string;
}

const SERVICE_NS: [string, keyof ServiceAddrs][] = [
  ['/ver10/device/wsdl', 'device'],
  ['/ver10/media/wsdl', 'media'],
  ['/ver20/media/wsdl', 'media2'],
  ['/ver20/ptz/wsdl', 'ptz'],
  ['/ver10/events/wsdl', 'events'],
];

/** Some devices list several addresses (IPv4 and IPv6) separated by spaces; use the first. */
const firstAddr = (s: string) => s.split(/\s+/).find(Boolean) ?? '';

export function parseServices(xml: string): ServiceAddrs {
  const out: ServiceAddrs = {};
  for (const s of elements(xml, 'Service')) {
    const ns = text(s.inner, 'Namespace');
    const addr = firstAddr(text(s.inner, 'XAddr'));
    const hit = SERVICE_NS.find(([suffix]) => ns.endsWith(suffix));
    if (hit && addr && !out[hit[1]]) out[hit[1]] = addr;
  }
  return out;
}

export function parseCapabilities(xml: string): ServiceAddrs {
  const caps = child(xml, 'Capabilities');
  if (!caps) return {};
  const addr = (name: string) => {
    const el = child(caps.inner, name);
    return el ? firstAddr(text(el.inner, 'XAddr')) || undefined : undefined;
  };
  return { device: addr('Device'), media: addr('Media'), ptz: addr('PTZ'), events: addr('Events') };
}

export interface MediaProfile {
  token: string;
  name: string;
  /** Physical video source (sensor / NVR channel); profiles sharing it are one camera. */
  sourceToken: string;
  encoding: string;
  width: number;
  height: number;
  /** PTZ node, when the profile has a PTZ configuration. */
  ptz: { nodeToken: string } | null;
}

/** GetProfiles from Media (ver10) or Media2 (ver20); both use the same element names inside. */
export function parseProfiles(xml: string): MediaProfile[] {
  return elements(xml, 'Profiles')
    .filter((p) => p.attrs.token)
    .map((p) => {
      const src = child(p.inner, 'VideoSourceConfiguration') ?? child(p.inner, 'VideoSource');
      const enc = child(p.inner, 'VideoEncoderConfiguration') ?? child(p.inner, 'VideoEncoder');
      const res = enc ? child(enc.inner, 'Resolution') : undefined;
      const bounds = src ? child(src.inner, 'Bounds') : undefined;
      const ptz = child(p.inner, 'PTZConfiguration') ?? child(p.inner, 'PTZ');
      const width = Number(res ? text(res.inner, 'Width') : bounds?.attrs.width) || 0;
      const height = Number(res ? text(res.inner, 'Height') : bounds?.attrs.height) || 0;
      return {
        token: p.attrs.token,
        name: text(p.inner, 'Name'),
        sourceToken: src ? text(src.inner, 'SourceToken') : '',
        encoding: enc ? text(enc.inner, 'Encoding').toUpperCase() : '',
        width,
        height,
        ptz: ptz ? { nodeToken: text(ptz.inner, 'NodeToken') } : null,
      };
    });
}

/** First URI in a GetStreamUri / GetSnapshotUri response (Media: MediaUri/Uri; Media2: Uri). */
export function parseUri(xml: string): string {
  return text(xml, 'Uri');
}

export interface Preset {
  token: string;
  name: string;
}

export function parsePresets(xml: string): Preset[] {
  return elements(xml, 'Preset')
    .filter((p) => p.attrs.token)
    .map((p) => ({ token: p.attrs.token, name: text(p.inner, 'Name') || p.attrs.token }));
}

export interface PtzNode {
  token: string;
  canMove: boolean;
  canZoom: boolean;
}

export function parsePtzNodes(xml: string): PtzNode[] {
  return elements(xml, 'PTZNode').map((n) => ({
    token: n.attrs.token ?? '',
    canMove: !!child(n.inner, 'ContinuousPanTiltVelocitySpace'),
    canZoom: !!child(n.inner, 'ContinuousZoomVelocitySpace'),
  }));
}

// ---------------------------------------------------------------------------------------------
// Cameras from profiles

export interface OnvifCamera {
  /** Video source token (stable per sensor / channel). */
  id: string;
  main: MediaProfile;
  sub: MediaProfile;
  /** Profile used for PTZ commands, when any profile of this source has PTZ. */
  ptzProfile: MediaProfile | null;
}

const isStreamable = (p: MediaProfile) => p.encoding !== 'JPEG';

/**
 * Groups profiles by video source (multi-sensor cameras and ONVIF recorders expose one source
 * per lens/channel). Main = highest resolution, sub = lowest. MJPEG-only profiles are skipped
 * when a H.264/H.265 one exists, since only those can be played live.
 */
export function camerasFromProfiles(profiles: MediaProfile[]): OnvifCamera[] {
  const groups = new Map<string, MediaProfile[]>();
  for (const p of profiles) {
    const key = p.sourceToken || '';
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  const out: OnvifCamera[] = [];
  for (const [source, list] of groups) {
    const video = list.filter((p) => p.encoding || p.width);
    const usable = video.filter(isStreamable).length ? video.filter(isStreamable) : video.length ? video : list;
    const sorted = [...usable].sort((a, b) => b.width * b.height - a.width * a.height);
    out.push({
      id: source || sorted[0].token,
      main: sorted[0],
      sub: sorted[sorted.length - 1],
      ptzProfile: sorted.find((p) => p.ptz) ?? list.find((p) => p.ptz) ?? null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Addresses

/** Keeps only the path (and query) of an XAddr so requests go through the app's gateway. */
export function xaddrPath(xaddr: string | undefined, fallback: string): string {
  if (!xaddr) return fallback;
  const m = xaddr.match(/^[a-z][\w+.-]*:\/\/[^/?#]*([^#]*)/i);
  const path = m ? m[1] : xaddr.startsWith('/') ? xaddr : '';
  return path && path !== '/' ? path : fallback;
}

interface ParsedUrl {
  scheme: string;
  userinfo: string;
  host: string;
  port: string;
  rest: string;
}

export function parseUrl(url: string): ParsedUrl | null {
  const m = url.trim().match(/^([a-z][\w+.-]*):\/\/(?:([^@/?#]*)@)?(\[[^\]]+\]|[^/:?#]*)(?::(\d+))?(.*)$/i);
  if (!m) return null;
  return { scheme: m[1].toLowerCase(), userinfo: m[2] ?? '', host: m[3], port: m[4] ?? '', rest: m[5] ?? '' };
}

function ipv4(host: string): number[] | null {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}

function isPrivateV4(p: number[]): boolean {
  return p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127);
}

/**
 * Whether a host reported by the camera should be replaced by the address the user entered.
 * Cameras often report a loopback, link-local or internal address (or their LAN IP when the
 * user reaches them through a hostname or port forward). A different private IP on the same
 * subnet is kept: ONVIF recorders can hand out their cameras' own addresses.
 */
export function shouldRewriteHost(reported: string, configured: string): boolean {
  const r = reported.toLowerCase().replace(/^\[|\]$/g, '');
  const c = configured.toLowerCase().replace(/^\[|\]$/g, '');
  if (r === c) return false;
  if (!r || r === 'localhost' || r === '0.0.0.0' || r === '::' || r === '::1' || r.startsWith('fe80:')) return true;
  const rp = ipv4(r);
  const cp = ipv4(c);
  if (rp && (rp[0] === 127 || (rp[0] === 169 && rp[1] === 254))) return true;
  if (!rp) return !r.includes('.'); // bare names like "ipcam" don't resolve on the phone
  if (!cp || !isPrivateV4(cp)) return true; // reached by hostname / public address
  return !(rp[0] === cp[0] && rp[1] === cp[1] && rp[2] === cp[2]);
}

/**
 * Makes a camera-reported RTSP URL usable from the phone: points it at the configured host when
 * the reported one isn't reachable, and puts the login in it (URL-encoded).
 */
export function streamUrl(uri: string, configuredHost: string, username: string, password: string): string {
  const u = parseUrl(uri);
  if (!u) return uri;
  const host = configuredHost && shouldRewriteHost(u.host, configuredHost) ? configuredHost : u.host;
  const auth = username ? `${encodeURIComponent(username)}${password ? `:${encodeURIComponent(password)}` : ''}@` : u.userinfo ? `${u.userinfo}@` : '';
  return `${u.scheme}://${auth}${host}${u.port ? `:${u.port}` : ''}${u.rest}`;
}

/**
 * Snapshot URL through the gateway (which answers the camera's login challenge). Absolute URLs
 * that point at the camera itself become `${baseUrl}${path}`; others are returned unchanged.
 */
export function snapshotUrl(uri: string, baseUrl: string, configuredHost: string, configuredPort: string): string {
  if (!uri) return '';
  if (uri.startsWith('/')) return `${baseUrl}${uri}`;
  const u = parseUrl(uri);
  if (!u || (u.scheme !== 'http' && u.scheme !== 'https')) return uri;
  const port = u.port || (u.scheme === 'https' ? '443' : '80');
  const rewrite = shouldRewriteHost(u.host, configuredHost);
  const sameDevice = rewrite || u.host.toLowerCase() === configuredHost.toLowerCase();
  if (!sameDevice) return uri;
  // The gateway only reaches the configured port; a snapshot on another port is fetched directly.
  if (port === configuredPort) return `${baseUrl}${u.rest || '/'}`;
  return rewrite ? `${u.scheme}://${configuredHost}${u.port ? `:${u.port}` : ''}${u.rest}` : uri;
}

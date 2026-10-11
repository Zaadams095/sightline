/**
 * Diagnostics core: privacy scrubbing, the on-phone ring buffer of recent problems, and the
 * problem report. Pure (no app imports) so it is unit tested with node:test; the app wiring is
 * in ./log.ts and ./send.ts.
 *
 * Diagnostics must never carry anything that identifies a home or unlocks it: no addresses
 * (IP, MAC, host names, URLs), no usernames/passwords/tokens/cookies, no emails, and no
 * camera or system names (the caller passes those as `names`). What's left (brand, feature,
 * error category, short plain-language detail) is what's useful for fixing a brand in the field.
 * Mirrors bridge/diagnostics.go.
 */

const URL_RE = /\b([a-z][a-z0-9+.-]{1,15}):\/\/[^\s"'<>]+/gi;
const USER_PASS_RE = /[^\s:/@"']+:[^\s/@"']+@[^\s/"']+/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const JWT_RE = /eyJ[\w-]+\.[\w-]+\.[\w-]+/g;
const AUTH_SCHEME_RE = /\b(bearer|basic|digest)\s+[^\s,;]+/gi;
const KV_RE =
  /\b(password|passwd|pass|pwd|token|access_token|refresh_token|api[_-]?key|apikey|secret|auth|authorization|session|sessionid|sid|cookie|user|username|usr|privatekey|presharedkey)("?\s*[=:]\s*"?)[^\s&"',;]+/gi;
const IPV4_RE = /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?::\d{1,5})?\b/g;
const IPV6_RE = /\[?[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}(?:%[\w.]+)?\]?(?::\d{1,5})?/gi;
const MAC_RE = /\b[0-9a-f]{2}(?:-[0-9a-f]{2}){5}\b/gi;
const HOST_RE =
  /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|io|dev|me|us|uk|de|fr|nl|ca|au|info|biz|co|local|lan|home|internal|arpa|cloud|xyz|online|site)\b(?::\d{1,5})?/gi;
const TOKEN_RE = /[A-Za-z0-9+/=_-]{24,}/g;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Removes addresses, credentials, tokens, emails and the given names from free text. */
export function scrubText(input: string, names: readonly (string | undefined | null)[] = []): string {
  let s = String(input ?? '');
  // Longest first, so "Front Door Cam" goes before "Front Door".
  const literal = [...new Set(names.map((n) => (n ?? '').trim()).filter((n) => n.length >= 3))].sort((a, b) => b.length - a.length);
  for (const n of literal) s = s.replace(new RegExp(escapeRe(n), 'gi'), '<name>');
  s = s.replace(URL_RE, '$1://<redacted>');
  s = s.replace(USER_PASS_RE, '<credentials>@<host>');
  s = s.replace(EMAIL_RE, '<email>');
  s = s.replace(JWT_RE, '<token>');
  s = s.replace(AUTH_SCHEME_RE, '$1 <redacted>');
  s = s.replace(KV_RE, '$1$2<redacted>');
  s = s.replace(IPV4_RE, '<ip>');
  s = s.replace(MAC_RE, '<mac>');
  s = s.replace(IPV6_RE, (m) => {
    const core = m.replace(/^\[|\]$/g, '').split('%')[0];
    // Times (12:30:45) have three short groups and no "::"; addresses don't look like that.
    return core.includes('::') || (core.match(/:/g)?.length ?? 0) >= 3 ? '<ip>' : m;
  });
  s = s.replace(HOST_RE, '<host>');
  // UUIDs stay: iOS crash reports identify the app's code by binary UUID (needed to read them).
  s = s.replace(TOKEN_RE, (m) => (/\d/.test(m) && /[A-Za-z]/.test(m) && !UUID_RE.test(m) ? '<token>' : m));
  return s;
}

/** Scrubs, collapses whitespace and caps the length. */
export function scrubDetail(input: string, names: readonly (string | undefined | null)[] = [], max = 240): string {
  const s = scrubText(input, names).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Short, stable label for what went wrong, from any raw error text (Go, fetch, HTTP, player). */
export type ErrorCategory =
  | 'refused'
  | 'not-found-on-network'
  | 'name-not-found'
  | 'timeout'
  | 'tls'
  | 'auth'
  | 'forbidden'
  | 'http-404'
  | 'http-5xx'
  | 'http-other'
  | 'bad-reply'
  | 'no-vpn'
  | 'vpn'
  | 'codec'
  | 'offline'
  | 'other';

export function errorCategory(raw: unknown): ErrorCategory {
  const e = (raw instanceof Error ? raw.message : String(raw ?? '')).toLowerCase();
  if (/no vpn configuration|tunnel is not running|vpn is not available/.test(e)) return 'no-vpn';
  if (/wireguard|handshake|tunnel/.test(e)) return 'vpn';
  if (/\b401\b|unauthori[sz]ed|username or password|wrong user|password|credential|sign in|login failed/.test(e)) return 'auth';
  if (/\b403\b|forbidden|isn.t allowed|not allowed/.test(e)) return 'forbidden';
  if (/connection refused|didn.t accept the connection|econnrefused/.test(e)) return 'refused';
  if (/no such host|server misbehaving|couldn.t find an address|name not resolved|enotfound/.test(e)) return 'name-not-found';
  if (/certificate|x509|\btls\b|ssl/.test(e)) return 'tls';
  if (/timeout|timed out|deadline|didn.t answer|no response/.test(e)) return 'timeout';
  if (/no route to host|host is down|network is unreachable|unreachable|couldn.t (find|reach)|network request failed/.test(e)) return 'not-found-on-network';
  if (/codec|not supported|mse|decode/.test(e)) return 'codec';
  if (/\b404\b|didn.t recognize|not found/.test(e)) return 'http-404';
  if (/\b5\d\d\b|had a problem/.test(e)) return 'http-5xx';
  if (/http \d{3}|returned error \d{3}|status code/.test(e)) return 'http-other';
  if (/unexpected (reply|token)|json|xml|parse|unexpected answer/.test(e)) return 'bad-reply';
  if (/offline/.test(e)) return 'offline';
  return 'other';
}

/** Generic API words: kept in endpoint names. Anything else (IDs, camera names) becomes "*". */
const API_WORDS = new Set(
  (
    'api v1 v2 v3 ver10 ver20 cgi-bin isapi contentmgmt inputproxy streaming system video videos image images ' +
    'security adminaccesses deviceinfo channels cameras camera cam events event review reviews recordings record ' +
    'clips clip export playback proxy ptz ptzctrl ptzctrlproxy ptzpreset ptzpresets presets snapshot snapshots ' +
    'latest thumbnail thumbnails thumbs live stream streams login logout auth session info version config stats ' +
    'status summary search faces media media2_service media_service device_service ptz_service onvif wsdl ' +
    'protect frigate zm nph-zms monitors monitor activity motion q grants pair redeem invite devices diagnostics ' +
    'vod segments file files tracks viewed control command host time index json inputs g realmonitor ' +
    'h264 h265 mjpg main sub preview users user getevents getobjects getstatus getsystemstats ' +
    'getversion magicbox streamfile filethumb grab api.cgi ptz.cgi magicbox.cgi streamfile.cgi video.mjpg'
  ).split(/\s+/),
);

/**
 * A request path reduced to its API shape: `/api/front_door/latest.jpg?h=300` →
 * `/api/*\/latest.jpg`; Reolink-style `?cmd=GetAbility` keeps the command name. Query strings
 * (which can carry tokens) and anything not a generic API word (camera names, IDs) are dropped.
 */
export function endpointName(pathOrUrl: string): string {
  let path = pathOrUrl;
  let query = '';
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
      const u = new URL(path);
      path = u.pathname;
      query = u.search;
    }
  } catch {
    return '<url>';
  }
  const q = path.indexOf('?');
  if (q >= 0) {
    query = path.slice(q);
    path = path.slice(0, q);
  }
  const segs = path.split('/').filter(Boolean);
  const out: string[] = [];
  for (const seg of segs) {
    let word = seg;
    try {
      word = decodeURIComponent(seg);
    } catch {}
    const lower = word.toLowerCase();
    const dot = lower.lastIndexOf('.');
    const stem = dot > 0 ? lower.slice(0, dot) : lower;
    const ext = dot > 0 ? lower.slice(dot + 1) : '';
    let kept: string;
    if (API_WORDS.has(lower) || API_WORDS.has(stem)) kept = word;
    else if (ext && /^[a-z0-9]{1,5}$/.test(ext)) kept = `*.${ext}`;
    else kept = '*';
    if (kept === '*' && out[out.length - 1] === '*') continue;
    out.push(kept);
  }
  const cmd = /[?&]cmd=([A-Za-z]{1,40})(?:&|$)/.exec(query)?.[1];
  const action = /[?&]action=([A-Za-z]{1,40})(?:&|$)/.exec(query)?.[1];
  const suffix = cmd ? `?cmd=${cmd}` : action ? `?action=${action}` : '';
  return `/${out.join('/')}${suffix}`;
}

// ---- Ring buffer of recent problems (kept on the phone only) ----

/** Where in the app it happened. */
export type DiagArea = 'connect' | 'adapter' | 'player' | 'tunnel' | 'hub' | 'js' | 'crash';

export interface DiagEvent {
  /** Unix ms of the latest occurrence. */
  t: number;
  area: DiagArea;
  /** System kind ("frigate", "reolink", …): the brand, never a name or address. */
  brand?: string;
  /** What was being done: "lan", "tunnel", "/api/*\/latest.jpg", "live-mse", "start"… */
  feature?: string;
  /** Short category (see errorCategory). */
  category: string;
  /** Scrubbed, short detail (JS error message, HTTP status…). Optional. */
  detail?: string;
  /** Times it happened in a row (repeats are folded into one entry). */
  count: number;
}

export const DIAG_MAX_EVENTS = 150;
/** Repeats within this window fold into the previous entry. */
export const DIAG_FOLD_MS = 10 * 60_000;
const DETAIL_MAX = 400;
const FEATURE_MAX = 80;

const sameKind = (a: DiagEvent, b: Omit<DiagEvent, 't' | 'count'>) =>
  a.area === b.area && a.brand === b.brand && a.feature === b.feature && a.category === b.category && a.detail === b.detail;

/**
 * Adds an event, folding an immediate repeat into the previous entry and keeping at most
 * `max` (oldest dropped). Returns a new array; never mutates the input.
 */
export function pushEvent(list: readonly DiagEvent[], e: Omit<DiagEvent, 'count'> & { count?: number }, max = DIAG_MAX_EVENTS): DiagEvent[] {
  const ev: DiagEvent = {
    t: e.t,
    area: e.area,
    category: e.category.slice(0, 40),
    count: Math.max(1, e.count ?? 1),
    ...(e.brand ? { brand: e.brand.slice(0, 40) } : {}),
    ...(e.feature ? { feature: e.feature.slice(0, FEATURE_MAX) } : {}),
    ...(e.detail ? { detail: e.detail.slice(0, DETAIL_MAX) } : {}),
  };
  const last = list[list.length - 1];
  if (last && sameKind(last, ev) && ev.t - last.t <= DIAG_FOLD_MS) {
    return [...list.slice(0, -1), { ...last, t: ev.t, count: last.count + ev.count }];
  }
  const out = [...list, ev];
  return out.length > max ? out.slice(out.length - Math.max(0, max)) : out;
}

/** Parses stored events, dropping anything malformed (e.g. from an older app version). */
export function parseEvents(json: string | null | undefined, max = DIAG_MAX_EVENTS): DiagEvent[] {
  if (!json) return [];
  try {
    const raw = JSON.parse(json) as unknown;
    if (!Array.isArray(raw)) return [];
    let out: DiagEvent[] = [];
    for (const x of raw) {
      if (!x || typeof x !== 'object') continue;
      const o = x as Record<string, unknown>;
      if (typeof o.t !== 'number' || typeof o.area !== 'string' || typeof o.category !== 'string') continue;
      out = pushEvent(
        out,
        {
          t: o.t,
          area: o.area as DiagArea,
          category: o.category,
          count: typeof o.count === 'number' ? o.count : 1,
          brand: typeof o.brand === 'string' ? o.brand : undefined,
          feature: typeof o.feature === 'string' ? o.feature : undefined,
          detail: typeof o.detail === 'string' ? o.detail : undefined,
        },
        max,
      );
    }
    return out;
  } catch {
    return [];
  }
}

// ---- Problem report ----
//
// Everything that goes into a report is shown to the user first (the preview is exactly
// `text`), and every free-text field is scrubbed again here as a last line of defence.

export interface HubDiagnostics {
  version?: string;
  uptime?: number;
  systems?: { brand: string; connected: boolean }[];
  errors?: { time: number; brand: string; area: string; category: string; detail?: string; count: number }[];
}

export interface ReportInput {
  generatedAt: number;
  app: { version: string; build?: string; update?: string; channel?: string };
  device: { model?: string; os?: string };
  /** What the user typed. */
  note?: string;
  /** False: only the note and app/device versions are included. */
  includeDiagnostics: boolean;
  /** Brands of the systems set up (never names or addresses). */
  brands?: string[];
  events?: DiagEvent[];
  /** Raw MXDiagnosticPayload JSON strings, newest first. */
  metricKit?: string[];
  /** One entry per Hub the phone owns; a string is why it couldn't be fetched. */
  hubs?: (HubDiagnostics | string)[];
  /** The error that brought up the "Something went wrong" screen. */
  error?: { message: string; stack?: string };
  /** Names to scrub from every free-text field (systems, cameras, usernames, Wi-Fi…). */
  names?: string[];
}

export interface Report {
  subject: string;
  /** Readable report: the preview, and the email body. */
  text: string;
  /** `text` plus the raw (scrubbed) crash data, for the shared file. */
  file: string;
}

export const MAX_REPORT_EVENTS = 60;
/** Keeps a mailto: URL comfortably inside what iOS will open. */
export const MAILTO_BODY_MAX = 6000;

const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

const EXCEPTION_TYPES: Record<number, string> = {
  1: 'EXC_BAD_ACCESS',
  2: 'EXC_BAD_INSTRUCTION',
  3: 'EXC_ARITHMETIC',
  5: 'EXC_SOFTWARE',
  6: 'EXC_BREAKPOINT',
  10: 'EXC_CRASH',
  11: 'EXC_RESOURCE',
  12: 'EXC_GUARD',
};
const SIGNALS: Record<number, string> = { 4: 'SIGILL', 5: 'SIGTRAP', 6: 'SIGABRT', 9: 'SIGKILL', 10: 'SIGBUS', 11: 'SIGSEGV' };

type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Obj) : {});
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const str = (x: unknown): string => (typeof x === 'string' ? x : typeof x === 'number' ? String(x) : '');

/** One line per diagnostic in a MetricKit payload (crashes, hangs, CPU/disk/launch issues). */
export function summarizeMetricKit(json: string): string[] {
  let p: Obj;
  try {
    p = obj(JSON.parse(json));
  } catch {
    return ['(unreadable crash report)'];
  }
  const when = str(p.timeStampEnd) || str(p.timeStampBegin);
  const out: string[] = [];
  const meta = (d: unknown) => obj(obj(d).diagnosticMetaData);
  const versions = (m: Obj) => {
    const v = [m.appVersion && `app ${str(m.appVersion)}${m.appBuildVersion ? ` (${str(m.appBuildVersion)})` : ''}`, m.osVersion && str(m.osVersion)];
    return v.filter(Boolean).join(' · ');
  };
  for (const d of arr(p.crashDiagnostics)) {
    const m = meta(d);
    const type = typeof m.exceptionType === 'number' ? (EXCEPTION_TYPES[m.exceptionType] ?? `exception ${m.exceptionType}`) : '';
    const sig = typeof m.signal === 'number' ? (SIGNALS[m.signal] ?? `signal ${m.signal}`) : '';
    const objc = obj(m.objectiveCexceptionReason);
    const reason = str(objc.exceptionName) || str(m.terminationReason);
    const what = [type, sig && `(${sig})`, reason && `: ${scrubDetail(reason, [], 120)}`].filter(Boolean).join(' ');
    out.push(`${when} crash ${what || '(no details)'}${versions(m) ? ` · ${versions(m)}` : ''}`);
  }
  for (const d of arr(p.hangDiagnostics)) out.push(`${when} hang ${str(meta(d).hangDuration) || ''}`.trim());
  for (const d of arr(p.cpuExceptionDiagnostics)) out.push(`${when} too much CPU ${str(meta(d).totalCPUTime)}`.trim());
  for (const d of arr(p.diskWriteExceptionDiagnostics)) out.push(`${when} too many disk writes ${str(meta(d).writesCaused)}`.trim());
  for (const d of arr(p.appLaunchDiagnostics)) out.push(`${when} slow launch ${str(meta(d).launchDuration)}`.trim());
  return out.length ? out : [`${when} (no crash or hang details)`.trim()];
}

function eventLine(e: DiagEvent, names: string[]): string {
  const parts = [stamp(e.t), e.area, e.brand, e.feature, e.category].filter(Boolean).join('  ');
  const times = e.count > 1 ? ` ×${e.count}` : '';
  const detail = e.detail ? ` — ${scrubDetail(e.detail, names, 300)}` : '';
  return `${parts}${times}${detail}`;
}

function countBrands(brands: string[]): string {
  const counts = new Map<string, number>();
  for (const b of brands) counts.set(b, (counts.get(b) ?? 0) + 1);
  return [...counts].map(([b, n]) => (n > 1 ? `${b} ×${n}` : b)).join(', ');
}

/** The readable report (preview + email body) and the file version with raw crash data. */
export function formatReport(input: ReportInput): Report {
  const names = input.names ?? [];
  const lines: string[] = [];
  const add = (...l: string[]) => lines.push(...l);
  const build = [input.app.build && `build ${input.app.build}`, input.app.channel, input.app.update && `update ${input.app.update.slice(0, 8)}`]
    .filter(Boolean)
    .join(', ');

  add('Sightline problem report', `Made: ${stamp(input.generatedAt)} UTC`);
  add(`App: Sightline ${input.app.version}${build ? ` (${build})` : ''}`);
  if (input.device.model || input.device.os) add(`Device: ${[input.device.model, input.device.os].filter(Boolean).join(' · ')}`);

  add('', 'What happened:');
  add(input.note?.trim() ? scrubText(input.note.trim(), names) : '(no note)');

  if (input.error) {
    add('', 'Error on screen:', scrubDetail(input.error.message, names, 400));
    if (input.error.stack) {
      const frames = input.error.stack.split('\n').slice(0, 8).map((l) => `  ${scrubDetail(l, names, 160)}`);
      add(...frames);
    }
  }

  if (!input.includeDiagnostics) {
    add('', '(Diagnostics not included.)');
    const text = lines.join('\n');
    return { subject: `Sightline problem report (${input.app.version})`, text, file: text };
  }

  add('', `Recorders and cameras (brands only): ${input.brands?.length ? countBrands(input.brands) : 'none set up'}`);

  const events = [...(input.events ?? [])].reverse().slice(0, MAX_REPORT_EVENTS);
  add('', `Recent problems (newest first${(input.events?.length ?? 0) > MAX_REPORT_EVENTS ? `, latest ${MAX_REPORT_EVENTS}` : ''}):`);
  add(...(events.length ? events.map((e) => eventLine(e, names)) : ['none recorded']));

  const mk = input.metricKit ?? [];
  add('', 'Crash and hang reports from iOS:');
  add(...(mk.length ? mk.flatMap(summarizeMetricKit) : ['none']));

  if (input.hubs?.length) {
    add('', 'Sightline Hub:');
    for (const h of input.hubs) {
      if (typeof h === 'string') {
        add(`  couldn’t get its diagnostics (${scrubDetail(h, names, 120)})`);
        continue;
      }
      add(`  version ${h.version ?? '?'}${h.uptime != null ? `, up ${Math.round(h.uptime / 3600)} h` : ''}`);
      for (const s of h.systems ?? []) add(`  ${s.brand}: ${s.connected ? 'connected' : 'not connected'}`);
      const errs = [...(h.errors ?? [])].reverse().slice(0, 30);
      for (const e of errs) {
        add(
          `  ${stamp(e.time * 1000)}  ${e.brand}  ${e.area}  ${e.category}${e.count > 1 ? ` ×${e.count}` : ''}${e.detail ? ` — ${scrubDetail(e.detail, names, 200)}` : ''}`,
        );
      }
      if (!errs.length) add('  no recent errors');
    }
  }

  const text = lines.join('\n');
  const raw = mk.map((j, i) => `--- iOS diagnostic report ${i + 1} ---\n${scrubText(j, names)}`);
  const file = raw.length ? `${text}\n\n${raw.join('\n\n')}\n` : text;
  return { subject: `Sightline problem report (${input.app.version})`, text, file };
}

/** A mailto: link to `to` with the report as the body (shortened to stay openable). */
export function mailtoUrl(to: string, subject: string, body: string, max = MAILTO_BODY_MAX): string {
  const short = body.length > max ? `${body.slice(0, max)}\n\n(Shortened. Use “Share as file” to send everything.)` : body;
  return `mailto:${encodeURIComponent(to).replace(/%40/g, '@')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(short)}`;
}

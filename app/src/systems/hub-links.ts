/**
 * Pure helpers for the Sightline Hub (no React Native imports, so `npm test` covers them):
 * deep-link parsing, plain-language grant summaries, sharing date windows, and mapping the
 * Hub's capabilities and playback answers to the app's types.
 * API shapes: docs/HUB_API.md.
 */

import { fmtDate, fmtTime, tr } from '../i18n/index.ts';
import type { PlaybackSource, SystemCapabilities } from './types';

export type HubRole = 'owner' | 'full' | 'household' | 'temporary' | 'live';

/** What the caller can use on a Hub (GET /v1/info `capabilities`, already narrowed by the grant). */
export interface HubCapabilities {
  live: boolean;
  snapshots: boolean;
  events: boolean;
  recordings: boolean;
  clips: boolean;
  ptz: boolean;
  /** Instant Alerts can be delivered (newer Hubs). */
  alerts?: boolean;
  push: boolean;
  sharing: boolean;
  /** Some camera may take the caller's voice (newer Hubs; never for temporary/live guests). */
  talk?: boolean;
  /** Some camera has a spotlight or siren (newer Hubs; never for temporary/live guests). */
  deter?: boolean;
}

/**
 * The app's capabilities for a Hub, from what the Hub reports about its systems (any brand),
 * never assuming Frigate's features. Before /v1/info has answered: live and snapshots only.
 */
export function hubSystemCapabilities(c: HubCapabilities | undefined): SystemCapabilities {
  return {
    live: c?.live ?? true,
    snapshots: c?.snapshots ?? true,
    review: !!c?.events,
    events: !!c?.events,
    ptz: !!c?.ptz,
    twoWayAudio: !!c?.talk,
    deter: !!c?.deter,
  };
}

/** GET /v1/recordings/{cam}/playback (docs/HUB_API.md). URLs are relative to the Hub. */
export interface HubPlayback {
  kind: 'vod' | 'stream';
  url?: string;
  source?: { kind: 'mse' | 'file'; url: string; startTime?: number };
  start: number;
  end: number;
  startTime?: number;
}

/**
 * Maps the Hub's playback answer to the player's source. `media` turns a Hub-relative URL into
 * an absolute one carrying the token (players can't send headers).
 */
export function hubPlaybackSource(p: HubPlayback, media: (relative: string) => string): PlaybackSource {
  if (p.kind === 'stream' && p.source?.kind === 'mse') {
    const wsUrl = media(p.source.url).replace(/^http/, 'ws');
    return { kind: 'stream', source: { kind: 'mse', wsUrl }, ...(p.startTime ? { startTime: p.startTime } : {}) };
  }
  if (p.kind === 'stream' && p.source?.kind === 'file') {
    const file = { kind: 'file' as const, uri: media(p.source.url), ...(p.source.startTime ? { startTime: p.source.startTime } : {}) };
    return { kind: 'stream', source: file };
  }
  if (p.kind === 'vod' && p.url) return { kind: 'vod', uri: media(p.url) };
  throw new Error(tr().systems.hub.unsupportedPlayback);
}

/** Adds `token` to a URL that may already have a query. */
export function withToken(url: string, token: string | undefined): string {
  if (!token) return url;
  if (/[?&]token=/.test(url)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

/**
 * The Hub's live WebSocket takes the player's codecs in the URL, so it can send the picture
 * right after the upgrade instead of waiting for the codecs message (one round trip less,
 * which matters most over remote access). Other go2rtc endpoints keep the message only.
 */
export function acceptsCodecsInUrl(path: string): boolean {
  return /^\/v1\/cameras\/[^/?]+\/live(\?|$)/.test(path);
}

/** POST path that asks the Hub to start a camera's stream before the player connects. */
export function hubWarmPath(cameraId: string, quality?: 'main' | 'sub', codecs?: string): string {
  const q = [quality && `quality=${quality}`, codecs && `codecs=${encodeURIComponent(codecs)}`].filter(Boolean).join('&');
  return `/v1/cameras/${encodeURIComponent(cameraId)}/warm${q ? `?${q}` : ''}`;
}

/** How a Hub started a live view (its "hub" message), for the startup timing. */
export interface HubLiveStart {
  start: 'gop' | 'warm' | 'cold' | 'dedicated' | string;
  waitMs?: number;
  upstream?: { connectMs?: number; codecsMs?: number; initMs?: number; keyframeMs?: number };
}

export function parseHubLiveStart(value: unknown): HubLiveStart | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const v = JSON.parse(value) as HubLiveStart;
    return v && typeof v.start === 'string' ? v : undefined;
  } catch {
    return undefined;
  }
}

export type GuestRole = Exclude<HubRole, 'owner'>;

export interface HubGrant {
  id: string;
  name: string;
  role: HubRole;
  cameras: 'all' | string[];
  recordings: 'all' | 'none' | { from: number; to: number };
  expiresAt: number | null;
  createdAt: number;
  lastUsedAt?: number;
  devices: number;
  pendingInvite: boolean;
}

/** A scanned or tapped Sightline link. */
export interface HubLink {
  /** pair = owner pairing (setup page QR); invite = guest invite. */
  kind: 'pair' | 'invite';
  /** Address to try first. */
  url: string;
  lan?: string;
  remote?: string;
  code: string;
  name?: string;
}

/** Minimal query parser (React Native's URL doesn't implement searchParams everywhere). */
export function parseQuery(query: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of query.replace(/^[?#]/, '').split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    const k = i < 0 ? part : part.slice(0, i);
    const v = i < 0 ? '' : part.slice(i + 1);
    try {
      out[decodeURIComponent(k.replace(/\+/g, ' '))] = decodeURIComponent(v.replace(/\+/g, ' '));
    } catch {
      // ignore malformed escapes
    }
  }
  return out;
}

const httpUrl = (s: string | undefined) => (s && /^https?:\/\/[^/\s]+/i.test(s) ? s.replace(/\/+$/, '') : undefined);

/**
 * Parses `sightline://hub?url=…&code=…`, `sightline://invite?url=…&code=…` and the Hub's
 * `https://<hub>/invite?code=…` landing-page link. Returns null for anything else.
 */
export function parseHubLink(raw: string): HubLink | null {
  const s = raw.trim();
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?/i.exec(s);
  if (!m) return null;
  const [, scheme, host, path, query = ''] = m;
  const q = parseQuery(query);
  let kind: HubLink['kind'] | null = null;
  let url = httpUrl(q.url);
  if (scheme.toLowerCase() === 'sightline') {
    // sightline://invite?… (host form) or sightline:///invite?… (path form)
    const target = (host || path.replace(/^\/+/, '')).toLowerCase().replace(/\/+$/, '');
    if (target === 'hub' || target === 'pair') kind = 'pair';
    else if (target === 'invite') kind = 'invite';
  } else if (/^https?$/i.test(scheme) && path.replace(/\/+$/, '') === '/invite') {
    kind = 'invite';
    url = url ?? `${scheme.toLowerCase()}://${host}`;
  }
  const code = (q.code ?? '').trim();
  const lan = httpUrl(q.lan);
  const remote = httpUrl(q.remote);
  url = url ?? remote ?? lan;
  if (!kind || !code || !url) return null;
  return { kind, url, lan, remote, code, name: q.name?.trim() || undefined };
}

/** The two addresses a Hub can be reached at: home network first, public link second. */
export function hubAddresses(link: HubLink): { lanUrl: string; remoteUrl?: string } {
  // The Hub's public link is always https (Funnel); its home address is plain http.
  const remote = link.remote ?? (link.url.startsWith('https://') ? link.url : undefined);
  const lan = link.lan ?? (link.url !== remote ? link.url : remote!);
  return { lanUrl: lan, remoteUrl: remote && remote !== lan ? remote : undefined };
}

/** "192.168.1.20" → "http://192.168.1.20:8086"; full URLs are kept. */
export function normalizeHubAddress(input: string): string {
  const s = input.trim().replace(/\/+$/, '');
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  return /:\d+$/.test(s) ? `http://${s}` : `http://${s}:8086`;
}

/** Pairing codes are 6 digits; invite codes are 10 letters/digits (dashes and case ignored). */
export function looksLikePairingCode(code: string): boolean {
  return /^\d{6}$/.test(code.replace(/\s/g, ''));
}

// ---- plain-language text ----

/** Text for a role, read in the current language whenever it's used. */
const roleText = (role: GuestRole) => ({
  get label() {
    return tr().systems.hub.roles[role].label;
  },
  get description() {
    return tr().systems.hub.roles[role].description;
  },
});

export const ROLE_INFO: Record<GuestRole, { label: string; description: string }> = {
  full: roleText('full'),
  household: roleText('household'),
  temporary: roleText('temporary'),
  live: roleText('live'),
};

export function roleLabel(role: HubRole): string {
  return role === 'owner' ? tr().systems.hub.owner : ROLE_INFO[role].label;
}

/** "Oct 12" (same year) or "Oct 12, 2027"; adds the time when it isn't midnight/end of day. */
export function formatDay(unix: number, now: Date = new Date(), withTime = false): string {
  const d = new Date(unix * 1000);
  const sameYear = d.getFullYear() === now.getFullYear();
  let s = fmtDate(d, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
  if (withTime) {
    const h = d.getHours();
    const m = d.getMinutes();
    const endOfDay = h === 23 && m === 59;
    if (!(h === 0 && m === 0) && !endOfDay) s += ` ${fmtTime(d)}`;
  }
  return s;
}

/** "ends Oct 12", "ended Oct 2", or null when there's no end date. */
export function endsText(expiresAt: number | null, now: Date = new Date()): string | null {
  if (expiresAt == null) return null;
  const day = formatDay(expiresAt, now, true);
  return expiresAt * 1000 <= now.getTime() ? tr().systems.hub.ended(day) : tr().systems.hub.ends(day);
}

/** For guests: "Shared by Home · ends Oct 12". */
export function sharedByText(hubName: string, expiresAt: number | null, now: Date = new Date()): string {
  const ends = endsText(expiresAt, now);
  return ends ? tr().systems.hub.sharedByEnds(hubName, ends) : tr().systems.hub.sharedBy(hubName);
}

/** One line describing a grant: "2 cameras · recordings Oct 10 – Oct 12 · ends Oct 12". */
export function grantSummary(g: HubGrant, cameraName: (id: string) => string = (id) => id, now: Date = new Date()): string {
  const t = tr().systems.hub;
  const parts: string[] = [];
  if (g.cameras === 'all') parts.push(t.allCameras);
  else if (g.cameras.length === 2) parts.push(t.twoCameras(cameraName(g.cameras[0]), cameraName(g.cameras[1])));
  else if (g.cameras.length === 1) parts.push(cameraName(g.cameras[0]) || t.noCameras);
  else if (g.cameras.length === 0) parts.push(t.noCameras);
  else parts.push(tr().common.cameras(g.cameras.length));
  if (g.role !== 'owner') {
    if (g.recordings === 'none') parts.push(t.liveOnly);
    else if (typeof g.recordings === 'object')
      parts.push(t.recordingsRange(formatDay(g.recordings.from, now), formatDay(g.recordings.to, now)));
  }
  const ends = endsText(g.expiresAt, now);
  if (ends) parts.push(ends);
  if (g.role !== 'owner' && g.devices === 0) parts.push(g.pendingInvite ? t.inviteNotUsed : t.notJoined);
  return parts.join(' · ');
}

// ---- date windows for sharing ----

export type WindowPreset = 'today' | 'week' | 'custom';

const endOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 0, 0);
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);

/** Today: now → tonight 11:59 PM. This week: today 12:00 AM → 7 days from now, end of day. */
export function presetWindow(preset: Exclude<WindowPreset, 'custom'>, now: Date = new Date()): { from: number; to: number } {
  const from = startOfDay(now);
  const to = preset === 'today' ? endOfDay(now) : endOfDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7));
  return { from: Math.floor(from.getTime() / 1000), to: Math.floor(to.getTime() / 1000) };
}

/** Parses "2026-10-12", "2026-10-12 18:30" or "10/12/2026 6:30 pm" as local time. */
export function parseLocalDateTime(input: string, endOfDayIfNoTime = false): Date | null {
  const s = input.trim().toLowerCase();
  let y: number, mo: number, d: number;
  let rest = '';
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(.*)$/.exec(s);
  if (m) {
    [y, mo, d, rest] = [Number(m[1]), Number(m[2]), Number(m[3]), m[4]];
  } else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(.*)$/.exec(s))) {
    [mo, d, y, rest] = [Number(m[1]), Number(m[2]), Number(m[3]), m[4]];
  } else return null;
  let h = endOfDayIfNoTime ? 23 : 0;
  let min = endOfDayIfNoTime ? 59 : 0;
  rest = rest.trim();
  if (rest) {
    const t = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(rest);
    if (!t) return null;
    h = Number(t[1]);
    min = t[2] ? Number(t[2]) : 0;
    if (t[3] === 'pm' && h < 12) h += 12;
    if (t[3] === 'am' && h === 12) h = 0;
    if (h > 23 || min > 59) return null;
  }
  const date = new Date(y, mo - 1, d, h, min, 0, 0);
  if (date.getMonth() !== mo - 1 || date.getDate() !== d) return null; // e.g. Feb 30
  return date;
}

/** "2026-10-12 18:30" for prefilling custom date fields. */
export function formatLocalDateTime(unix: number): string {
  const d = new Date(unix * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Message shared with an invite (Messages, Mail…). */
export function inviteMessage(hubName: string, role: GuestRole, link: string, webLink?: string): string {
  const t = tr().systems.hub;
  const lines = [role === 'live' ? t.inviteLive(hubName) : t.inviteSee(hubName)];
  if (webLink) lines.push(t.inviteWeb(webLink));
  lines.push(t.inviteApp(link));
  return lines.join('\n\n');
}

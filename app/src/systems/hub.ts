import type { ZoneSupport } from '@/alerts/zones';
import type { SystemLink } from '@/net/connection';
import { noteRequestProblem } from '@/diagnostics/log';
import { secrets, SECRET } from '@/state/secrets';
import { useApp } from '@/state/store';
import {
  hubAddresses,
  hubPlaybackSource,
  hubSystemCapabilities,
  withToken,
  type GuestRole,
  type HubCapabilities,
  type HubGrant,
  type HubLink,
  type HubPlayback,
} from '@/systems/hub-links';
import type {
  Camera,
  CameraSystemAdapter,
  DeterAction,
  DeterInfo,
  LiveSource,
  MediaSource,
  PlaybackSource,
  PtzAction,
  PtzInfo,
  RecordingSegment,
  ReviewItem,
  Severity,
  SystemCapabilities,
  SystemConfig,
  TalkTarget,
} from '@/systems/types';
import { fetchWithTimeout } from '@/util/fetch';
import { tr } from '@/i18n';

/**
 * Sightline Hub adapter: one brand-neutral API in front of any system (docs/HUB_API.md).
 * The Hub is reached directly (home address, or its public Tailscale Funnel URL), never
 * through the WireGuard tunnel. The Hub enforces the grant, so a guest automatically sees
 * only the cameras and recordings they were given.
 *
 * Players (WebView WebSocket, expo-image, AVPlayer) can't send an Authorization header, so
 * media URLs carry the token as `?token=`.
 */

export type { HubCapabilities };

export interface HubInfo {
  sightline: 'hub';
  name: string;
  version: string;
  apiVersion: number;
  paired: boolean;
  lanUrl?: string;
  remoteUrl?: string | null;
  /** Each wrapped system and what it can do (capabilities: newer Hubs). */
  systems?: { id: string; kind: string; label: string; name: string; capabilities?: HubCapabilities }[];
  capabilities?: HubCapabilities;
  grant?: HubGrant;
  /** Optional behaviors of newer Hubs ("zones": enforces activity zones in device rules). */
  features?: string[];
  /** IANA time zone the Hub runs in (newer Hubs, when set). */
  timezone?: string;
}

export interface HubInvite {
  code: string;
  link: string;
  webLink?: string;
  expiresAt: number;
  /** data:image/png QR code of `link`, made by the Hub. */
  qr: string;
}

export interface GrantRequest {
  name: string;
  role: GuestRole;
  cameras: 'all' | string[];
  recordings?: 'all' | 'none' | { from: number; to: number };
  expiresAt: number | null;
}

interface HubCamera {
  id: string;
  name: string;
  enabled: boolean;
  ptz: boolean;
  aspect: number;
  zones: string[];
  objects: string[];
  detectSize: { width: number; height: number } | null;
}

interface HubEvent {
  id: string;
  camera: string;
  start: number;
  end: number | null;
  severity: Severity;
  objects: string[];
  subLabels: string[];
  zones: string[];
  detections: string[];
  reviewed: boolean;
}

interface TokenResponse {
  token: string;
  grant: HubGrant;
  hub: { name: string; lanUrl: string; remoteUrl?: string };
}

/** An error the Hub answered with (status 0 = no answer). */
export class HubError extends Error {
  constructor(
    message: string,
    readonly code = '',
    readonly status = 0,
  ) {
    super(message);
  }
}

async function hubError(res: Response, hubName: string): Promise<HubError> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  const code = body.error ?? '';
  if (code === 'revoked') return new HubError(tr().systems.hub.revoked(hubName), code, res.status);
  if (code === 'expired') return new HubError(tr().systems.hub.expired(hubName), code, res.status);
  if (res.status === 401 && code === 'unauthorized')
    return new HubError(tr().systems.hub.unpaired(hubName), code, res.status);
  return new HubError(body.message ?? tr().systems.hub.httpError(res.status), code, res.status);
}

// Tokens are read from the keychain once and cached, so media URLs can be built synchronously.
const tokens = new Map<string, string>();

export async function hubToken(systemId: string): Promise<string> {
  let t = tokens.get(systemId);
  if (!t) {
    t = (await secrets.get(systemId, SECRET.token)) ?? '';
    // Don't cache "none": on a restored phone the token can arrive from iCloud Keychain later.
    if (t) tokens.set(systemId, t);
  }
  return t;
}

export async function setHubToken(systemId: string, token: string): Promise<void> {
  tokens.set(systemId, token);
  await secrets.set(systemId, SECRET.token, token);
}

export async function forgetHubToken(systemId: string): Promise<void> {
  tokens.delete(systemId);
  await secrets.remove(systemId, SECRET.token);
}

function query(q?: Record<string, string | number | undefined>): string {
  if (!q) return '';
  const s = Object.entries(q)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');
  return s ? `?${s}` : '';
}

const enc = encodeURIComponent;

export class HubAdapter implements CameraSystemAdapter {
  info: HubInfo | null = null;

  constructor(
    readonly config: SystemConfig,
    private baseUrl: string,
  ) {
    void hubToken(config.id);
  }

  /** What the Hub says its systems can do for this phone (whatever brands are behind it). */
  get capabilities(): SystemCapabilities {
    return hubSystemCapabilities(this.info?.capabilities);
  }

  get hubName(): string {
    return this.info?.name ?? this.config.extra?.hubName ?? this.config.name;
  }

  setBaseUrl(url: string) {
    this.baseUrl = url;
  }

  /** URL with the token in the query, for players that can't send headers. */
  private mediaUrl(path: string, q?: Record<string, string | number | undefined>): string {
    return `${this.baseUrl}${path}${query({ ...q, token: tokens.get(this.config.id) })}`;
  }

  async request(method: string, path: string, body?: unknown, timeoutMs = 10000): Promise<Response> {
    const token = await hubToken(this.config.id);
    const res = await fetchWithTimeout(
      `${this.baseUrl}${path}`,
      {
        method,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      },
      timeoutMs,
    ).catch((e: unknown) => {
      noteRequestProblem('hub', path, e);
      throw e;
    });
    if (!res.ok) {
      noteRequestProblem('hub', path, `HTTP ${res.status}`);
      throw await hubError(res, this.hubName);
    }
    return res;
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    return (await (await this.request(method, path, body)).json()) as T;
  }

  async connect(): Promise<void> {
    const info = await this.json<HubInfo>('GET', '/v1/info');
    if (info.sightline !== 'hub' || !info.grant) throw new Error(tr().systems.hub.notAHub);
    this.info = info;
  }

  async listCameras(): Promise<Camera[]> {
    if (!this.info) await this.connect();
    const cams = await this.json<HubCamera[]>('GET', '/v1/cameras');
    return cams.map((c) => ({
      key: `${this.config.id}:${c.id}`,
      systemId: this.config.id,
      id: c.id,
      name: c.name,
      enabled: c.enabled,
      zones: c.zones,
      objects: c.objects,
      ptz: c.ptz,
      aspect: c.aspect || 16 / 9,
      detectSize: c.detectSize ?? undefined,
    }));
  }

  /**
   * Zones are enforced by the Hub's alert engine, which knows where objects were only when the
   * system behind it reports positions (it then publishes a detect size for the camera).
   */
  zoneSupport(camera: Camera): ZoneSupport {
    return camera.detectSize && this.info?.features?.includes('zones') && this.info.capabilities?.push ? 'precise' : false;
  }

  snapshot(cameraId: string, opts?: { height?: number }): MediaSource {
    return { uri: this.mediaUrl(`/v1/cameras/${enc(cameraId)}/snapshot.jpg`, { height: opts?.height }) };
  }

  async liveStream(cameraId: string, opts?: { quality?: 'main' | 'sub' }): Promise<LiveSource> {
    await hubToken(this.config.id);
    const url = this.mediaUrl(`/v1/cameras/${enc(cameraId)}/live`, { quality: opts?.quality });
    return { kind: 'mse', wsUrl: url.replace(/^http/, 'ws') };
  }

  async listReview(q: { cameras?: string[]; after?: number; before?: number; severity?: Severity; limit?: number }): Promise<ReviewItem[]> {
    const events = await this.json<HubEvent[]>(
      'GET',
      `/v1/events${query({
        cameras: q.cameras?.length ? q.cameras.join(',') : undefined,
        after: q.after,
        before: q.before ?? Math.floor(Date.now() / 1000) + 60,
        severity: q.severity,
        limit: q.limit ?? 100,
      })}`,
    );
    return events.map((e) => ({
      id: e.id,
      systemId: this.config.id,
      cameraId: e.camera,
      startTime: e.start,
      endTime: e.end,
      severity: e.severity,
      objects: e.objects,
      subLabels: e.subLabels,
      zones: e.zones,
      reviewed: e.reviewed,
      detections: e.detections,
      thumbnailUrl: this.mediaUrl(`/v1/events/${enc(e.id)}/thumbnail.jpg`),
    }));
  }

  async recordingSegments(cameraId: string, after: number, before: number): Promise<RecordingSegment[]> {
    return this.json<RecordingSegment[]>(
      'GET',
      `/v1/recordings/${enc(cameraId)}/segments${query({ after: Math.floor(after), before: Math.ceil(before) })}`,
    );
  }

  /**
   * Asks the Hub how to play the window (capped at 2 h): seekable HLS for recorders with VOD,
   * otherwise a replay stream (MSE WebSocket) or the recorder's MP4 file.
   */
  async playback(cameraId: string, start: number, end: number): Promise<PlaybackSource> {
    const token = await hubToken(this.config.id);
    const s = Math.floor(start);
    const e = Math.min(Math.ceil(end), s + 7200);
    try {
      const p = await this.json<HubPlayback>('GET', `/v1/recordings/${enc(cameraId)}/playback${query({ start: s, end: e })}`);
      return hubPlaybackSource(p, (rel) => withToken(`${this.baseUrl}${rel}`, token));
    } catch (err) {
      // Hubs older than the playback route only had HLS VOD (an unknown route is a bare 404).
      if (err instanceof HubError && err.status === 404 && err.code !== 'not_found') {
        return { kind: 'vod', uri: this.mediaUrl(`/v1/recordings/${enc(cameraId)}/vod.m3u8`, { start: s, end: e }) };
      }
      throw err;
    }
  }

  clip(cameraId: string, start: number, end: number): MediaSource {
    return {
      uri: this.mediaUrl(`/v1/recordings/${enc(cameraId)}/clip.mp4`, { start: Math.floor(start), end: Math.ceil(end) }),
    };
  }

  async ptzInfo(cameraId: string): Promise<PtzInfo> {
    return this.json<PtzInfo>('GET', `/v1/cameras/${enc(cameraId)}/ptz`);
  }

  async ptz(cameraId: string, action: PtzAction | `preset_${string}`): Promise<void> {
    await this.request('POST', `/v1/cameras/${enc(cameraId)}/ptz`, { action });
  }

  /**
   * The Hub asks the camera itself whether it can take audio (and remembers), so this is the
   * only check needed: available → the Hub's talk WebSocket. Guests without talk get 403.
   */
  async talkTarget(cameraId: string): Promise<TalkTarget | null> {
    if (!this.capabilities.twoWayAudio) return null;
    try {
      const r = await this.json<{ available: boolean }>('GET', `/v1/cameras/${enc(cameraId)}/talk`);
      if (!r.available) return null;
    } catch {
      return null;
    }
    await hubToken(this.config.id);
    return { kind: 'ws', url: this.mediaUrl(`/v1/cameras/${enc(cameraId)}/talk`).replace(/^http/, 'ws') };
  }

  async deterInfo(cameraId: string): Promise<DeterInfo> {
    if (!this.capabilities.deter) return { light: false, siren: false };
    try {
      return await this.json<DeterInfo>('GET', `/v1/cameras/${enc(cameraId)}/deter`);
    } catch (e) {
      // 501: this camera's system has no lights or sirens.
      if (e instanceof HubError && (e.status === 501 || e.status === 403)) return { light: false, siren: false };
      throw e;
    }
  }

  async deter(cameraId: string, action: DeterAction): Promise<void> {
    await this.request('POST', `/v1/cameras/${enc(cameraId)}/deter`, { action }, 20000);
  }

  // ---- sharing (owner / full access) ----

  listGrants(): Promise<HubGrant[]> {
    return this.json<HubGrant[]>('GET', '/v1/grants');
  }

  createGrant(req: GrantRequest): Promise<{ grant: HubGrant; invite: HubInvite }> {
    return this.json('POST', '/v1/grants', req);
  }

  reinvite(id: string): Promise<{ grant: HubGrant; invite: HubInvite }> {
    return this.json('POST', `/v1/grants/${enc(id)}/invite`);
  }

  async revokeGrant(id: string): Promise<void> {
    await this.request('DELETE', `/v1/grants/${enc(id)}`);
  }

  dispose(): void {}
}

// ---- reaching a Hub ----

/**
 * Finds a working route to a Hub: its home address first, then its public link. Also keeps
 * the saved public link / role / end date current (e.g. after remote access is turned on).
 */
export async function probeHub(s: SystemConfig): Promise<SystemLink> {
  const token = await hubToken(s.id);
  const remote = s.extra?.remoteUrl || undefined;
  const lan = s.endpoint.lanUrl.replace(/\/+$/, '');

  const attempt = async (base: string, ms: number): Promise<{ info?: HubInfo; error?: HubError }> => {
    try {
      const res = await fetchWithTimeout(`${base}/v1/info`, { headers: { Authorization: `Bearer ${token}` } }, ms);
      if (!res.ok) return { error: await hubError(res, s.extra?.hubName || s.name) };
      const info = (await res.json()) as HubInfo;
      if (info.sightline !== 'hub') return { error: new HubError(tr().systems.hub.notAHub) };
      if (!info.grant) return { error: new HubError(tr().systems.hub.notPaired, 'unauthorized', 401) };
      return { info };
    } catch (e) {
      return { error: new HubError(e instanceof Error ? e.message : String(e)) };
    }
  };
  const linkFor = (base: string): SystemLink =>
    base.startsWith('https://') ? { baseUrl: base, mode: 'tunnel', remote: true } : { baseUrl: base, mode: 'lan' };

  let r = await attempt(lan, remote && remote !== lan ? 1500 : 6000);
  let base = lan;
  // A revoked/expired answer is final; anything else (no answer, wrong device) tries the public link.
  const final = (e?: HubError) => e?.code === 'revoked' || e?.code === 'expired';
  if (!r.info && !final(r.error) && remote && remote !== lan) {
    const lanErr = r.error;
    r = await attempt(remote, 10000);
    base = remote;
    if (!r.info && !r.error?.status) r.error = new HubError(tr().systems.hub.cantReachBoth(lanErr?.message ?? '', r.error?.message ?? ''));
  } else if (!r.info && !r.error?.status && !remote && !lan.startsWith('https://')) {
    r.error = new HubError(
      tr().systems.hub.cantReachAt(lan),
    );
  }
  if (!r.info) return { baseUrl: base, mode: 'offline', error: r.error?.message };

  refreshHubConfig(s, r.info);
  return linkFor(base);
}

/** Saves what the Hub reports about itself and this phone's access, when it changed. */
function refreshHubConfig(s: SystemConfig, info: HubInfo) {
  const extra = {
    ...s.extra,
    remoteUrl: info.remoteUrl ?? s.extra?.remoteUrl ?? '',
    hubName: info.name,
    role: info.grant?.role ?? s.extra?.role ?? '',
    expiresAt: info.grant?.expiresAt != null ? String(info.grant.expiresAt) : '',
    // The Hub's (their house's) time zone: check-in times default to it.
    timezone: info.timezone ?? s.extra?.timezone ?? '',
  };
  const changed = (Object.keys(extra) as (keyof typeof extra)[]).some((k) => (s.extra?.[k] ?? '') !== extra[k]);
  if (changed) useApp.getState().upsertSystem({ ...s, extra });
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await hubError(res, tr().systems.hub.theHub);
  return (await res.json()) as T;
}

/**
 * Pairs (owner, 6-digit code) or redeems an invite (guest), trying each known address.
 * Returns the new system config; the token is already saved to the keychain.
 */
export async function joinHub(link: HubLink, opts: { deviceName?: string; systemName?: string } = {}): Promise<SystemConfig> {
  const { lanUrl, remoteUrl } = hubAddresses(link);
  const order = [...new Set([link.url, lanUrl, remoteUrl].filter((u): u is string => !!u))];
  const path = link.kind === 'pair' ? '/v1/pair' : '/v1/redeem';
  const body = link.kind === 'pair' ? { code: link.code.replace(/\s/g, ''), deviceName: opts.deviceName } : { code: link.code };

  let resp: TokenResponse | null = null;
  let lastErr: unknown = null;
  for (const base of order) {
    try {
      resp = await post<TokenResponse>(`${base}${path}`, body);
      break;
    } catch (e) {
      lastErr = e;
      if (e instanceof HubError && e.status) break; // the Hub answered (wrong code etc.)
    }
  }
  if (!resp) {
    if (lastErr instanceof HubError && lastErr.status) throw lastErr;
    throw new Error(
      link.kind === 'pair'
        ? tr().systems.hub.cantReachWifi(lanUrl)
        : tr().systems.hub.cantReach(lastErr instanceof Error ? lastErr.message : ''),
    );
  }

  const existing = useApp
    .getState()
    .systems.find((s) => s.kind === 'hub' && (s.endpoint.lanUrl === (resp.hub.lanUrl || lanUrl) || (!!remoteUrl && s.extra?.remoteUrl === remoteUrl)));
  const id = existing?.id ?? `hub-${Date.now().toString(36)}`;
  await setHubToken(id, resp.token);
  return {
    id,
    kind: 'hub',
    name: opts.systemName?.trim() || existing?.name || resp.hub.name || link.name || 'Sightline Hub',
    endpoint: { lanUrl: resp.hub.lanUrl || lanUrl, useTunnel: false },
    extra: {
      remoteUrl: resp.hub.remoteUrl || remoteUrl || '',
      hubName: resp.hub.name || link.name || '',
      role: resp.grant.role,
      expiresAt: resp.grant.expiresAt != null ? String(resp.grant.expiresAt) : '',
    },
  };
}

/** True when this phone can share access on the Hub (owner or full access). */
export function canShare(s: SystemConfig): boolean {
  return s.kind === 'hub' && (s.extra?.role === 'owner' || s.extra?.role === 'full');
}

/** True for systems someone else shared with this phone (household, temporary, live only). */
export function isGuest(s: SystemConfig): boolean {
  return s.kind === 'hub' && !!s.extra?.role && !canShare(s);
}

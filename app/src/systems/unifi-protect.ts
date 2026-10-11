import { useLinks } from '@/net/connection';
import { secrets, SECRET } from '@/state/secrets';
import type {
  Camera,
  CameraSystemAdapter,
  HealthReport,
  LiveSource,
  MediaSource,
  PlaybackSource,
  PtzAction,
  PtzInfo,
  ReviewItem,
  Severity,
  SystemCapabilities,
  SystemConfig,
} from '@/systems/types';
import {
  MAX_EXPORT_SEC,
  eventToReview,
  eventsQuery,
  exportPath,
  mapCameras,
  nextOpticalZoom,
  nextZoom,
  offlineCameras,
  pickChannel,
  presetNames,
  protectHttpMessage,
  protectLoginMessage,
  protectRtspUrl,
  relativeMove,
  storageOf,
  withRtspEnabled,
  type ProtectBootstrap,
  type ProtectCamera,
  type ProtectEvent,
  type ProtectPreset,
} from '@/systems/unifi-protect-format';
import { fetchWithTimeout } from '@/util/fetch';

/**
 * UniFi Protect on a UniFi OS console (Cloud Key Gen2+, UNVR, Dream Machine, Cloud Gateway).
 * Uses the console's local (unofficial) API, as Home Assistant's `uiprotect` does:
 * - POST /api/auth/login {username, password} → TOKEN session cookie + `x-csrf-token` header.
 *   The loopback gateway keeps the session cookie for this route, so images, thumbnails and
 *   video exports are authorized too; the CSRF token is sent by us on writes.
 * - GET /proxy/protect/api/bootstrap → cameras; /events → review items; /video/export → MP4.
 * Live video: Protect's RTSP restream of the camera (see protectRtspUrl), restreamed in-app.
 *
 * Not implemented: recording spans/days (Protect has no simple public query for them), and
 * marking events reviewed.
 */

const BOOT_TTL_MS = 30_000;
const PROTECT = '/proxy/protect/api';

export class UnifiProtectAdapter implements CameraSystemAdapter {
  readonly capabilities: SystemCapabilities = {
    live: true,
    snapshots: true,
    review: true,
    events: true,
    ptz: true,
    twoWayAudio: false,
    deter: false,
  };

  private csrf = '';
  /** True once this adapter has signed in itself (so its CSRF token matches the session). */
  private signedIn = false;
  private loggingIn: Promise<void> | null = null;
  private boot: { data: ProtectBootstrap; at: number } | null = null;
  private presets = new Map<string, { name: string; slot: number }[]>();

  constructor(
    readonly config: SystemConfig,
    private baseUrl: string,
  ) {}

  setBaseUrl(url: string) {
    this.baseUrl = url;
  }

  /** The current route (LAN or VPN port) can change after the adapter was created. */
  private get base(): string {
    return useLinks.getState().links[this.config.id]?.baseUrl || this.baseUrl;
  }

  // -------------------------------------------------------------------------------------------
  // Session

  /** fetch whose network failures become plain-language errors (never a loopback port). */
  private async send(url: string, init: RequestInit, timeoutMs = 10_000): Promise<Response> {
    try {
      return await fetchWithTimeout(url, init, timeoutMs);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.startsWith('No response')) throw new Error('UniFi Protect didn’t answer in time. Check that the console is on and reachable.');
      throw new Error('Couldn’t reach the UniFi console. Check the address and that your phone is on the same network.');
    }
  }

  private login(): Promise<void> {
    this.loggingIn ??= (async () => {
      const password = (await secrets.get(this.config.id, SECRET.password)) ?? '';
      const res = await this.send(`${this.base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ username: this.config.username ?? '', password, token: '', rememberMe: true }),
      });
      if (!res.ok) throw new Error(protectLoginMessage(res.status, await res.text().catch(() => '')));
      this.csrf = res.headers.get('x-csrf-token') ?? this.csrf;
      this.signedIn = true;
    })().finally(() => {
      this.loggingIn = null;
    });
    return this.loggingIn;
  }

  private async request(path: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<Response> {
    const isWrite = !!init.method && init.method !== 'GET';
    // Reads ride on the gateway's session cookie, but writes also need the CSRF token that
    // only a sign-in hands out. A recreated adapter has none yet, so sign in before its first write.
    if (isWrite && !this.csrf) await this.login();
    const attempt = () => {
      const headers: Record<string, string> = { Accept: 'application/json', ...(init.headers as Record<string, string>) };
      if (isWrite && this.csrf) headers['X-CSRF-Token'] = this.csrf;
      return this.send(`${this.base}${path}`, { ...init, headers }, timeoutMs);
    };
    const rotate = (r: Response) => {
      // UniFi OS rotates the CSRF token on some responses.
      const rotated = r.headers.get('x-updated-csrf-token') ?? r.headers.get('x-csrf-token');
      if (rotated) this.csrf = rotated;
    };
    let res = await attempt();
    rotate(res);
    // 401: the session expired. 403 on a write before we signed in ourselves: the CSRF token
    // doesn't belong to the gateway's session. Either way, sign in again and retry once.
    if (res.status === 401 || (isWrite && res.status === 403 && !this.signedIn)) {
      await this.login();
      res = await attempt();
      rotate(res);
    }
    if (!res.ok) throw new Error(protectHttpMessage(res.status));
    return res;
  }

  private parse<T>(text: string): T {
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error('The UniFi console sent an unexpected reply. Check that the address points to your UniFi console.');
    }
  }

  private async json<T>(path: string, init?: RequestInit, timeoutMs?: number): Promise<T> {
    return this.parse<T>(await (await this.request(path, init, timeoutMs)).text());
  }

  private async write<T>(method: 'POST' | 'PATCH', path: string, body?: unknown): Promise<T | null> {
    const res = await this.request(path, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return text ? this.parse<T>(text) : null;
  }

  private async bootstrap(force = false): Promise<ProtectBootstrap> {
    if (!force && this.boot && Date.now() - this.boot.at < BOOT_TTL_MS) return this.boot.data;
    const data = await this.json<ProtectBootstrap>(`${PROTECT}/bootstrap`, {}, 20_000);
    this.boot = { data, at: Date.now() };
    return data;
  }

  private async camera(cameraId: string): Promise<ProtectCamera> {
    const cam = (await this.bootstrap()).cameras?.find((c) => c.id === cameraId);
    if (!cam) throw new Error('That camera is no longer in UniFi Protect.');
    return cam;
  }

  async connect(): Promise<void> {
    await this.login();
    try {
      await this.bootstrap(true);
    } catch (e) {
      if (e instanceof Error && /HTTP 404|isn’t running/.test(e.message))
        throw new Error('Signed in, but UniFi Protect isn’t installed or running on this console.');
      throw e;
    }
  }

  async listCameras(): Promise<Camera[]> {
    return mapCameras(await this.bootstrap(true), this.config.id);
  }

  snapshot(cameraId: string, opts?: { height?: number }): MediaSource {
    const h = opts?.height ? `&h=${Math.round(opts.height)}` : '';
    return { uri: `${this.base}${PROTECT}/cameras/${encodeURIComponent(cameraId)}/snapshot?force=true${h}` };
  }

  // -------------------------------------------------------------------------------------------
  // Live

  async liveStream(cameraId: string, opts?: { quality?: 'main' | 'sub' }): Promise<LiveSource> {
    const quality = opts?.quality ?? 'main';
    let cam = await this.camera(cameraId);
    let ch = pickChannel(cam, quality);
    if (!ch?.rtspAlias) {
      // RTSP is off by default in Protect. Turning it on needs an account that can manage
      // cameras; homebridge-unifi-protect enables it the same way (PATCH the camera's channels).
      try {
        const updated = await this.write<ProtectCamera>('PATCH', `${PROTECT}/cameras/${encodeURIComponent(cameraId)}`, {
          channels: withRtspEnabled(cam),
        });
        this.boot = null;
        cam = updated?.channels ? { ...cam, ...updated } : await this.camera(cameraId);
        ch = pickChannel(cam, quality);
      } catch {
        ch = null;
      }
      if (!ch?.rtspAlias)
        throw new Error(
          'Live video needs this camera’s RTSP stream turned on. In UniFi Protect, open the camera → Settings → Advanced and turn on an RTSP stream (any quality). Or sign in here with an admin account and Sightline turns it on for you.',
        );
    }
    const boot = await this.bootstrap();
    const host = new URL(this.config.endpoint.lanUrl).hostname;
    return { kind: 'rtsp', url: protectRtspUrl(host, ch.rtspAlias, boot.nvr?.ports?.rtsp ?? 7447) };
  }

  // -------------------------------------------------------------------------------------------
  // Recordings: Protect builds an MP4 of any time range on request.

  /**
   * An MP4 export from `start`, at most 10 minutes long; seeking asks for a new window.
   * Protect builds the file on the fly, so the player may need to download it before playing
   * (whether AVPlayer can stream it directly is unverified).
   */
  async playback(cameraId: string, start: number, end: number): Promise<PlaybackSource> {
    const now = Date.now() / 1000;
    const e = Math.min(end, start + MAX_EXPORT_SEC, now);
    if (e <= start) throw new Error('There’s no recording at that time yet.');
    return { kind: 'stream', source: { kind: 'file', uri: `${this.base}${exportPath(cameraId, start, e)}` } };
  }

  clip(cameraId: string, start: number, end: number): MediaSource {
    return { uri: `${this.base}${exportPath(cameraId, start, end)}` };
  }

  // -------------------------------------------------------------------------------------------
  // Events

  async listReview(q: {
    cameras?: string[];
    after?: number;
    before?: number;
    severity?: Severity;
    limit?: number;
  }): Promise<ReviewItem[]> {
    const before = q.before ?? Date.now() / 1000 + 60;
    const after = q.after ?? before - 86400;
    const limit = q.limit ?? 100;
    // No server-side camera filter: over-fetch when only some cameras are wanted.
    const fetchLimit = Math.min(1000, q.cameras?.length ? limit * 4 : limit);
    const events = await this.json<ProtectEvent[]>(`${PROTECT}/events?${eventsQuery({ after, before, limit: fetchLimit })}`, {}, 20_000);
    const wanted = q.cameras?.length ? new Set(q.cameras) : null;
    return events
      .map((e) =>
        eventToReview(e, {
          systemId: this.config.id,
          thumbUrl: (id) => `${this.base}${PROTECT}/events/${encodeURIComponent(id)}/thumbnail`,
        }),
      )
      .filter((i): i is ReviewItem => !!i)
      .filter((i) => !wanted || wanted.has(i.cameraId))
      .filter((i) => !q.severity || i.severity === q.severity)
      .sort((a, b) => b.startTime - a.startTime)
      .slice(0, limit);
  }

  previewClip(item: ReviewItem): MediaSource {
    const end = item.endTime ?? item.startTime + 10;
    return this.clip(item.cameraId, Math.max(0, item.startTime - 2), Math.min(end, item.startTime + 20));
  }

  async health(): Promise<HealthReport> {
    const boot = await this.bootstrap(true);
    return { offline: offlineCameras(boot), storage: storageOf(boot) };
  }

  // -------------------------------------------------------------------------------------------
  // PTZ: PTZ cameras (G4/G5 PTZ) via /move and /ptz/*; optical-zoom cameras via ispSettings.

  async ptzInfo(cameraId: string): Promise<PtzInfo> {
    const cam = await this.camera(cameraId);
    const f = cam.featureFlags ?? {};
    if (f.isPtz) {
      const raw = await this.json<ProtectPreset[] | null>(`${PROTECT}/cameras/${encodeURIComponent(cameraId)}/ptz/preset`).catch(
        () => null,
      );
      const presets = presetNames(raw ?? []);
      this.presets.set(cameraId, presets);
      return { canMove: true, canZoom: true, presets: presets.map((p) => p.name) };
    }
    return { canMove: false, canZoom: !!f.canOpticalZoom, presets: [] };
  }

  async ptz(cameraId: string, action: PtzAction | `preset_${string}`): Promise<void> {
    const id = encodeURIComponent(cameraId);
    if (action === 'STOP') return; // Protect moves are relative steps; nothing to stop.
    if (action.startsWith('preset_')) {
      if (!this.presets.has(cameraId)) await this.ptzInfo(cameraId);
      const name = action.slice('preset_'.length);
      const preset = this.presets.get(cameraId)?.find((p) => p.name === name);
      if (!preset) throw new Error('That preset no longer exists on the camera.');
      await this.write('POST', `${PROTECT}/cameras/${id}/ptz/goto/${preset.slot}`);
      return;
    }
    const cam = await this.camera(cameraId);
    const f = cam.featureFlags ?? {};
    const move = relativeMove(action as PtzAction);
    if (move) {
      if (!f.isPtz) return;
      await this.write('POST', `${PROTECT}/cameras/${id}/move`, {
        type: 'relative',
        payload: { ...move, panSpeed: 10, tiltSpeed: 10, scale: 0 },
      });
      return;
    }
    const dir = action === 'ZOOM_IN' ? 1 : action === 'ZOOM_OUT' ? -1 : 0;
    if (!dir) return;
    if (f.isPtz) {
      const pos = await this.json<{ steps?: { zoom?: number } }>(`${PROTECT}/cameras/${id}/ptz/position`);
      const zoomPos = nextZoom(pos.steps?.zoom ?? 0, dir, f.zoom);
      await this.write('POST', `${PROTECT}/cameras/${id}/move`, { type: 'zoom', payload: { zoomPos, zoomSpeed: 100 } });
    } else if (f.canOpticalZoom) {
      const zoomPosition = nextOpticalZoom(cam.ispSettings?.zoomPosition ?? 0, dir);
      await this.write('PATCH', `${PROTECT}/cameras/${id}`, { ispSettings: { zoomPosition } });
      cam.ispSettings = { ...cam.ispSettings, zoomPosition };
    }
  }

  dispose() {}
}

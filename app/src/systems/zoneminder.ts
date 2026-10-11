import { secrets, SECRET } from '@/state/secrets';
import { HttpSystem } from '@/systems/http-base';
import { daysOf, fileAt, formatLocalDateTime, httpMessage, mergeSpans, parseLocalDateTime, type Query } from '@/systems/http-kit';
import {
  authQuery,
  eventCacheCovers,
  eventsPath,
  frameAt,
  parseEvents,
  parseLogin,
  parseMonitors,
  ptzCaps,
  ptzCommand,
  zmsPath,
  type PtzCaps,
  type ZmAuth,
  type ZmControl,
  type ZmEvent,
  type ZmEventRow,
  type ZmLogin,
  type ZmMonitor,
  type ZmMonitorRow,
} from '@/systems/zoneminder-parse';
import type {
  Camera,
  CameraSystemAdapter,
  HealthReport,
  LiveSource,
  MediaSource,
  PlaybackSource,
  PtzAction,
  PtzInfo,
  RecordingSegment,
  ReviewItem,
  Severity,
  SystemCapabilities,
} from '@/systems/types';
import { tr } from '@/i18n';

/**
 * ZoneMinder 1.36/1.37. API: https://zoneminder.readthedocs.io/en/latest/api.html; behavior
 * matches zmNinja (the official mobile client) where the docs are thin.
 *
 * - Installs live at /zm (packages) or the web root (Docker): the API is found by trying
 *   `/zm/api` then `/api` (zmNinja's wizard does the same), and the streaming binary's path
 *   comes from the ZM_PATH_ZMS config.
 * - Auth: `host/login.json` → access token (≈2 h), appended as `token=` to API and stream
 *   URLs; re-login shortly before it expires. Older servers may hand out a legacy `auth=`.
 *   With authentication turned off nothing is appended.
 * - Live and snapshots: `nph-zms` MJPEG / single JPEG. Events: the events API; playback is
 *   the event's MP4 (`view=view_video`) when it was stored as video, else MJPEG replay.
 * - Times are server wall clock; the server's zone comes from `host/getTimeZone.json`.
 */
export class ZoneMinderAdapter extends HttpSystem implements CameraSystemAdapter {
  protected readonly label = 'ZoneMinder';
  readonly capabilities: SystemCapabilities = {
    live: true,
    snapshots: true,
    review: true,
    events: true,
    ptz: true,
    twoWayAudio: false,
    deter: false,
  };

  private api = '';
  private portal = '';
  private zms = '';
  private tz: string | undefined;
  private auth: ZmAuth | null = null;
  private loggingIn: Promise<void> | null = null;
  private mons: ZmMonitor[] | null = null;
  private ptzCache = new Map<string, PtzCaps>();
  private eventCache = new Map<string, { at: number; after: number; before: number; complete: boolean; events: ZmEvent[] }>();

  private authed(url: string): string {
    const a = this.auth ? authQuery(this.auth) : '';
    return a ? `${url}${url.includes('?') ? '&' : '?'}${a}` : url;
  }

  private async password() {
    return (await secrets.get(this.config.id, SECRET.password)) ?? '';
  }

  /** Finds the API (/zm/api or /api) and logs in. */
  private async login(): Promise<void> {
    this.loggingIn ??= (async () => {
      const pass = await this.password();
      const body = new URLSearchParams({ user: this.config.username ?? '', pass }).toString();
      const candidates = this.api ? [this.api] : ['/zm/api', '/api'];
      let lastStatus = 0;
      for (const api of candidates) {
        const res = await this.send(`${api}/host/login.json`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body,
        });
        lastStatus = res.status;
        if (res.status === 404) continue;
        if (res.status === 401) {
          throw new Error(
            this.config.username
              ? tr().systems.zoneminder.badLogin
              : tr().systems.zoneminder.needsLogin,
          );
        }
        if (!res.ok) throw new Error(httpMessage(res.status, this.label));
        let r: ZmLogin;
        try {
          r = (await res.json()) as ZmLogin;
        } catch {
          continue; // An HTML page: not the API.
        }
        this.api = api;
        this.portal = api.replace(/\/api$/, '');
        this.auth = parseLogin(r, pass, Date.now() / 1000);
        return;
      }
      throw new Error(
        lastStatus === 404
          ? tr().systems.zoneminder.notFound
          : tr().systems.http.notThisSystemShort('ZoneMinder'),
      );
    })().finally(() => {
      this.loggingIn = null;
    });
    return this.loggingIn;
  }

  private async ensureAuth(): Promise<void> {
    const a = this.auth;
    if (!a || (a.kind === 'token' && a.expiresAt - Date.now() / 1000 < 300)) await this.login();
  }

  private async get<T>(path: string, q?: Query): Promise<T> {
    await this.ensureAuth();
    let res = await this.send(this.authedPath(path, q), { headers: { Accept: 'application/json' } });
    if (res.status === 401) {
      this.auth = null;
      await this.login();
      res = await this.send(this.authedPath(path, q), { headers: { Accept: 'application/json' } });
    }
    if (!res.ok) throw new Error(httpMessage(res.status, this.label));
    try {
      return (await res.json()) as T;
    } catch {
      throw new Error(tr().systems.http.unexpectedReplyShort('ZoneMinder'));
    }
  }

  /** Path + query + auth (relative to the base URL). */
  private authedPath(path: string, q?: Query): string {
    return this.authed(this.url(path, q)).slice(this.baseUrl.length);
  }

  async connect(): Promise<void> {
    this.auth = null;
    this.api = '';
    await this.login();
    // Optional extras: an older server or a limited user may not allow these.
    const [zms, tz] = await Promise.all([
      this.get<{ config?: { Value?: string } }>(`${this.api}/configs/viewByName/ZM_PATH_ZMS.json`).catch(() => null),
      this.get<{ tz?: string }>(`${this.api}/host/getTimeZone.json`).catch(() => null),
    ]);
    let basePath = '';
    try {
      basePath = new URL(this.config.endpoint.lanUrl).pathname;
    } catch {
      basePath = '';
    }
    this.zms = zmsPath(zms?.config?.Value, basePath, this.portal);
    this.tz = tz?.tz || undefined;
    this.mons = null;
  }

  private async ready() {
    if (!this.api || !this.zms) await this.connect();
  }

  private async monitors(fresh = false): Promise<ZmMonitor[]> {
    await this.ready();
    if (!this.mons || fresh) {
      const r = await this.get<{ monitors?: ZmMonitorRow[] }>(`${this.api}/monitors.json`);
      this.mons = parseMonitors(r.monitors ?? []);
    }
    return this.mons;
  }

  async listCameras(): Promise<Camera[]> {
    const mons = await this.monitors(true);
    return mons.map((m) => ({
      key: `${this.config.id}:${m.id}`,
      systemId: this.config.id,
      id: m.id,
      name: m.name,
      enabled: m.enabled,
      zones: [],
      objects: [],
      ptz: m.ptz,
      aspect: m.width && m.height ? m.width / m.height : 16 / 9,
    }));
  }

  private scaleFor(cameraId: string, height?: number): number | undefined {
    const m = this.mons?.find((x) => x.id === cameraId);
    if (!height || !m?.height) return undefined;
    return Math.max(10, Math.min(100, Math.round((height / m.height) * 100)));
  }

  snapshot(cameraId: string, opts?: { height?: number }): MediaSource {
    if (!this.zms) return { uri: '' };
    // Keep the token fresh for the next image (snapshot() is synchronous by contract).
    if (this.auth?.kind === 'token' && this.auth.expiresAt - Date.now() / 1000 < 300) void this.login().catch(() => {});
    return {
      uri: this.authed(this.url(this.zms, { mode: 'single', monitor: cameraId, scale: this.scaleFor(cameraId, opts?.height) })),
    };
  }

  async liveStream(cameraId: string, opts?: { quality?: 'main' | 'sub' }): Promise<LiveSource> {
    await this.ready();
    await this.ensureAuth();
    return {
      kind: 'mjpeg',
      uri: this.authed(
        this.url(this.zms, {
          mode: 'jpeg',
          monitor: cameraId,
          scale: opts?.quality === 'sub' ? 50 : 100,
          maxfps: opts?.quality === 'sub' ? 5 : 15,
          buffer: 1000,
          connkey: Math.floor(Math.random() * 1e6),
        }),
      ),
    };
  }

  /**
   * Events overlapping [after, before], newest first, up to `limit` per page and `maxPages`
   * pages. A cached answer is reused only if it really covers the range (an earlier query cut
   * at a smaller limit doesn't).
   */
  private async events(cameraId: string | undefined, after: number, before: number, limit: number, maxPages = 1): Promise<ZmEvent[]> {
    await this.ready();
    const key = cameraId ?? '*';
    const hit = this.eventCache.get(key);
    if (hit && Date.now() - hit.at < 20_000 && eventCacheCovers(hit, after, before)) return hit.events;
    const parse = (rows: ZmEventRow[] | undefined) => parseEvents(rows ?? [], (s) => parseLocalDateTime(s, this.tz));
    const path = eventsPath(this.api, {
      monitorId: cameraId,
      after: formatLocalDateTime(after, this.tz),
      before: formatLocalDateTime(before, this.tz),
    });
    const events: ZmEvent[] = [];
    let complete = false;
    for (let page = 1; page <= maxPages; page++) {
      // Always send page+limit: 1.37 returns everything (unsorted) without them.
      const r = await this.get<{ events?: ZmEventRow[]; pagination?: { pageCount?: number | string } }>(path, {
        sort: 'StartTime',
        direction: 'desc',
        limit,
        page,
      });
      const rows = r.events ?? [];
      events.push(...parse(rows));
      const pageCount = Number(r.pagination?.pageCount) || 0;
      if (rows.length < limit || (pageCount > 0 && page >= pageCount)) {
        complete = true;
        break;
      }
    }
    // Events still recording have no EndTime, so the query above can't match them: when the
    // window reaches the last couple of hours, also ask for recently started events.
    const now = Date.now() / 1000;
    if (before >= now - 7200) {
      const recent = eventsPath(this.api, {
        monitorId: cameraId,
        after: formatLocalDateTime(Math.max(after - 7200, now - 7200), this.tz),
        before: formatLocalDateTime(before, this.tz),
        startedAfter: true,
      });
      const r = await this.get<{ events?: ZmEventRow[] }>(recent, { sort: 'StartTime', direction: 'desc', limit, page: 1 }).catch(() => null);
      const seen = new Set(events.map((e) => e.id));
      const ongoing = parse(r?.events).filter((e) => e.end == null && !seen.has(e.id));
      events.push(...ongoing);
      events.sort((a, b) => b.start - a.start);
    }
    this.eventCache.set(key, { at: Date.now(), after, before, complete, events });
    return events;
  }

  async listReview(q: { cameras?: string[]; after?: number; before?: number; severity?: Severity; limit?: number }): Promise<ReviewItem[]> {
    const after = q.after ?? Date.now() / 1000 - 86400;
    const before = q.before ?? Date.now() / 1000 + 60;
    const limit = Math.min(q.limit ?? 100, 500);
    const lists =
      q.cameras?.length === 1
        ? [await this.events(q.cameras[0], after, before, limit)]
        : [await this.events(undefined, after, before, limit)];
    const items = lists
      .flat()
      .filter((e) => !q.cameras?.length || q.cameras.includes(e.cameraId))
      .map<ReviewItem>((e) => ({
        id: e.id,
        systemId: this.config.id,
        cameraId: e.cameraId,
        startTime: e.start,
        endTime: e.end,
        // Object detection (zmeventnotification) marks real alerts; plain motion is a detection.
        severity: e.objects.length ? 'alert' : 'detection',
        objects: e.objects,
        subLabels: [],
        zones: [],
        reviewed: false,
        thumbnailUrl: this.authed(this.url(`${this.portal}/index.php`, { view: 'image', eid: e.id, fid: 'snapshot', width: 480 })),
      }))
      .filter((i) => !q.severity || i.severity === q.severity)
      .sort((a, b) => b.startTime - a.startTime);
    return items.slice(0, q.limit ?? 100);
  }

  async recordingSegments(cameraId: string, after: number, before: number): Promise<RecordingSegment[]> {
    const evs = await this.events(cameraId, after, before, 500, 10);
    const now = Date.now() / 1000;
    return mergeSpans(evs.map((e) => ({ start: e.start, end: e.end ?? now })), 2);
  }

  async recordingDays(cameraId: string): Promise<string[]> {
    const now = Date.now() / 1000;
    const evs = await this.events(cameraId, now - 31 * 86400, now + 60, 500, 10);
    return daysOf(evs.map((e) => ({ start: e.start, end: e.end ?? now })));
  }

  async playback(cameraId: string, start: number, end: number): Promise<PlaybackSource> {
    const now = Date.now() / 1000;
    const evs = (await this.events(cameraId, start - 3600, end, 500)).map((e) => ({ ...e, end: e.end ?? now }));
    const e = fileAt(evs, start, end);
    if (!e) throw new Error(tr().systems.common.noRecording);
    await this.ensureAuth();
    if (e.video) {
      // Stored as video (H.264 passthrough): an MP4 with range support (views/view_video.php).
      return {
        kind: 'stream',
        source: { kind: 'file', uri: this.authed(this.url(`${this.portal}/index.php`, { view: 'view_video', eid: e.id })), startTime: e.start },
      };
    }
    // JPEG-stored events replay as MJPEG from the right frame.
    return {
      kind: 'stream',
      startTime: Math.max(start, e.start),
      source: {
        kind: 'mjpeg',
        uri: this.authed(
          this.url(this.zms, {
            mode: 'jpeg',
            source: 'event',
            event: e.id,
            frame: frameAt(e, start - e.start),
            replay: 'none',
            rate: 100,
            connkey: Math.floor(Math.random() * 1e6),
          }),
        ),
      },
    };
  }

  async health(): Promise<HealthReport> {
    const mons = await this.monitors(true);
    // ZoneMinder's API reports no free disk space (getDiskPercent returns GB used per monitor).
    return { offline: mons.filter((m) => m.offline).map((m) => m.id), storage: [] };
  }

  private async caps(cameraId: string): Promise<PtzCaps> {
    const hit = this.ptzCache.get(cameraId);
    if (hit) return hit;
    const m = (await this.monitors()).find((x) => x.id === cameraId);
    let failed = false;
    const control = m?.controlId
      ? await this.get<{ control?: { Control?: ZmControl } }>(`${this.api}/controls/${encodeURIComponent(m.controlId)}.json`).catch(() => {
          failed = true;
          return null;
        })
      : null;
    const caps = ptzCaps(control?.control?.Control);
    // A failed lookup (timeout, busy server) isn't remembered as "can't move"; it's asked again next time.
    if (!failed) this.ptzCache.set(cameraId, caps);
    return caps;
  }

  async ptzInfo(cameraId: string): Promise<PtzInfo> {
    const c = await this.caps(cameraId);
    return { presets: c.presets, canMove: c.canMove, canZoom: c.canZoom };
  }

  /** `POST index.php view=request&request=control` (zmNinja MonitorModalCtrl). */
  async ptz(cameraId: string, action: PtzAction | `preset_${string}`): Promise<void> {
    const control = ptzCommand(await this.caps(cameraId), action);
    if (!control) return;
    await this.ensureAuth();
    const form = new URLSearchParams({ view: 'request', request: 'control', id: cameraId, control });
    if (!control.startsWith('preset')) {
      form.set('xge', '30');
      form.set('yge', '30');
    }
    if (this.auth?.kind === 'token') form.set('token', this.auth.token);
    const path = this.auth?.kind === 'legacy' ? this.authedPath(`${this.portal}/index.php`) : `${this.portal}/index.php`;
    await this.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: form.toString(),
    });
  }

  dispose() {
    this.eventCache.clear();
    this.ptzCache.clear();
  }
}

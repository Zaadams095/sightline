import type {
  HealthReport,
  LiveSource,
  PlaybackSource,
  MotionPoint,
  SearchHit,
  Camera,
  CameraSystemAdapter,
  MediaSource,
  PtzAction,
  PtzInfo,
  RecordingSegment,
  ReviewItem,
  Severity,
  SystemCapabilities,
  SystemConfig,
} from '@/systems/types';
import { fetchWithTimeout } from '@/util/fetch';

/**
 * Frigate 0.14+ adapter. All requests go to `baseUrl`, which is the loopback gateway
 * (it handles login, Bearer tokens, CSRF and LAN/tunnel routing).
 * API reference: docs/FRIGATE_API.md
 */

interface FrigateCameraConfig {
  enabled?: boolean;
  friendly_name?: string | null;
  ui?: { order?: number; dashboard?: boolean };
  zones?: Record<string, { friendly_name?: string | null }>;
  objects?: { track?: string[] };
  onvif?: { host?: string };
  detect?: { width?: number; height?: number };
  live?: { streams?: Record<string, string> };
}

interface FrigateConfig {
  cameras: Record<string, FrigateCameraConfig>;
  lpr?: { known_plates?: Record<string, string[]> | null };
  camera_groups?: Record<string, { cameras: string | string[]; order?: number }>;
}

interface FrigateReview {
  id: string;
  camera: string;
  start_time: number;
  end_time: number | null;
  severity: Severity;
  thumb_path: string;
  has_been_reviewed: boolean;
  data: { objects?: string[]; zones?: string[]; sub_labels?: string[]; detections?: string[] };
}

interface FrigateRecording {
  start_time: number;
  end_time: number;
}

export class FrigateAdapter implements CameraSystemAdapter {
  readonly capabilities: SystemCapabilities = {
    live: true,
    snapshots: true,
    review: true,
    events: true,
    ptz: true,
    twoWayAudio: false,
  };

  private cfg: FrigateConfig | null = null;
  private ws: WebSocket | null = null;
  private wsReady: Promise<WebSocket> | null = null;

  constructor(
    readonly config: SystemConfig,
    private baseUrl: string,
  ) {}

  setBaseUrl(url: string) {
    if (url !== this.baseUrl) {
      this.baseUrl = url;
      this.ws?.close();
      this.ws = null;
      this.wsReady = null;
    }
  }

  private url(path: string, q?: Record<string, string | number | undefined>) {
    const params = q
      ? Object.entries(q)
          .filter(([, v]) => v !== undefined && v !== '')
          .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
          .join('&')
      : '';
    return `${this.baseUrl}${path}${params ? `?${params}` : ''}`;
  }

  private async get<T>(path: string, q?: Record<string, string | number | undefined>): Promise<T> {
    const res = await fetchWithTimeout(this.url(path, q), { headers: { Accept: 'application/json' }, credentials: 'include' });
    if (!res.ok) throw new Error(httpMessage(res.status));
    return (await res.json()) as T;
  }

  async connect(): Promise<void> {
    this.cfg = await this.get<FrigateConfig>('/api/config');
  }

  private async config_(): Promise<FrigateConfig> {
    if (!this.cfg) await this.connect();
    return this.cfg!;
  }

  async listCameras(): Promise<Camera[]> {
    const cfg = await this.config_();
    return Object.entries(cfg.cameras)
      .sort(([, a], [, b]) => (a.ui?.order ?? 0) - (b.ui?.order ?? 0))
      .map(([id, c]) => ({
        key: `${this.config.id}:${id}`,
        systemId: this.config.id,
        id,
        name: c.friendly_name || titleCase(id),
        enabled: c.enabled !== false,
        zones: Object.keys(c.zones ?? {}),
        objects: c.objects?.track ?? ['person'],
        ptz: !!c.onvif?.host,
        aspect: c.detect?.width && c.detect?.height ? c.detect.width / c.detect.height : 16 / 9,
        detectSize: c.detect?.width && c.detect?.height ? { width: c.detect.width, height: c.detect.height } : undefined,
      }));
  }

  snapshot(cameraId: string, opts?: { height?: number }): MediaSource {
    return {
      uri: this.url(`/api/${encodeURIComponent(cameraId)}/latest.webp`, {
        height: opts?.height,
        quality: 70,
      }),
    };
  }

  /** go2rtc stream name for a camera (first entry of live.streams, else the camera name). */
  async streamName(cameraId: string, quality: 'main' | 'sub' = 'main'): Promise<string> {
    const cfg = await this.config_();
    const streams = Object.values(cfg.cameras[cameraId]?.live?.streams ?? {});
    if (streams.length === 0) return cameraId;
    return quality === 'sub' && streams.length > 1 ? streams[streams.length - 1] : streams[0];
  }

  /** WebSocket URL for go2rtc MSE through Frigate's nginx; played by the live player. */
  async liveStream(cameraId: string, opts?: { quality?: 'main' | 'sub' }): Promise<LiveSource> {
    const src = await this.streamName(cameraId, opts?.quality);
    const wsBase = this.baseUrl.replace(/^http/, 'ws');
    return { kind: 'mse', wsUrl: `${wsBase}/live/mse/api/ws?src=${encodeURIComponent(src)}` };
  }

  async listReview(q: {
    cameras?: string[];
    after?: number;
    before?: number;
    severity?: Severity;
    limit?: number;
  }): Promise<ReviewItem[]> {
    const items = await this.get<FrigateReview[]>('/api/review', {
      cameras: q.cameras?.length ? q.cameras.join(',') : undefined,
      after: q.after,
      before: q.before ?? Date.now() / 1000 + 60,
      severity: q.severity,
      limit: q.limit ?? 100,
    });
    return items.map((r) => ({
      id: r.id,
      systemId: this.config.id,
      cameraId: r.camera,
      startTime: r.start_time,
      endTime: r.end_time,
      severity: r.severity,
      objects: r.data.objects ?? [],
      subLabels: (r.data.sub_labels ?? []).filter(Boolean),
      zones: r.data.zones ?? [],
      reviewed: r.has_been_reviewed,
      detections: r.data.detections ?? [],
      thumbnailUrl: r.thumb_path
        ? `${this.baseUrl}/${r.thumb_path.replace(/^\/media\/frigate\//, '')}`
        : undefined,
    }));
  }

  async markReviewed(ids: string[]): Promise<void> {
    const res = await fetch(this.url('/api/reviews/viewed'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-TOKEN': '1' },
      credentials: 'include',
      body: JSON.stringify({ ids, reviewed: true }),
    });
    if (!res.ok) throw new Error(httpMessage(res.status));
  }

  async recordingSegments(cameraId: string, after: number, before: number): Promise<RecordingSegment[]> {
    const recs = await this.get<FrigateRecording[]>(`/api/${encodeURIComponent(cameraId)}/recordings`, {
      after: Math.floor(after),
      before: Math.ceil(before),
    });
    // Merge back-to-back segments (Frigate stores ~10 s files). Keep the tolerance tiny:
    // these spans also map wall time to VOD player time, where gaps are removed.
    const spans: RecordingSegment[] = [];
    for (const r of [...recs].sort((a, b) => a.start_time - b.start_time)) {
      const last = spans[spans.length - 1];
      if (last && r.start_time - last.end <= 0.5) last.end = Math.max(last.end, r.end_time);
      else spans.push({ start: r.start_time, end: r.end_time });
    }
    return spans;
  }

  /** fMP4 HLS VOD; capped by Frigate at 2 h per playlist. */
  async playback(cameraId: string, start: number, end: number): Promise<PlaybackSource> {
    const s = Math.floor(start);
    const e = Math.min(Math.ceil(end), s + 7200);
    return { kind: 'vod', uri: `${this.baseUrl}/vod/${encodeURIComponent(cameraId)}/start/${s}/end/${e}/master.m3u8` };
  }

  clip(cameraId: string, start: number, end: number): MediaSource {
    return {
      uri: `${this.baseUrl}/api/${encodeURIComponent(cameraId)}/start/${Math.floor(start)}/end/${Math.ceil(end)}/clip.mp4`,
    };
  }

  async motionActivity(cameraId: string, after: number, before: number, scaleSec: number): Promise<MotionPoint[]> {
    const rows = await this.get<{ start_time: number; motion: number }[]>('/api/review/activity/motion', {
      cameras: cameraId,
      after: Math.floor(after),
      before: Math.ceil(before),
      scale: scaleSec,
    });
    return rows.map((r) => ({ t: r.start_time, v: r.motion }));
  }

  async recordingDays(cameraId: string): Promise<string[]> {
    const days = await this.get<Record<string, boolean>>('/api/recordings/summary', {
      cameras: cameraId,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    return Object.keys(days).filter((d) => days[d]).sort().reverse();
  }

  /** Where each detected object's feet were: its path when available, else the box bottom-center. */
  async detectionPoints(item: ReviewItem): Promise<{ x: number; y: number }[]> {
    const ids = item.detections ?? [];
    const events = await Promise.all(
      ids.slice(0, 8).map((id) =>
        this.get<{ data?: { box?: number[]; path_data?: [[number, number], number][] } }>(
          `/api/events/${encodeURIComponent(id)}`,
        ).catch(() => null),
      ),
    );
    const pts: { x: number; y: number }[] = [];
    for (const e of events) {
      const path = e?.data?.path_data ?? [];
      if (path.length) path.forEach(([[x, y]]) => pts.push({ x, y }));
      else if (e?.data?.box?.length === 4) {
        const [x, y, w, h] = e.data.box;
        pts.push({ x: x + w / 2, y: y + h });
      }
    }
    return pts;
  }

  async search(q: { query: string; type: 'description' | 'thumbnail'; cameras?: string[]; limit?: number }): Promise<SearchHit[]> {
    const res = await fetchWithTimeout(
      this.url('/api/events/search', {
        query: q.query,
        search_type: q.type,
        cameras: q.cameras?.length ? q.cameras.join(',') : undefined,
        limit: q.limit ?? 50,
        include_thumbnails: 0,
      }),
      { headers: { Accept: 'application/json' }, credentials: 'include' },
      20000,
    );
    if (res.status === 400) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      throw new Error(
        /semantic/i.test(body.message ?? '')
          ? 'Smart search needs Semantic Search turned on in Frigate (semantic_search: enabled: true).'
          : (body.message ?? 'Search failed'),
      );
    }
    if (!res.ok) throw new Error(httpMessage(res.status));
    const events = (await res.json()) as {
      id: string;
      camera: string;
      label: string;
      sub_label?: string | [string, number] | null;
      start_time: number;
      end_time: number | null;
    }[];
    return events.map((e) => ({
      eventId: e.id,
      systemId: this.config.id,
      cameraId: e.camera,
      label: e.label,
      subLabel: Array.isArray(e.sub_label) ? e.sub_label[0] : (e.sub_label ?? undefined),
      startTime: e.start_time,
      endTime: e.end_time,
      thumbnailUrl: this.url(`/api/events/${encodeURIComponent(e.id)}/thumbnail.webp`),
    }));
  }

  async groups(): Promise<{ name: string; cameraIds: string[] }[]> {
    const cfg = await this.config_();
    return Object.entries(cfg.camera_groups ?? {})
      .sort(([, a], [, b]) => (a.order ?? 0) - (b.order ?? 0))
      .map(([name, g]) => ({
        name: titleCase(name),
        // Frigate allows a comma-separated string or a list; birdseye isn't a real camera.
        cameraIds: (Array.isArray(g.cameras) ? g.cameras : g.cameras.split(','))
          .map((c) => c.trim())
          .filter((c) => c && c !== 'birdseye' && cfg.cameras[c]),
      }))
      .filter((g) => g.cameraIds.length > 0);
  }

  async knownNames(): Promise<string[]> {
    const cfg = await this.config_();
    const plates = Object.keys(cfg.lpr?.known_plates ?? {});
    const faces = await this.get<Record<string, string[]>>('/api/faces').catch(() => ({}));
    // Frigate keeps unclassified training images under "train"; it isn't a person.
    return [...new Set([...Object.keys(faces).filter((n) => n !== 'train'), ...plates])].sort();
  }

  async health(): Promise<HealthReport> {
    const [stats, cfg] = await Promise.all([
      this.get<{
        cameras?: Record<string, { camera_fps?: number }>;
        service?: { storage?: Record<string, { total?: number; used?: number; free?: number }> };
      }>('/api/stats'),
      this.config_(),
    ]);
    const offline = Object.entries(stats.cameras ?? {})
      .filter(([id, s]) => cfg.cameras[id]?.enabled !== false && (s.camera_fps ?? 0) === 0)
      .map(([id]) => id);
    const storage = Object.entries(stats.service?.storage ?? {})
      .filter(([path, s]) => path.startsWith('/media/frigate') && (s.total ?? 0) > 0)
      .map(([path, s]) => ({
        path,
        usedPct: Math.round(((s.used ?? 0) / (s.total ?? 1)) * 100),
        freeGb: Math.round(((s.free ?? 0) / 1024) * 10) / 10, // Frigate reports MB
      }));
    return { offline, storage };
  }

  async retain(eventId: string, keep: boolean): Promise<void> {
    const res = await fetchWithTimeout(this.url(`/api/events/${encodeURIComponent(eventId)}/retain`), {
      method: keep ? 'POST' : 'DELETE',
      headers: { 'X-CSRF-TOKEN': '1' },
      credentials: 'include',
    });
    if (!res.ok) throw new Error(httpMessage(res.status));
  }

  previewClip(item: ReviewItem): MediaSource {
    return { uri: this.url(`/api/review/${encodeURIComponent(item.id)}/preview`, { format: 'mp4' }) };
  }

  async ptzInfo(cameraId: string): Promise<PtzInfo> {
    const info = await this.get<{ features?: string[]; presets?: string[] }>(
      `/api/${encodeURIComponent(cameraId)}/ptz/info`,
    );
    const f = info.features ?? [];
    return {
      presets: info.presets ?? [],
      canMove: f.includes('pt') || f.includes('pt-r'),
      canZoom: f.includes('zoom') || f.includes('zoom-r'),
    };
  }

  /** PTZ is WebSocket-only in Frigate. Moves are continuous until STOP is sent. */
  async ptz(cameraId: string, action: PtzAction | `preset_${string}`): Promise<void> {
    const ws = await this.socket();
    ws.send(JSON.stringify({ topic: `${cameraId}/ptz`, payload: action, retain: false }));
  }

  private socket(): Promise<WebSocket> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve(this.ws);
    this.wsReady ??= new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`${this.baseUrl.replace(/^http/, 'ws')}/ws`);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('Timed out connecting to Frigate'));
      }, 8000);
      ws.onopen = () => {
        clearTimeout(timer);
        ws.send(JSON.stringify({ topic: 'onConnect', message: '', retain: false }));
        this.ws = ws;
        resolve(ws);
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error('Could not connect to Frigate'));
      };
      ws.onclose = () => {
        if (this.ws === ws) this.ws = null;
        this.wsReady = null;
      };
    }).catch((e) => {
      this.wsReady = null;
      throw e;
    });
    return this.wsReady;
  }

  dispose() {
    this.ws?.close();
    this.ws = null;
  }
}

function titleCase(s: string) {
  return s.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function httpMessage(status: number): string {
  switch (status) {
    case 401:
      return 'Frigate rejected the login. Check your username and password.';
    case 403:
      return 'This Frigate user does not have access.';
    case 404:
      return 'Not found on this Frigate server.';
    case 502:
      return 'Could not reach Frigate.';
    default:
      return `Frigate returned HTTP ${status}`;
  }
}

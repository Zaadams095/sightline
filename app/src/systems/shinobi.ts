import { secrets, SECRET } from '@/state/secrets';
import { HttpSystem } from '@/systems/http-base';
import { daysOf, fileAt, formatLocalDateTime, mergeSpans, parseLocalDateTime } from '@/systems/http-kit';
import {
  authFailure,
  groupEvents,
  livePath,
  parseMonitors,
  parseVideos,
  PTZ_DIRECTION,
  type ShinobiCamera,
  type ShinobiEvent,
  type ShinobiMonitor,
  type ShinobiVideo,
  type Video,
} from '@/systems/shinobi-parse';
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

/**
 * Shinobi through its API-key REST API (https://docs.shinobi.video/api): every route is
 * `/{apiKey}/<what>/{groupKey}/…`. The API key is kept in the keychain (it's the setup
 * form's secure field); the group key arrives in `extra.groupKey`.
 *
 * Live uses the monitor's configured Stream Type (HLS or MJPEG play on iPhone). Recordings
 * are MP4 files from `/videos`, events come from `/events` (merged into review items).
 */
export class ShinobiAdapter extends HttpSystem implements CameraSystemAdapter {
  protected readonly label = 'Shinobi';
  readonly capabilities: SystemCapabilities = {
    live: true,
    snapshots: true,
    review: true,
    events: true,
    ptz: true,
    twoWayAudio: false,
  };

  private apiKey = '';
  private cams: ShinobiCamera[] | null = null;
  private videoCache = new Map<string, { at: number; after: number; before: number; videos: Video[] }>();

  private get group(): string {
    return (this.config.extra?.groupKey ?? '').trim();
  }

  private async key(): Promise<string> {
    if (!this.apiKey) this.apiKey = ((await secrets.get(this.config.id, SECRET.password)) ?? '').trim();
    if (!this.apiKey || !this.group) {
      throw new Error('Shinobi needs both an API key and a group key. Edit this system and add them.');
    }
    return this.apiKey;
  }

  private async path(what: string, ...rest: string[]): Promise<string> {
    const key = await this.key();
    return ['', key, what, this.group, ...rest].map((s, i) => (i === 0 ? s : encodeURIComponent(s))).join('/');
  }

  private async api<T>(what: string, rest: string[] = [], q?: Record<string, string | number | undefined>): Promise<T> {
    const body = await this.json<T>(await this.path(what, ...rest), {}, q);
    const fail = authFailure(body);
    if (fail) {
      throw new Error(
        /authori/i.test(fail)
          ? 'Shinobi didn’t accept the API key and group key. Check both, and that the key’s “Allowed IPs” includes this phone’s address.'
          : `Shinobi said: ${fail}`,
      );
    }
    return body;
  }

  async connect(): Promise<void> {
    this.apiKey = '';
    const list = await this.api<ShinobiMonitor[] | unknown>('monitor');
    if (!Array.isArray(list)) throw new Error('That address answered, but it doesn’t look like Shinobi. Check the address and port (usually 8080).');
    this.cams = parseMonitors(list);
  }

  private async cameras(fresh = false): Promise<ShinobiCamera[]> {
    if (!this.cams || fresh) {
      const list = await this.api<ShinobiMonitor[]>('monitor');
      this.cams = parseMonitors(Array.isArray(list) ? list : []);
    }
    return this.cams;
  }

  async listCameras(): Promise<Camera[]> {
    const cams = await this.cameras(true);
    return cams.map((c) => ({
      key: `${this.config.id}:${c.id}`,
      systemId: this.config.id,
      id: c.id,
      name: c.name,
      enabled: c.enabled,
      zones: [],
      objects: [],
      ptz: c.ptz,
      aspect: c.aspect,
    }));
  }

  snapshot(cameraId: string): MediaSource {
    // Sync by contract: the key is loaded once cameras have been listed.
    if (!this.apiKey) return { uri: '' };
    return {
      uri: this.url(`/${encodeURIComponent(this.apiKey)}/jpeg/${encodeURIComponent(this.group)}/${encodeURIComponent(cameraId)}/s.jpg`),
    };
  }

  async liveStream(cameraId: string): Promise<LiveSource> {
    const key = await this.key();
    const cam = (await this.cameras()).find((c) => c.id === cameraId);
    if (!cam) throw new Error('Camera not found in Shinobi.');
    const live = livePath(key, this.group, cameraId, cam.streamType);
    if (!live) {
      throw new Error(
        `This camera streams as “${cam.streamType.toUpperCase()}”, which iPhone can’t play. In Shinobi, open the camera’s settings → Stream → Stream Type, choose HLS, and save.`,
      );
    }
    return live.kind === 'hls' ? { kind: 'hls', uri: this.url(live.path) } : { kind: 'mjpeg', uri: this.url(live.path) };
  }

  /** Shinobi's `start`/`end` filters are server wall-clock times (libs/database/utils.js). */
  private range(after: number, before: number) {
    return { start: formatLocalDateTime(after, undefined, 'T'), end: formatLocalDateTime(before, undefined, 'T') };
  }

  async listReview(q: { cameras?: string[]; after?: number; before?: number; severity?: Severity; limit?: number }): Promise<ReviewItem[]> {
    const after = q.after ?? Date.now() / 1000 - 86400;
    const before = q.before ?? Date.now() / 1000 + 60;
    const ids = q.cameras?.length ? q.cameras : (await this.cameras()).map((c) => c.id);
    const rows = await Promise.all(
      ids.map((mid) =>
        this.api<{ events?: ShinobiEvent[] }>('events', [mid], { ...this.range(after, before), limit: 1000 })
          .then((b) => b.events ?? [])
          .catch(() => [] as ShinobiEvent[]),
      ),
    );
    const items = groupEvents(rows.flat(), (s) => parseLocalDateTime(s))
      .map<ReviewItem>((g) => ({
        id: `${g.cameraId}|${Math.floor(g.start)}`,
        systemId: this.config.id,
        cameraId: g.cameraId,
        startTime: g.start,
        endTime: g.end,
        severity: g.motionOnly ? 'detection' : 'alert',
        objects: g.objects,
        subLabels: [],
        zones: [],
        reviewed: false,
      }))
      .filter((i) => !q.severity || i.severity === q.severity);
    return items.slice(0, q.limit ?? 100);
  }

  private async videos(cameraId: string, after: number, before: number): Promise<Video[]> {
    const hit = this.videoCache.get(cameraId);
    if (hit && Date.now() - hit.at < 30_000 && hit.after <= after && hit.before >= before) return hit.videos;
    const body = await this.api<{ videos?: ShinobiVideo[] }>('videos', [cameraId], { ...this.range(after, before), limit: 2000 });
    const videos = parseVideos(body, (s) => parseLocalDateTime(s));
    this.videoCache.set(cameraId, { at: Date.now(), after, before, videos });
    return videos;
  }

  async recordingSegments(cameraId: string, after: number, before: number): Promise<RecordingSegment[]> {
    // Files start before the window too; look back one file length (Shinobi defaults to 15 min).
    const vids = await this.videos(cameraId, after - 3600, before);
    return mergeSpans(vids.filter((v) => v.end >= after && v.start <= before), 2);
  }

  async recordingDays(cameraId: string): Promise<string[]> {
    const now = Date.now() / 1000;
    return daysOf(await this.videos(cameraId, now - 31 * 86400, now + 60));
  }

  async playback(cameraId: string, start: number, end: number): Promise<PlaybackSource> {
    const v = fileAt(await this.videos(cameraId, start - 3600, end), start, end);
    if (!v) throw new Error('No recording at this time.');
    if (v.ext === 'webm') {
      throw new Error('This recording is saved as WebM, which iPhone can’t play. In Shinobi, set the camera’s Recording → Video Codec to copy or H.264 (MP4).');
    }
    return { kind: 'stream', source: { kind: 'file', uri: this.url(v.href.replace(/^https?:\/\/[^/]+/, '')), startTime: v.start } };
  }

  async health(): Promise<HealthReport> {
    // Shinobi has no REST endpoint for disk usage; report cameras that should run but don't.
    const cams = await this.cameras(true);
    return { offline: cams.filter((c) => c.failed).map((c) => c.id), storage: [] };
  }

  async ptzInfo(): Promise<PtzInfo> {
    // Shinobi exposes no preset list over REST (presets need ONVIF passthrough).
    return { presets: [], canMove: true, canZoom: true };
  }

  async ptz(cameraId: string, action: PtzAction | `preset_${string}`): Promise<void> {
    const dir = PTZ_DIRECTION[action as PtzAction];
    if (!dir) return;
    await this.api('control', [cameraId, dir]);
  }

  dispose() {
    this.videoCache.clear();
  }
}

import { secrets, SECRET } from '@/state/secrets';
import {
  parseEvents,
  parseObjects,
  parseStorage,
  PTZ_DIR,
  recordingId,
  thumbName,
  type AgentCamera,
  type AgentEvent,
  type AgentObject,
  type AgentRecording,
} from '@/systems/agent-dvr-parse';
import { HttpSystem } from '@/systems/http-base';
import { basicAuth, daysOf, fileAt, mergeSpans } from '@/systems/http-kit';
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
 * Agent DVR (iSpy). Local HTTP API on port 8090; reference: the official Swagger spec at
 * https://ispysoftware.github.io/Agent_API/swagger.yaml, plus agent-py (Home Assistant).
 *
 * - Auth: none by default. "Protect API" (Server settings) turns on HTTP Basic; the gateway
 *   answers the challenge for media URLs and JSON calls also send the header up front.
 * - Live: MJPEG `/video.mjpg?oid=` (Agent has no HLS; its own UI uses WebRTC, which isn't
 *   a public API).
 * - Recordings: `/q/getEvents?oid=&ot=2` lists files (newest first, 400 per page) with AI
 *   tags; each plays via `/streamFile.cgi?oid=&ot=2&fn=`. Only MP4 recordings play on iPhone.
 */
export class AgentDvrAdapter extends HttpSystem implements CameraSystemAdapter {
  protected readonly label = 'Agent DVR';
  readonly capabilities: SystemCapabilities = {
    live: true,
    snapshots: true,
    review: true,
    events: true,
    ptz: true,
    twoWayAudio: false,
  };

  private cams: AgentCamera[] | null = null;
  private events = new Map<string, { at: number; recs: AgentRecording[]; complete: boolean }>();
  private auth: string | null = null;

  private async headers(): Promise<Record<string, string>> {
    if (this.auth == null) {
      const pass = this.config.username ? ((await secrets.get(this.config.id, SECRET.password)) ?? '') : '';
      this.auth = this.config.username ? basicAuth(this.config.username, pass) : '';
    }
    return this.auth ? { Authorization: this.auth } : {};
  }

  private async api<T>(path: string, q?: Record<string, string | number | undefined>): Promise<T> {
    const body = await this.json<T & { error?: string }>(path, { headers: await this.headers() }, q);
    // Agent reports some failures as HTTP 200 with an `error` key (agent-py treats it as an error).
    if (body && typeof body === 'object' && !Array.isArray(body) && typeof body.error === 'string') {
      throw new Error(`Agent DVR couldn’t do that (${body.error}).`);
    }
    return body;
  }

  async connect(): Promise<void> {
    const status = await this.api<{ version?: string; unique?: string }>('/command/getStatus');
    if (!status || (status.version == null && status.unique == null)) {
      throw new Error('That address answered, but it doesn’t look like Agent DVR. Check the address and port (usually 8090).');
    }
    this.cams = null;
  }

  private async cameras(): Promise<AgentCamera[]> {
    if (!this.cams) {
      this.cams = parseObjects(await this.api<{ objectList?: AgentObject[] }>('/command/getObjects'));
    }
    return this.cams;
  }

  async listCameras(): Promise<Camera[]> {
    this.cams = null;
    const cams = await this.cameras();
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

  snapshot(cameraId: string, opts?: { height?: number }): MediaSource {
    const h = opts?.height;
    return {
      uri: this.url('/grab.jpg', {
        oid: cameraId,
        size: h ? `${Math.round((h * 16) / 9)}x${h}` : undefined,
        maintainAR: h ? 'true' : undefined,
      }),
    };
  }

  async liveStream(cameraId: string, opts?: { quality?: 'main' | 'sub' }): Promise<LiveSource> {
    this.requireBase();
    return {
      kind: 'mjpeg',
      uri: this.url('/video.mjpg', { oid: cameraId, size: opts?.quality === 'sub' ? '640x360' : undefined }),
    };
  }

  /** Recordings for one camera covering [after, before], paging back with `enddate` (spec). */
  private async recordings(cameraId: string, after: number): Promise<AgentRecording[]> {
    const cached = this.events.get(cameraId);
    if (cached && Date.now() - cached.at < 30_000 && (cached.complete || (cached.recs.at(-1)?.start ?? Infinity) <= after)) {
      return cached.recs;
    }
    const all: AgentRecording[] = [];
    let enddate: string | undefined;
    let complete = false;
    for (let page = 0; page < 10; page++) {
      const raw = await this.api<{ events?: AgentEvent[] }>('/q/getEvents', { oid: cameraId, ot: 2, enddate });
      const list = Array.isArray(raw) ? (raw as AgentEvent[]) : (raw.events ?? []);
      const recs = parseEvents(cameraId, list);
      all.push(...recs);
      const last = list.at(-1);
      // Fewer than a full page (400) means we've reached the oldest recording.
      if (list.length < 400 || last?.c == null) {
        complete = true;
        break;
      }
      if (recs.length && Math.min(...recs.map((r) => r.start)) <= after) break;
      enddate = String(last.c);
    }
    all.sort((a, b) => b.start - a.start);
    this.events.set(cameraId, { at: Date.now(), recs: all, complete });
    return all;
  }

  async listReview(q: { cameras?: string[]; after?: number; before?: number; severity?: Severity; limit?: number }): Promise<ReviewItem[]> {
    const ids = q.cameras?.length ? q.cameras : (await this.cameras()).map((c) => c.id);
    const after = q.after ?? Date.now() / 1000 - 86400;
    const before = q.before ?? Infinity;
    const results = await Promise.allSettled(ids.map((id) => this.recordings(id, after)));
    // One camera failing shouldn't hide the others, but if all fail, say why instead of "no events".
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed && results.every((r) => r.status === 'rejected')) throw failed.reason;
    const items = results
      .flatMap((r) => (r.status === 'fulfilled' ? r.value : ([] as AgentRecording[])))
      .filter((r) => r.end >= after && r.start <= before)
      .map<ReviewItem>((r) => ({
        id: recordingId(r.cameraId, r.fn),
        systemId: this.config.id,
        cameraId: r.cameraId,
        startTime: r.start,
        endTime: r.end,
        // Tagged recordings (AI found a person, car…) are alerts; plain motion is a detection.
        severity: r.labels.length ? 'alert' : 'detection',
        objects: r.labels,
        subLabels: [],
        zones: [],
        reviewed: false,
        thumbnailUrl: this.url('/fileThumb.jpg', { oid: r.cameraId, fn: thumbName(r.fn) }),
      }))
      .filter((i) => !q.severity || i.severity === q.severity)
      .sort((a, b) => b.startTime - a.startTime);
    return items.slice(0, q.limit ?? 100);
  }

  async recordingSegments(cameraId: string, after: number, before: number): Promise<RecordingSegment[]> {
    const recs = await this.recordings(cameraId, after);
    return mergeSpans(recs.filter((r) => r.end >= after && r.start <= before));
  }

  async recordingDays(cameraId: string): Promise<string[]> {
    return daysOf(await this.recordings(cameraId, 0));
  }

  async playback(cameraId: string, start: number, end: number): Promise<PlaybackSource> {
    const rec = fileAt(await this.recordings(cameraId, start - 3600), start, end);
    if (!rec) throw new Error('No recording at this time.');
    return { kind: 'stream', source: { kind: 'file', uri: this.fileUrl(cameraId, rec.fn), startTime: rec.start } };
  }

  previewClip(item: ReviewItem): MediaSource {
    const fn = item.id.slice(item.id.indexOf('|') + 1);
    return { uri: this.fileUrl(item.cameraId, fn) };
  }

  private fileUrl(cameraId: string, fn: string) {
    return this.url('/streamFile.cgi', { oid: cameraId, ot: 2, fn });
  }

  async health(): Promise<HealthReport> {
    const [stats, cams] = await Promise.all([
      this.api<{ disks?: { n?: string; d?: string; u?: string; p?: number }[] }>('/command/getSystemStats'),
      (async () => {
        this.cams = null;
        return this.cameras();
      })(),
    ]);
    return { offline: cams.filter((c) => c.enabled && !c.connected).map((c) => c.id), storage: parseStorage(stats) };
  }

  async ptzInfo(cameraId: string): Promise<PtzInfo> {
    // Presets endpoint exists from Agent 7.7.8; older versions just have no presets.
    const res = await this.api<{ presets?: { name?: string }[] }>('/command/ptzpresets', { oid: cameraId, ot: 2 }).catch(() => null);
    return {
      presets: (res?.presets ?? []).map((p) => p.name ?? '').filter(Boolean),
      canMove: true,
      canZoom: true,
    };
  }

  async ptz(cameraId: string, action: PtzAction | `preset_${string}`): Promise<void> {
    if (action.startsWith('preset_')) {
      await this.api('/command/ptzpreset', { oid: cameraId, ot: 2, preset: action.slice('preset_'.length) });
      return;
    }
    // Moves continue until dir=11 (stop), which the pad sends on release.
    await this.request('/ptz.cgi', { headers: await this.headers() }, { oid: cameraId, dir: PTZ_DIR[action as PtzAction] });
  }

  dispose() {
    this.events.clear();
  }
}

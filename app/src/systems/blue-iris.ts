import * as Crypto from 'expo-crypto';

import { secrets, SECRET } from '@/state/secrets';
import {
  failReason,
  loginChallenge,
  parseAlerts,
  parseCamList,
  parseClips,
  parseDisks,
  PTZ_BUTTON,
  PTZ_HOME,
  type Alert,
  type BiAlert,
  type BiCamEntry,
  type BiCamera,
  type BiClip,
  type BiReply,
  type Clip,
} from '@/systems/blue-iris-parse';
import { HttpSystem } from '@/systems/http-base';
import { daysOf, fileAt, mergeSpans } from '@/systems/http-kit';
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
 * Blue Iris 5/6 through its JSON interface (`POST /json`) and web server.
 * References: Blue Iris help, "JSON interface" and "HTTP interface"
 * (https://blueirissoftware.com/blueiris.pdf); UI3 (github.com/bp2008/ui3).
 *
 * - Login is a two-step challenge: `login` → session key; `login` again with
 *   md5("user:session:password"). Media URLs carry `session=` (UI3 does the same when it
 *   can't rely on the cookie), so no cookies are needed.
 * - Live: Blue Iris' virtual HLS playlist `/h264/{cam}/temp.m3u8` ("plays on iPhone").
 * - Recordings: `cliplist`/`alertlist`; a clip plays from an offset as MJPEG via
 *   `/file/clips/{@rec.bvr}?mode=mjpeg&speed=100&time=<ms>` (no HLS for recordings exists).
 */
export class BlueIrisAdapter extends HttpSystem implements CameraSystemAdapter {
  protected readonly label = 'Blue Iris';
  readonly capabilities: SystemCapabilities = {
    live: true,
    snapshots: true,
    review: true,
    events: true,
    ptz: true,
    twoWayAudio: false,
  };

  private session = '';
  private loggingIn: Promise<string> | null = null;
  private cams: BiCamera[] | null = null;
  private clipCache = new Map<string, { at: number; after: number; before: number; clips: Clip[] }>();

  private async login(): Promise<string> {
    this.loggingIn ??= (async () => {
      const user = this.config.username ?? '';
      const pass = (await secrets.get(this.config.id, SECRET.password)) ?? '';
      const first = await this.post<BiReply>({ cmd: 'login' });
      if (!first.session) throw new Error('That address answered, but it doesn’t look like the Blue Iris web server. Check the address and port (often 81).');
      // Anonymous access (no username) answers with "Anonymous" and an empty password (UI3).
      const response = await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.MD5,
        loginChallenge(user || 'Anonymous', first.session, user ? pass : ''),
      );
      const second = await this.post<BiReply>({ cmd: 'login', session: first.session, response: response.toLowerCase() });
      if (second.result !== 'success') {
        const why = failReason(second);
        throw new Error(why === 'session' ? 'Blue Iris refused the login. Try again.' : why);
      }
      this.session = second.session ?? first.session;
      return this.session;
    })().finally(() => {
      this.loggingIn = null;
    });
    return this.loggingIn;
  }

  private async post<T>(body: Record<string, unknown>): Promise<T> {
    return this.json<T>('/json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  /** A command with the session; logs in (again) when the session is missing or expired. */
  private async cmd<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
    if (!this.session) await this.login();
    const used = this.session;
    let r = await this.post<BiReply<T>>({ cmd, session: used, ...args });
    if (r.result === 'fail') {
      // BI 5.8.1+ says "Invalid session"; older versions just fail. Re-login once, like HA does,
      // unless another request already did (a burst of failures must not open a session each).
      if (this.loggingIn) await this.loggingIn;
      else if (this.session === used) await this.login();
      r = await this.post<BiReply<T>>({ cmd, session: this.session, ...args });
      if (r.result === 'fail') {
        const why = failReason(r);
        throw new Error(why === 'session' ? 'Blue Iris ended the session. Try again.' : why);
      }
    }
    return r.data as T;
  }

  async connect(): Promise<void> {
    // Sign in afresh and close the session being replaced, so it doesn't linger on the server.
    const old = this.session;
    this.session = '';
    await this.login();
    if (old && old !== this.session) void this.post({ cmd: 'logout', session: old }).catch(() => {});
    this.cams = null;
  }

  private async cameras(fresh = false): Promise<BiCamera[]> {
    if (!this.cams || fresh) this.cams = parseCamList(await this.cmd<BiCamEntry[]>('camlist'));
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

  private media(path: string, q: Record<string, string | number | undefined> = {}) {
    return this.url(path, { ...q, session: this.session || undefined });
  }

  snapshot(cameraId: string, opts?: { height?: number }): MediaSource {
    return { uri: this.media(`/image/${encodeURIComponent(cameraId)}`, { h: opts?.height, q: 70 }) };
  }

  async liveStream(cameraId: string): Promise<LiveSource> {
    if (!this.session) await this.login();
    return { kind: 'hls', uri: this.media(`/h264/${encodeURIComponent(cameraId)}/temp.m3u8`) };
  }

  private async alerts(cameras: string[] | undefined, after: number, before: number): Promise<Alert[]> {
    const camera = cameras?.length === 1 ? cameras[0] : 'index';
    const list = parseAlerts(
      await this.cmd<BiAlert[]>('alertlist', { camera, startdate: Math.floor(after), enddate: Math.ceil(before) }),
    );
    return cameras?.length ? list.filter((a) => cameras.includes(a.cameraId)) : list;
  }

  async listReview(q: { cameras?: string[]; after?: number; before?: number; severity?: Severity; limit?: number }): Promise<ReviewItem[]> {
    const after = q.after ?? Date.now() / 1000 - 86400;
    const before = q.before ?? Date.now() / 1000 + 60;
    const items = (await this.alerts(q.cameras, after, before))
      // AI-cancelled alerts ("nothing found") aren't worth showing.
      .filter((a) => !a.cancelled)
      .map<ReviewItem>((a) => ({
        id: a.id,
        systemId: this.config.id,
        cameraId: a.cameraId,
        startTime: a.start,
        endTime: a.end,
        severity: a.confirmed ? 'alert' : 'detection',
        objects: a.objects,
        subLabels: [],
        zones: a.zones,
        reviewed: false,
        thumbnailUrl: this.media(`/thumbs/${encodeURIComponent(a.thumb)}`),
      }))
      .filter((i) => !q.severity || i.severity === q.severity)
      .sort((a, b) => b.startTime - a.startTime);
    return items.slice(0, q.limit ?? 100);
  }

  private async clips(cameraId: string, after: number, before: number): Promise<Clip[]> {
    const hit = this.clipCache.get(cameraId);
    if (hit && Date.now() - hit.at < 30_000 && hit.after <= after && hit.before >= before) return hit.clips;
    const clips = parseClips(
      await this.cmd<BiClip[]>('cliplist', { camera: cameraId, startdate: Math.floor(after), enddate: Math.ceil(before) }),
    );
    this.clipCache.set(cameraId, { at: Date.now(), after, before, clips });
    return clips;
  }

  async recordingSegments(cameraId: string, after: number, before: number): Promise<RecordingSegment[]> {
    return mergeSpans((await this.clips(cameraId, after - 6 * 3600, before)).filter((c) => c.end >= after && c.start <= before));
  }

  async recordingDays(cameraId: string): Promise<string[]> {
    const now = Date.now() / 1000;
    return daysOf(await this.clips(cameraId, now - 31 * 86400, now + 60));
  }

  /**
   * Plays the clip covering `start` from the right offset. Blue Iris has no HLS for
   * recordings, so this is its MJPEG clip stream (video only).
   */
  async playback(cameraId: string, start: number, end: number): Promise<PlaybackSource> {
    // BI clips can be hours long; look back far enough to find the one that covers `start`.
    const clip = fileAt(await this.clips(cameraId, start - 6 * 3600, end), start, end);
    if (!clip) throw new Error('No recording at this time.');
    if (!this.session) await this.login();
    const offsetMs = Math.max(0, Math.round((start - clip.start) * 1000));
    return {
      kind: 'stream',
      // The nearest clip may start after `start` (a gap); the clock follows the clip.
      startTime: Math.max(start, clip.start),
      source: {
        kind: 'mjpeg',
        uri: this.media(`/file/clips/${encodeURIComponent(clip.path)}`, { mode: 'mjpeg', speed: 100, time: offsetMs }),
      },
    };
  }

  async health(): Promise<HealthReport> {
    const [status, cams] = await Promise.all([
      this.cmd<Parameters<typeof parseDisks>[0]>('status'),
      this.cameras(true),
    ]);
    return { offline: cams.filter((c) => c.offline).map((c) => c.id), storage: parseDisks(status ?? {}) };
  }

  async ptzInfo(): Promise<PtzInfo> {
    return { presets: ['Home'], canMove: true, canZoom: true };
  }

  async ptz(cameraId: string, action: PtzAction | `preset_${string}`): Promise<void> {
    if (action.startsWith('preset_')) {
      await this.cmd('ptz', { camera: cameraId, button: PTZ_HOME });
      return;
    }
    const button = PTZ_BUTTON[action as PtzAction];
    // updown:1 starts a continuous move (UI3's hold-to-move); button 64 stops it.
    await this.cmd('ptz', action === 'STOP' ? { camera: cameraId, button } : { camera: cameraId, button, updown: 1 });
  }

  dispose() {
    if (this.session) void this.post({ cmd: 'logout', session: this.session }).catch(() => {});
    this.session = '';
    this.clipCache.clear();
  }
}

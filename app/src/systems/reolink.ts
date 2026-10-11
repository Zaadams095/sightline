import { useLinks } from '@/net/connection';
import { secrets, SECRET } from '@/state/secrets';
import {
  abilityVer,
  buildRtspUrl,
  clockFromDeviceNow,
  dayChunks,
  dayKey,
  defaultRtspPath,
  enableRtspBody,
  errorMessage,
  fileAt,
  filesToReview,
  isLoginExpired,
  loginBody,
  mergeSegments,
  nvrDownloadBody,
  parseChannels,
  parseDevInfo,
  parseEnc,
  parseLogin,
  parseNetPort,
  parseNvrDownload,
  parsePresets,
  parseResponse,
  parseRtspUrls,
  parseSearchFiles,
  parseSearchStatus,
  PHONE_CLOCK,
  PTZ_OPS,
  ptzBody,
  ptzSupport,
  ReolinkError,
  searchBody,
  unixToWall,
  vodFileUrl,
  type ChannelInfo,
  type DevInfo,
  type DeviceClock,
  type NetPort,
  type ReolinkItem,
  type StreamInfo,
  type VodFile,
} from '@/systems/reolink-parse';
import type {
  Camera,
  CameraSystemAdapter,
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
} from '@/systems/types';
import { fetchWithTimeout } from '@/util/fetch';
import { WgTunnel } from '@modules/wg-tunnel';

/**
 * Reolink NVRs, Home Hub and standalone cameras through the Reolink HTTP API
 * (`/cgi-bin/api.cgi`, token login). Requests go through the app's loopback gateway at
 * `baseUrl`; live video and nothing else goes straight to the device over RTSP.
 * Protocol details and sources: systems/reolink-parse.ts.
 */

interface Token {
  token: string;
  /** Unix ms after which the token is no longer valid. */
  expires: number;
}

interface ChannelExtras {
  enc?: { main: StreamInfo; sub: StreamInfo };
  rtsp?: { main?: string; sub?: string };
}

/** Renew this long before the lease runs out (reolink_aio uses 300 s too). */
const RENEW_MARGIN_MS = 5 * 60_000;
const PTZ_SPEED = 32;
const REVIEW_DAYS = 7;

export class ReolinkAdapter implements CameraSystemAdapter {
  readonly capabilities: SystemCapabilities = {
    live: !!WgTunnel,
    snapshots: true,
    review: true,
    events: true,
    ptz: true,
    twoWayAudio: false,
  };

  private tok: Token | null = null;
  private loggingIn: Promise<Token> | null = null;
  private dev: DevInfo | null = null;
  private channels: ChannelInfo[] = [];
  private ability: any = null;
  private net: NetPort | null = null;
  private clock: DeviceClock = PHONE_CLOCK;
  private extras = new Map<number, ChannelExtras>();
  private presets = new Map<number, Map<string, number>>();
  /** Last searched files per camera; clip() is synchronous and reuses them. */
  private files = new Map<string, VodFile[]>();
  private loaded: Promise<void> | null = null;

  constructor(
    readonly config: SystemConfig,
    private initialBase: string,
  ) {}

  /** Current route (LAN or VPN); the gateway port can change after the adapter is created. */
  private get base(): string {
    const b = useLinks.getState().links[this.config.id]?.baseUrl || this.initialBase;
    if (!b) throw new ReolinkError('Still connecting to the Reolink device…');
    return b.replace(/\/$/, '');
  }

  private baseOrEmpty(): string {
    try {
      return this.base;
    } catch {
      return '';
    }
  }

  // -------------------------------------------------------------------------------------------
  // Transport

  private async post(cmd: string, body: unknown, token: string, timeoutMs = 10_000): Promise<ReolinkItem[]> {
    let res: Response;
    try {
      res = await fetchWithTimeout(
        `${this.base}/cgi-bin/api.cgi?cmd=${cmd}&token=${encodeURIComponent(token)}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
        timeoutMs,
      );
    } catch (e) {
      if (e instanceof ReolinkError) throw e;
      throw new ReolinkError('Couldn’t reach the Reolink device. Check that it’s on and connected to your network.');
    }
    if (res.status === 502) throw new ReolinkError('Couldn’t reach the Reolink device. Check that it’s on and connected to your network.');
    if (res.status === 401 || res.status === 403) throw new ReolinkError('The Reolink device rejected the username or password.');
    if (res.status === 300) {
      // Login over http on a device that only allows https (reolink_aio notes this too).
      throw new ReolinkError('This Reolink device only accepts secure connections. Add it again using https:// before the address.');
    }
    return parseResponse(await res.text());
  }

  private async login(): Promise<Token> {
    const password = (await secrets.get(this.config.id, SECRET.password)) ?? '';
    const items = await this.post('Login', loginBody(this.config.username ?? 'admin', password), 'null');
    const { token, leaseSec } = parseLogin(items);
    this.tok = { token, expires: Date.now() + leaseSec * 1000 };
    return this.tok;
  }

  private token(force = false): Promise<Token> {
    if (!force && this.tok && this.tok.expires - Date.now() > RENEW_MARGIN_MS) return Promise.resolve(this.tok);
    if (force) this.tok = null;
    this.loggingIn ??= this.login().finally(() => {
      this.loggingIn = null;
    });
    return this.loggingIn;
  }

  /**
   * Sends commands in one request (the API accepts a batch) and returns one item per command.
   * Signs in again once when the device says "please login first" (rspCode -6).
   */
  private async api(cmds: { cmd: string; action?: number; param?: unknown }[], timeoutMs?: number): Promise<ReolinkItem[]> {
    const body = cmds.map((c) => ({ action: 0, param: {}, ...c }));
    let items = await this.post(cmds[0].cmd, body, (await this.token()).token, timeoutMs);
    if (items.some(isLoginExpired)) {
      items = await this.post(cmds[0].cmd, body, (await this.token(true)).token, timeoutMs);
    }
    return items;
  }

  /** One command; throws a readable error when it fails. */
  private async one(cmd: string, param: unknown = {}, action = 0): Promise<any> {
    const [item] = await this.api([{ cmd, action, param }]);
    if (!item || item.code !== 0) throw new ReolinkError(errorMessage(item), item?.error?.rspCode);
    return item.value;
  }

  // -------------------------------------------------------------------------------------------
  // Setup

  async connect(): Promise<void> {
    await this.token(true);
    this.loaded = null;
    await this.load();
  }

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      const items = await this.api([
        { cmd: 'GetDevInfo' },
        { cmd: 'GetChannelstatus' },
        { cmd: 'GetAbility', param: { User: { userName: this.config.username ?? 'admin' } } },
        { cmd: 'GetNetPort' },
        { cmd: 'GetTime' },
      ]);
      const by = (cmd: string) => items.find((i) => i.cmd === cmd && i.code === 0)?.value;
      const devItem = items.find((i) => i.cmd === 'GetDevInfo');
      if (!devItem || devItem.code !== 0) throw new ReolinkError(errorMessage(devItem), devItem?.error?.rspCode);
      this.dev = parseDevInfo(devItem.value);
      this.channels = parseChannels(this.dev, by('GetChannelstatus'));
      this.ability = by('GetAbility') ?? null;
      if (by('GetNetPort')) this.net = parseNetPort(by('GetNetPort'));
      const t = by('GetTime')?.Time;
      if (t?.year) this.clock = clockFromDeviceNow(t, Date.now(), -new Date().getTimezoneOffset());

      // Encoding (for stream paths and aspect ratio) and, on newer firmware, the exact RTSP paths.
      const chCmds = this.channels.flatMap((c) => [
        { cmd: 'GetEnc', param: { channel: c.channel } },
        { cmd: 'GetRtspUrl', param: { channel: c.channel } },
      ]);
      if (chCmds.length) {
        const res = await this.api(chCmds).catch(() => [] as ReolinkItem[]);
        this.channels.forEach((c, i) => {
          const enc = res[i * 2];
          const rtsp = res[i * 2 + 1];
          this.extras.set(c.channel, {
            enc: enc?.code === 0 ? parseEnc(enc.value) : undefined,
            rtsp: rtsp?.code === 0 ? parseRtspUrls(rtsp.value) : undefined,
          });
        });
      }
    })().catch((e) => {
      this.loaded = null;
      throw e;
    });
    return this.loaded;
  }

  async listCameras(): Promise<Camera[]> {
    await this.load();
    return this.channels.map((c) => {
      const main = this.extras.get(c.channel)?.enc?.main;
      const ptz = ptzSupport(this.ability, c.channel);
      return {
        key: `${this.config.id}:${c.channel}`,
        systemId: this.config.id,
        id: String(c.channel),
        name: c.name,
        enabled: c.online,
        zones: [],
        objects: ['person', 'vehicle', 'animal'],
        ptz: ptz.canMove || ptz.canZoom,
        aspect: main?.width && main?.height ? main.width / main.height : 16 / 9,
      };
    });
  }

  private channelOf(cameraId: string): number {
    const ch = Number(cameraId);
    if (!Number.isInteger(ch) || ch < 0) throw new ReolinkError('Camera not found on this Reolink device.');
    return ch;
  }

  // -------------------------------------------------------------------------------------------
  // Snapshots and live

  /**
   * `cmd=Snap` needs the session token in the URL. Callers re-request the URL on every refresh,
   * so a renewed token is picked up automatically; renewal starts in the background shortly
   * before the lease ends.
   */
  snapshot(cameraId: string, opts?: { height?: number }): MediaSource {
    const base = this.baseOrEmpty();
    const tok = this.tok;
    if (!tok || tok.expires - Date.now() < RENEW_MARGIN_MS) void this.token().catch(() => {});
    if (!base || !tok || tok.expires < Date.now()) return { uri: '' };
    const ch = Number(cameraId);
    let size = '';
    // Small tiles: the sub stream's frame (reolink_aio passes snapType=sub with its exact size).
    const sub = this.extras.get(ch)?.enc?.sub;
    if (opts?.height && opts.height <= 480 && sub?.width && sub?.height) {
      size = `&snapType=sub&width=${sub.width}&height=${sub.height}`;
    }
    return { uri: `${base}/cgi-bin/api.cgi?cmd=Snap&channel=${ch}&rs=sightline${size}&token=${encodeURIComponent(tok.token)}` };
  }

  /** RTSP must be on for live video. It's off by default on newer models; turn it on once. */
  private async ensureRtsp(): Promise<NetPort> {
    if (!this.net) this.net = parseNetPort(await this.one('GetNetPort'));
    if (this.net.rtspEnabled) return this.net;
    const [item] = await this.api(enableRtspBody(this.net));
    if (!item || item.code !== 0) {
      throw new ReolinkError(
        'Live video is turned off on this Reolink device. In the Reolink app, open the device’s settings → Network → Advanced → Port Settings, and turn on RTSP.',
      );
    }
    // Changing port settings ends the session (reolink_aio expires its token here too).
    this.tok = null;
    this.net = { ...this.net, rtspEnabled: true };
    return this.net;
  }

  async liveStream(cameraId: string, opts?: { quality?: 'main' | 'sub' }): Promise<LiveSource> {
    await this.load();
    const ch = this.channelOf(cameraId);
    const quality = opts?.quality ?? 'main';
    const net = await this.ensureRtsp();
    const extra = this.extras.get(ch);
    const path = extra?.rtsp?.[quality] ?? defaultRtspPath(ch, quality, extra?.enc?.[quality]?.vType);
    const password = (await secrets.get(this.config.id, SECRET.password)) ?? '';
    return {
      kind: 'rtsp',
      url: buildRtspUrl({
        host: new URL(this.config.endpoint.lanUrl).hostname,
        port: net.rtspPort,
        user: this.config.username ?? 'admin',
        password,
        path,
      }),
    };
  }

  // -------------------------------------------------------------------------------------------
  // Recordings and events

  /** Recording files of one camera in [after, before], searched day by day (device-local days). */
  private async searchFiles(ch: number, after: number, before: number, maxDays = 8): Promise<VodFile[]> {
    await this.load();
    const chunks = dayChunks(after, before, this.clock, maxDays);
    if (!chunks.length) return [];
    const items = await this.api(
      chunks.map(([from, to]) => searchBody(ch, from, to, false)),
      20_000,
    );
    const failed = items.find((i) => i.code !== 0);
    if (failed && items.every((i) => i.code !== 0)) throw new ReolinkError(errorMessage(failed), failed.error?.rspCode);
    const files = items.filter((i) => i.code === 0).flatMap((i) => parseSearchFiles(i.value, this.clock));
    const seen = new Set<number>();
    return files
      .filter((f) => f.end > after && f.start < before && !seen.has(f.start) && (seen.add(f.start), true))
      .sort((a, b) => a.start - b.start);
  }

  async recordingSegments(cameraId: string, after: number, before: number): Promise<RecordingSegment[]> {
    const files = await this.searchFiles(this.channelOf(cameraId), after, before);
    this.files.set(cameraId, files);
    return mergeSegments(files);
  }

  async recordingDays(cameraId: string): Promise<string[]> {
    await this.load();
    const ch = this.channelOf(cameraId);
    // A status search over a few minutes returns the whole month's day table (reolink_aio
    // request_vod_files with status_only). Ask for this month and the two before it.
    const now = unixToWall(Date.now() / 1000, this.clock);
    const months = [0, 1, 2].map((back) => {
      const m = new Date(Date.UTC(now.year, now.mon - 1 - back, 1));
      const from = { year: m.getUTCFullYear(), mon: m.getUTCMonth() + 1, day: 1, hour: 0, min: 0, sec: 0 };
      return searchBody(ch, from, { ...from, min: 5 }, true);
    });
    const items = await this.api(months, 20_000);
    const today = dayKey(now);
    const days = items.filter((i) => i.code === 0).flatMap((i) => parseSearchStatus(i.value));
    return [...new Set(days)].filter((d) => d <= today).sort().reverse();
  }

  /**
   * Events come from the recordings: each motion/AI-triggered file is one event, and its file
   * name says what triggered it (person, vehicle, animal, doorbell, package). Devices whose
   * search results have no file names (some NVR firmware) can't be classified and show none.
   */
  async listReview(q: { cameras?: string[]; after?: number; before?: number; severity?: Severity; limit?: number }): Promise<ReviewItem[]> {
    await this.load();
    const before = q.before ?? Date.now() / 1000;
    const after = Math.max(q.after ?? before - 86400, before - REVIEW_DAYS * 86400);
    const ids = q.cameras?.length ? q.cameras : this.channels.map((c) => String(c.channel));
    const results = await Promise.allSettled(
      ids.map(async (id) => filesToReview(await this.searchFiles(this.channelOf(id), after, before, REVIEW_DAYS + 1), this.config.id, id)),
    );
    const ok = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
    if (!ok.length) {
      const err = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (err) throw err.reason;
    }
    return ok
      .filter((r) => r.startTime >= after - 600 && r.startTime <= before && (!q.severity || r.severity === q.severity))
      .sort((a, b) => b.startTime - a.startTime)
      .slice(0, q.limit ?? 100);
  }

  /** URL for a file that streams as MP4, preparing it first on NVRs that need NvrDownload. */
  private async fileUrl(ch: number, f: VodFile): Promise<string> {
    const tok = await this.token();
    const nvr = !!this.dev?.isNvr;
    let name = f.name;
    if (nvr && !this.dev?.isHub && !(name && /\.(mp4|vref)$/i.test(name))) {
      // reolink_aio _generate_NVR_download_vod
      const [item] = await this.api(nvrDownloadBody(ch, f.startWall, f.endWall), 30_000);
      if (!item || item.code !== 0) throw new ReolinkError('The Reolink recorder couldn’t prepare this recording for playback.');
      name = parseNvrDownload(item.value) ?? undefined;
    }
    if (!name) throw new ReolinkError('The Reolink device didn’t name this recording, so it can’t be played.');
    return vodFileUrl({ base: this.base, fileName: name, startWall: f.startWall, nvr, token: tok.token });
  }

  /**
   * Reolink has no RTSP playback, and its FLV/RTMP playback isn't playable by iOS. Recordings
   * are played file by file as MP4 (the same approach as Home Assistant), so the source starts
   * at the file's beginning: `startsAt` tells the player where that is.
   */
  async playback(cameraId: string, start: number, end: number): Promise<PlaybackSource> {
    const ch = this.channelOf(cameraId);
    let files = this.files.get(cameraId) ?? [];
    let f = fileAt(files, start, end);
    if (!f) {
      files = await this.searchFiles(ch, start - 3600, Math.max(end, start + 60));
      this.files.set(cameraId, files);
      f = fileAt(files, start, end);
    }
    if (!f) throw new ReolinkError('There’s no recording at this time.');
    return { kind: 'stream', source: { kind: 'file', uri: await this.fileUrl(ch, f) }, startsAt: f.start };
  }

  /**
   * The recording file covering `start` (from the last search of this camera), as MP4. Reolink
   * can't cut clips, so the file may be longer than the range asked for. NVRs that need a
   * preparation step can't be exported this way.
   */
  clip(cameraId: string, start: number, end: number): MediaSource {
    const f = fileAt(this.files.get(cameraId) ?? [], start, end);
    const nvrNeedsPrep = !!this.dev?.isNvr && !this.dev.isHub && !(f?.name && /\.(mp4|vref)$/i.test(f.name));
    const base = this.baseOrEmpty();
    if (!f?.name || nvrNeedsPrep || !this.tok || !base) return { uri: '' };
    return { uri: vodFileUrl({ base, fileName: f.name, startWall: f.startWall, nvr: !!this.dev?.isNvr, token: this.tok.token }) };
  }

  // -------------------------------------------------------------------------------------------
  // PTZ

  async ptzInfo(cameraId: string): Promise<PtzInfo> {
    await this.load();
    const ch = this.channelOf(cameraId);
    const support = ptzSupport(this.ability, ch);
    let names: string[] = [];
    if (support.canMove && abilityVer(this.ability, ch, 'ptzPreset') > 0) {
      const map = parsePresets(await this.one('GetPtzPreset', { channel: ch }).catch(() => null));
      this.presets.set(ch, map);
      names = [...map.keys()];
    }
    return { presets: names, canMove: support.canMove, canZoom: support.canZoom };
  }

  async ptz(cameraId: string, action: PtzAction | `preset_${string}`): Promise<void> {
    const ch = this.channelOf(cameraId);
    let body;
    if (action.startsWith('preset_')) {
      const name = action.slice('preset_'.length);
      if (!this.presets.has(ch)) this.presets.set(ch, parsePresets(await this.one('GetPtzPreset', { channel: ch })));
      const id = this.presets.get(ch)!.get(name);
      if (id == null) throw new ReolinkError('That preset no longer exists on the camera.');
      body = ptzBody(ch, 'ToPos', { id, speed: PTZ_SPEED });
    } else {
      const op = PTZ_OPS[action];
      if (!op) return;
      body = ptzBody(ch, op, { speed: PTZ_SPEED });
    }
    const [item] = await this.api(body);
    if (!item || item.code !== 0) throw new ReolinkError(errorMessage(item), item?.error?.rspCode);
  }

  dispose() {
    // Free the session slot; Reolink devices allow only a few at once.
    const tok = this.tok;
    const base = this.baseOrEmpty();
    this.tok = null;
    if (tok && base) {
      void fetchWithTimeout(`${base}/cgi-bin/api.cgi?cmd=Logout&token=${encodeURIComponent(tok.token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([{ cmd: 'Logout', action: 0, param: {} }]),
      }, 3000).catch(() => {});
    }
  }
}

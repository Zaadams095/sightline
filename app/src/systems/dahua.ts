import { useLinks } from '@/net/connection';
import { secrets, SECRET } from '@/state/secrets';
import {
  dahuaHttpMessage,
  deviceOffset,
  filesToDays,
  filesToReview,
  filesToSegments,
  findFileQuery,
  isErrorBody,
  livePath,
  parseChannels,
  parseEventChannels,
  parseFindNext,
  parseFinderId,
  parseKv,
  parsePresets,
  parsePtzCaps,
  parseStorage,
  playbackPath,
  ptzCode,
  rtspUrl,
  toDeviceTime,
  type DahuaChannel,
  type DahuaFile,
} from '@/systems/dahua-format';
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
  SystemConfig,
} from '@/systems/types';
import { fetchWithTimeout } from '@/util/fetch';

/**
 * Dahua CGI adapter: Dahua recorders and cameras, and the many brands built on them (Amcrest,
 * Lorex, and other OEM models). HTTP goes through the loopback gateway at `baseUrl`, which
 * answers the device's Digest challenge; RTSP (live and playback) goes to the device directly
 * and is restreamed in-app.
 *
 * Channels are 1-based everywhere except the ChannelTitle table and file-search replies (0-based).
 * All device times are local device time; see dahua-format.ts for how they're converted.
 *
 * Not implemented: clip export. Recordings download as Dahua's own .dav format, which iPhones
 * can't play or save, so `clip` is left out rather than offering a file that won't open.
 */

const OFFSET_TTL_MS = 30 * 60_000;
/** findNextFile returns at most 100 files per call (Amcrest HTTP API §4.11.5). */
const PAGE = 100;

export class DahuaAdapter implements CameraSystemAdapter {
  readonly capabilities: SystemCapabilities = {
    live: true,
    snapshots: true,
    review: true,
    events: true,
    ptz: true,
    twoWayAudio: false,
  };

  private channels: DahuaChannel[] | null = null;
  private rtspPort = 554;
  private offset: { sec: number; at: number } | null = null;
  /** Dahua devices allow only a few open file finders; searches run one at a time. */
  private finderQueue: Promise<unknown> = Promise.resolve();
  private ptzCaps = new Map<string, { canMove: boolean; canZoom: boolean }>();
  private presets = new Map<string, { index: number; name: string }[]>();

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

  private async cgi(path: string, timeoutMs = 10_000): Promise<string> {
    const res = await fetchWithTimeout(`${this.base}/cgi-bin/${path}`, {}, timeoutMs);
    const body = await res.text();
    if (!res.ok) throw new Error(dahuaHttpMessage(res.status, body));
    return body;
  }

  private async kv(path: string): Promise<Record<string, string>> {
    return parseKv(await this.cgi(path));
  }

  async connect(): Promise<void> {
    // Proves the address and password; the reply is e.g. `type=NVR4108HS-4KS2`.
    const body = await this.cgi('magicBox.cgi?action=getDeviceType');
    if (isErrorBody(body)) throw new Error('This doesn’t look like a Dahua, Amcrest or Lorex device. Check the address.');
    const rtsp = await this.kv('configManager.cgi?action=getConfig&name=RTSP').catch(() => ({}) as Record<string, string>);
    const port = Number(rtsp['table.RTSP.Port']);
    if (port > 0) this.rtspPort = port;
    await this.loadChannels();
    await this.offsetSec(true);
  }

  private async loadChannels(): Promise<DahuaChannel[]> {
    const titles = await this.kv('configManager.cgi?action=getConfig&name=ChannelTitle');
    // Recorders only: lists which slots have a camera. Cameras answer with an error; that's fine.
    const remote = await this.kv('configManager.cgi?action=getConfig&name=RemoteDevice').catch(() => undefined);
    let channels = parseChannels(titles, remote);
    if (!channels.length) channels = [{ channel: 1, name: this.config.name || 'Camera', enabled: true }];
    this.channels = channels;
    // Which channels can pan/tilt/zoom (one cheap request each; a failure means "no").
    await Promise.all(
      channels.map(async (c) => {
        const caps = await this.kv(`ptz.cgi?action=getCurrentProtocolCaps&channel=${c.channel}`)
          .then(parsePtzCaps)
          .catch(() => ({ canMove: false, canZoom: false }));
        this.ptzCaps.set(String(c.channel), caps);
      }),
    );
    return channels;
  }

  /** Device clock offset from UTC (seconds), refreshed every 30 minutes. */
  private async offsetSec(force = false): Promise<number> {
    if (!force && this.offset && Date.now() - this.offset.at < OFFSET_TTL_MS) return this.offset.sec;
    try {
      const sent = Date.now();
      const body = await this.cgi('global.cgi?action=getCurrentTime');
      const mid = (sent + Date.now()) / 2;
      this.offset = { sec: deviceOffset(body, mid), at: Date.now() };
    } catch {
      // Fall back to "the recorder is in the phone's time zone" (true for nearly every home).
      this.offset ??= { sec: -new Date().getTimezoneOffset() * 60, at: Date.now() };
    }
    return this.offset.sec;
  }

  async listCameras(): Promise<Camera[]> {
    const channels = this.channels ?? (await this.loadChannels());
    return channels.map((c) => {
      const caps = this.ptzCaps.get(String(c.channel));
      return {
        key: `${this.config.id}:${c.channel}`,
        systemId: this.config.id,
        id: String(c.channel),
        name: c.name,
        enabled: c.enabled,
        zones: [],
        objects: ['person', 'vehicle', 'motion'],
        ptz: !!caps && (caps.canMove || caps.canZoom),
        aspect: 16 / 9,
      };
    });
  }

  snapshot(cameraId: string): MediaSource {
    return { uri: `${this.base}/cgi-bin/snapshot.cgi?channel=${encodeURIComponent(cameraId)}` };
  }

  private async rtsp(path: string): Promise<string> {
    const pass = (await secrets.get(this.config.id, SECRET.password)) ?? '';
    const host = new URL(this.config.endpoint.lanUrl).hostname;
    return rtspUrl({ host, port: this.rtspPort, user: this.config.username ?? '', pass, path });
  }

  async liveStream(cameraId: string, opts?: { quality?: 'main' | 'sub' }): Promise<LiveSource> {
    return { kind: 'rtsp', url: await this.rtsp(livePath(Number(cameraId), opts?.quality ?? 'main')) };
  }

  /** Plays from `start` (device-local RTSP playback). Seeking asks for a new window. */
  async playback(cameraId: string, start: number, end: number): Promise<PlaybackSource> {
    const off = await this.offsetSec();
    return { kind: 'stream', source: { kind: 'rtsp', url: await this.rtsp(playbackPath(Number(cameraId), start, end, off)) } };
  }

  // -------------------------------------------------------------------------------------------
  // File search: factory.create → findFile → findNextFile… → close → destroy.

  private findFiles(channel: number, after: number, before: number, opts: { maxPages?: number } = {}): Promise<DahuaFile[]> {
    const run = async () => {
      const off = await this.offsetSec();
      const id = parseFinderId(await this.cgi('mediaFileFind.cgi?action=factory.create'));
      if (!id) throw new Error('The recorder couldn’t start a search. Try again in a moment.');
      const files: DahuaFile[] = [];
      try {
        const q = findFileQuery({
          objectId: id,
          channel,
          start: toDeviceTime(after, off),
          end: toDeviceTime(before, off),
        });
        // "OK" when something matches, "Error" when nothing does (or there's no disk).
        if (isErrorBody(await this.cgi(`mediaFileFind.cgi?${q}`, 20_000))) return files;
        for (let page = 0; page < (opts.maxPages ?? 20); page++) {
          const next = await this.cgi(`mediaFileFind.cgi?action=findNextFile&object=${id}&count=${PAGE}`, 20_000);
          if (isErrorBody(next)) break;
          const { found, files: batch } = parseFindNext(next);
          files.push(...batch);
          if (found < PAGE) break;
        }
      } finally {
        await this.cgi(`mediaFileFind.cgi?action=close&object=${id}`).catch(() => {});
        await this.cgi(`mediaFileFind.cgi?action=destroy&object=${id}`).catch(() => {});
      }
      return files;
    };
    const p = this.finderQueue.then(run, run);
    this.finderQueue = p.catch(() => {});
    return p;
  }

  async recordingSegments(cameraId: string, after: number, before: number): Promise<RecordingSegment[]> {
    const files = await this.findFiles(Number(cameraId), after, before);
    return filesToSegments(files, await this.offsetSec());
  }

  /** Days with video in the last 31 days (device-local dates). Very busy recorders may cap out early. */
  async recordingDays(cameraId: string): Promise<string[]> {
    const now = Date.now() / 1000;
    const files = await this.findFiles(Number(cameraId), now - 31 * 86400, now, { maxPages: 40 });
    return filesToDays(files);
  }

  async listReview(q: {
    cameras?: string[];
    after?: number;
    before?: number;
    severity?: Severity;
    limit?: number;
  }): Promise<ReviewItem[]> {
    const before = q.before ?? Date.now() / 1000 + 60;
    const after = q.after ?? before - 86400;
    const cams = q.cameras?.length ? q.cameras : (await this.listCameras()).filter((c) => c.enabled).map((c) => c.id);
    const off = await this.offsetSec();
    const items: ReviewItem[] = [];
    for (const cam of cams) {
      const files = await this.findFiles(Number(cam), after, before).catch(() => [] as DahuaFile[]);
      items.push(
        ...filesToReview(files, {
          systemId: this.config.id,
          offsetSec: off,
          // RPC_Loadfile serves a found file by its path (Amcrest HTTP API §4.11.6).
          thumbUrl: (p) => `${this.base}/cgi-bin/RPC_Loadfile${p.startsWith('/') ? '' : '/'}${p.replace(/ /g, '%20')}`,
        }),
      );
    }
    return items
      .filter((i) => !q.severity || i.severity === q.severity)
      .filter((i) => i.startTime >= after && i.startTime <= before)
      .sort((a, b) => b.startTime - a.startTime)
      .slice(0, q.limit ?? 100);
  }

  async health(): Promise<HealthReport> {
    const [loss, disks, channels] = await Promise.all([
      this.cgi('eventManager.cgi?action=getEventIndexes&code=VideoLoss').catch(() => ''),
      this.kv('storageDevice.cgi?action=getDeviceAllInfo').catch(() => ({}) as Record<string, string>),
      this.channels ?? this.loadChannels(),
    ]);
    const enabled = new Set(channels.filter((c) => c.enabled).map((c) => c.channel));
    return {
      offline: parseEventChannels(loss)
        .filter((c) => enabled.has(c))
        .map(String),
      storage: parseStorage(disks),
    };
  }

  // -------------------------------------------------------------------------------------------
  // PTZ (ptz.cgi). Moves are continuous between `start` and `stop`, matching the pad.

  async ptzInfo(cameraId: string): Promise<PtzInfo> {
    const ch = encodeURIComponent(cameraId);
    const [caps, presets] = await Promise.all([
      this.kv(`ptz.cgi?action=getCurrentProtocolCaps&channel=${ch}`).catch(() => ({}) as Record<string, string>),
      this.kv(`ptz.cgi?action=getPresets&channel=${ch}`).catch(() => ({}) as Record<string, string>),
    ]);
    const c = parsePtzCaps(caps);
    const p = parsePresets(presets);
    this.ptzCaps.set(cameraId, c);
    this.presets.set(cameraId, p);
    return { canMove: c.canMove, canZoom: c.canZoom, presets: p.map((x) => x.name) };
  }

  private lastMove = new Map<string, string>();

  async ptz(cameraId: string, action: PtzAction | `preset_${string}`): Promise<void> {
    const ch = encodeURIComponent(cameraId);
    if (action.startsWith('preset_')) {
      const name = action.slice('preset_'.length);
      if (!this.presets.has(cameraId)) await this.ptzInfo(cameraId);
      const preset = this.presets.get(cameraId)?.find((p) => p.name === name);
      if (!preset) throw new Error('That preset no longer exists on the camera.');
      await this.cgi(`ptz.cgi?action=start&channel=${ch}&code=GotoPreset&arg1=0&arg2=${preset.index}&arg3=0`);
      return;
    }
    if (action === 'STOP') {
      const code = this.lastMove.get(cameraId);
      if (!code) return;
      this.lastMove.delete(cameraId);
      await this.cgi(`ptz.cgi?action=stop&channel=${ch}&code=${code}&arg1=0&arg2=0&arg3=0`);
      return;
    }
    const code = ptzCode(action as PtzAction);
    if (!code) return;
    this.lastMove.set(cameraId, code);
    // arg2 is the speed (1–8) for pan/tilt.
    await this.cgi(`ptz.cgi?action=start&channel=${ch}&code=${code}&arg1=0&arg2=4&arg3=0`);
  }

  dispose() {}
}

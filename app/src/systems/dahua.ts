import { useLinks } from '@/net/connection';
import { secrets, SECRET } from '@/state/secrets';
import {
  dahuaHttpMessage,
  dahuaNetworkMessage,
  dayRanges,
  deviceClock,
  fromDeviceTime,
  phoneClock,
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
  type DeviceClock,
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
/** Recordings (not the JPG pictures the recorder also stores). */
const VIDEO_TYPES = ['dav', 'mp4'];
/** A search that hits the page cap is split in halves (newest first) down to this size. */
const MIN_SPLIT_SEC = 3600;

interface FindOpts {
  types?: string[];
  flags?: string[];
  videoStream?: string;
  maxPages?: number;
  /** Files per findNextFile call (≤ PAGE). */
  count?: number;
}

interface FindResult {
  files: DahuaFile[];
  /** false when the page cap stopped the search before the last file. */
  complete: boolean;
}

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
  private clockState: { clock: DeviceClock; at: number } | null = null;
  /** Whether findFile honors the event-recordings filter (Flag=Event, VideoStream=Main); unknown until seen. */
  private eventFilter: boolean | undefined;
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
    let res: Response;
    let body: string;
    try {
      res = await fetchWithTimeout(`${this.base}/cgi-bin/${path}`, {}, timeoutMs);
      body = await res.text();
    } catch (e) {
      throw new Error(dahuaNetworkMessage(e));
    }
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
    await this.clock(true);
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

  /** Device clock (offset from UTC, and whether it follows the phone's zone), refreshed every 30 minutes. */
  private async clock(force = false): Promise<DeviceClock> {
    if (!force && this.clockState && Date.now() - this.clockState.at < OFFSET_TTL_MS) return this.clockState.clock;
    try {
      const sent = Date.now();
      const body = await this.cgi('global.cgi?action=getCurrentTime');
      const mid = (sent + Date.now()) / 2;
      this.clockState = { clock: deviceClock(body, mid, -new Date().getTimezoneOffset()), at: Date.now() };
    } catch {
      // Fall back to "the recorder is in the phone's time zone" (true for nearly every home).
      this.clockState ??= { clock: phoneClock(), at: Date.now() };
    }
    return this.clockState.clock;
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
    const clock = await this.clock();
    return { kind: 'stream', source: { kind: 'rtsp', url: await this.rtsp(playbackPath(Number(cameraId), start, end, clock)) } };
  }

  // -------------------------------------------------------------------------------------------
  // File search: factory.create → findFile → findNextFile… → close → destroy.

  /**
   * One search. The device allows only a few open finders, so searches run one at a time.
   * Results come oldest first; `complete` is false when the page cap cut the list short.
   */
  private findFiles(channel: number, after: number, before: number, opts: FindOpts = {}): Promise<FindResult> {
    const run = async (): Promise<FindResult> => {
      const clock = await this.clock();
      const id = parseFinderId(await this.cgi('mediaFileFind.cgi?action=factory.create'));
      if (!id) throw new Error('The recorder couldn’t start a search. Try again in a moment.');
      const files: DahuaFile[] = [];
      const count = Math.min(PAGE, opts.count ?? PAGE);
      try {
        const q = findFileQuery({
          objectId: id,
          channel,
          start: toDeviceTime(after, clock),
          end: toDeviceTime(before, clock),
          types: opts.types,
          flags: opts.flags,
          videoStream: opts.videoStream,
        });
        // "OK" when something matches, "Error" when nothing does (or there's no disk).
        if (isErrorBody(await this.cgi(`mediaFileFind.cgi?${q}`, 20_000))) return { files, complete: true };
        for (let page = 0; page < (opts.maxPages ?? 20); page++) {
          const next = await this.cgi(`mediaFileFind.cgi?action=findNextFile&object=${id}&count=${count}`, 20_000);
          if (isErrorBody(next)) return { files, complete: true };
          const { found, files: batch } = parseFindNext(next);
          files.push(...batch);
          if (found < count) return { files, complete: true };
        }
        return { files, complete: false };
      } finally {
        await this.cgi(`mediaFileFind.cgi?action=close&object=${id}`).catch(() => {});
        await this.cgi(`mediaFileFind.cgi?action=destroy&object=${id}`).catch(() => {});
      }
    };
    const p = this.finderQueue.then(run, run);
    this.finderQueue = p.catch(() => {});
    return p;
  }

  /**
   * Searches [after, before] one device-local day at a time from the newest, so a busy
   * recorder's page cap never hides the most recent files. A search that still hits the cap
   * is split in halves, newer half first. `take` gets each piece's files (newest piece first)
   * and returns true to stop.
   */
  private async walkNewestFirst(
    channel: number,
    after: number,
    before: number,
    opts: () => FindOpts,
    take: (files: DahuaFile[], from: number, to: number) => boolean | Promise<boolean>,
  ): Promise<void> {
    const visit = async (a: number, b: number): Promise<boolean> => {
      const r = await this.findFiles(channel, a, b, opts());
      if (!r.complete && b - a > MIN_SPLIT_SEC) {
        const mid = Math.floor((a + b) / 2);
        return (await visit(mid, b)) || (await visit(a, mid));
      }
      return take(r.files, a, b);
    };
    for (const [a, b] of dayRanges(after, before, await this.clock())) {
      if (await visit(a, b)) return;
    }
  }

  async recordingSegments(cameraId: string, after: number, before: number): Promise<RecordingSegment[]> {
    const files: DahuaFile[] = [];
    await this.walkNewestFirst(Number(cameraId), after, before, () => ({ types: VIDEO_TYPES }), (batch) => {
      files.push(...batch);
      return false;
    });
    return filesToSegments(files, await this.clock());
  }

  /** Days with video in the last 31 days (device-local dates), newest first. */
  async recordingDays(cameraId: string): Promise<string[]> {
    const ch = Number(cameraId);
    const clock = await this.clock();
    const now = Date.now() / 1000;
    const from = now - 31 * 86400;
    // One search usually covers the month (video files only, so it stays small).
    const first = await this.findFiles(ch, from, now, { types: VIDEO_TYPES, maxPages: 10 });
    const days = new Set(filesToDays(first.files));
    if (!first.complete) {
      // Results come oldest first, so the days after the last file seen are still unknown:
      // ask about each of those days, newest first (one file is enough to know).
      const last = Math.max(from, ...first.files.map((f) => fromDeviceTime(f.startTime, clock) ?? 0));
      for (const [a, b] of dayRanges(last, now, clock)) {
        if (days.has(toDeviceTime(a, clock).slice(0, 10))) continue;
        const r = await this.findFiles(ch, a, b, { types: VIDEO_TYPES, maxPages: 1, count: 1 });
        for (const d of filesToDays(r.files)) days.add(d);
      }
    }
    return [...days].sort().reverse();
  }

  /** RPC_Loadfile serves a found file by its path (Amcrest HTTP API §4.11.6). */
  private fileUrl = (p: string) => `${this.base}/cgi-bin/RPC_Loadfile${p.startsWith('/') ? '' : '/'}${p.replace(/ /g, '%20')}`;

  /** Search filter for event recordings: video, event-flagged, main stream (unless the device rejects it). */
  private eventOpts = (): FindOpts =>
    this.eventFilter === false ? { types: VIDEO_TYPES } : { types: VIDEO_TYPES, flags: ['Event'], videoStream: 'Main' };

  /** One camera's newest `limit` events in [after, before]. */
  private async cameraReview(ch: number, after: number, before: number, severity: Severity | undefined, limit: number): Promise<ReviewItem[]> {
    const clock = await this.clock();
    const out = new Map<string, ReviewItem>();
    const review = (files: DahuaFile[]) =>
      filesToReview(files, { systemId: this.config.id, clock, thumbUrl: this.fileUrl }).filter(
        (i) => (!severity || i.severity === severity) && i.startTime >= after && i.startTime <= before,
      );
    await this.walkNewestFirst(ch, after, before, this.eventOpts, async (files, a, b) => {
      let videos = files;
      let items = review(videos);
      if (this.eventFilter === undefined) {
        if (items.length) this.eventFilter = true;
        else {
          // Nothing with the event filter: either a quiet day, or a device that doesn't support
          // the filter. A plain search of the same span tells them apart.
          const plain = await this.findFiles(ch, a, b, { types: VIDEO_TYPES });
          const plainItems = review(plain.files);
          if (plainItems.length) {
            this.eventFilter = false;
            videos = plain.files;
            items = plainItems;
          }
        }
      }
      if (items.length) {
        // Pictures the recorder took during these events become thumbnails (best effort).
        const s = Math.min(...items.map((i) => i.startTime)) - 5;
        const e = Math.max(...items.map((i) => i.endTime ?? i.startTime)) + 5;
        const pics = await this.findFiles(ch, s, e, {
          types: ['jpg'],
          flags: this.eventFilter ? ['Event'] : undefined,
          maxPages: 3,
        }).catch(() => ({ files: [] as DahuaFile[], complete: true }));
        items = review([...videos, ...pics.files]);
      }
      for (const i of items) if (!out.has(i.id)) out.set(i.id, i);
      return out.size >= limit;
    });
    return [...out.values()];
  }

  /**
   * Event recordings, newest first. Each camera is searched day by day from `before` back to
   * `after` and stops once it has `limit` events, so a busy recorder shows its latest events.
   */
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
    const cams = q.cameras?.length ? q.cameras : (await this.listCameras()).filter((c) => c.enabled).map((c) => c.id);
    const items: ReviewItem[] = [];
    const errors: unknown[] = [];
    for (const cam of cams) {
      try {
        items.push(...(await this.cameraReview(Number(cam), after, before, q.severity, limit)));
      } catch (e) {
        errors.push(e);
      }
    }
    // One camera failing shouldn't hide the others' events, but if every search failed the
    // user should see why rather than an empty list.
    if (cams.length && errors.length === cams.length) throw errors[0];
    return items.sort((a, b) => b.startTime - a.startTime).slice(0, limit);
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

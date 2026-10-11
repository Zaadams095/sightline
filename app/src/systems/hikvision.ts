import { useLinks } from '@/net/connection';
import { secrets, SECRET } from '@/state/secrets';
import {
  buildChannels,
  dailyDistributionXml,
  deviceToday,
  errorFor,
  HikvisionError,
  liveUrl,
  matchesToReview,
  mergeSegments,
  parseDailyDistribution,
  parseDeviceClock,
  parseDeviceInfo,
  parseInputProxyChannels,
  parseInputProxyStatus,
  parsePtzCaps,
  parsePtzPresets,
  parseRtspPort,
  parseSearchResult,
  parseStreamingChannels,
  parseVideoInputs,
  PHONE_CLOCK,
  playbackUrl,
  ptzXml,
  searchXml,
  streamId,
  xmlText,
  type Channel,
  type DeviceClock,
  type DeviceInfo,
  type SearchMatch,
  type StreamingChannel,
} from '@/systems/hikvision-parse';
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
 * Hikvision NVRs, DVRs and IP cameras (and the many rebranded ones) through ISAPI. Requests go
 * through the app's loopback gateway at `baseUrl`, which answers the Digest challenges; live
 * video and recordings play over RTSP straight from the device.
 * Protocol details and sources: systems/hikvision-parse.ts.
 */

interface PtzRoute {
  /** e.g. /ISAPI/PTZCtrl/channels/1 or /ISAPI/ContentMgmt/PTZCtrlProxy/channels/1 */
  path: string;
  canMove: boolean;
  canZoom: boolean;
}

const PAGE = 50;
const MAX_PAGES = 20;
const REVIEW_DAYS = 7;

function randomSearchId(): string {
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}`.toUpperCase();
}

export class HikvisionAdapter implements CameraSystemAdapter {
  readonly capabilities: SystemCapabilities = {
    live: !!WgTunnel,
    snapshots: true,
    review: true,
    events: true,
    ptz: true,
    twoWayAudio: false,
  };

  private device: DeviceInfo | null = null;
  private channels: Channel[] = [];
  private streams: StreamingChannel[] = [];
  private rtspPort = 554;
  private clock: DeviceClock = PHONE_CLOCK;
  private ptzRoutes = new Map<number, PtzRoute | null>();
  private presets = new Map<number, Map<string, number>>();
  private loaded: Promise<void> | null = null;

  constructor(
    readonly config: SystemConfig,
    private initialBase: string,
  ) {}

  /** Current route (LAN or VPN); the gateway port can change after the adapter is created. */
  private get base(): string {
    const b = useLinks.getState().links[this.config.id]?.baseUrl || this.initialBase;
    if (!b) throw new HikvisionError('Still connecting to the Hikvision device…');
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

  private async req(path: string, init: { method?: 'GET' | 'POST' | 'PUT'; body?: string } = {}, timeoutMs = 10_000): Promise<string> {
    let res: Response;
    try {
      res = await fetchWithTimeout(
        `${this.base}${path}`,
        {
          method: init.method ?? 'GET',
          headers: init.body ? { 'Content-Type': 'application/xml; charset=UTF-8' } : undefined,
          body: init.body,
        },
        timeoutMs,
      );
    } catch (e) {
      if (e instanceof HikvisionError) throw e;
      throw new HikvisionError('Couldn’t reach the Hikvision device. Check that it’s on and connected to your network.');
    }
    const text = await res.text();
    if (!res.ok) throw errorFor(res.status, text);
    // Writes answer 200 with a ResponseStatus; statusCode 1 means OK.
    if (init.method === 'PUT' && /<(?:\w+:)?ResponseStatus[\s>]/.test(text)) {
      const code = Number(xmlText(text, 'statusCode') ?? 1);
      if (code !== 1) throw errorFor(200, text);
    }
    return text;
  }

  /** Optional resource: '' when the device doesn't have it. */
  private async maybe(path: string): Promise<string> {
    try {
      return await this.req(path);
    } catch (e) {
      if (e instanceof HikvisionError && (e.notSupported || e.status === 403 || e.status === 400 || e.status === 500)) return '';
      throw e;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Setup

  async connect(): Promise<void> {
    this.loaded = null;
    await this.load();
  }

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      this.device = parseDeviceInfo(await this.req('/ISAPI/System/deviceInfo'));
      const [proxy, proxyStatus, inputs, streams, access, time] = await Promise.all([
        this.maybe('/ISAPI/ContentMgmt/InputProxy/channels'),
        this.maybe('/ISAPI/ContentMgmt/InputProxy/channels/status'),
        this.maybe('/ISAPI/System/Video/inputs/channels'),
        this.maybe('/ISAPI/Streaming/channels'),
        this.maybe('/ISAPI/Security/adminAccesses'),
        this.maybe('/ISAPI/System/time'),
      ]);
      this.streams = parseStreamingChannels(streams);
      this.channels = buildChannels({
        device: this.device,
        proxy: parseInputProxyChannels(proxy),
        proxyStatus: parseInputProxyStatus(proxyStatus),
        inputs: parseVideoInputs(inputs),
        streams: this.streams,
      });
      if (!this.channels.length) this.channels = [{ id: 1, name: this.device.name, online: true, proxied: false }];
      this.rtspPort = access ? parseRtspPort(access) : 554;
      if (time) this.clock = parseDeviceClock(time, Date.now(), -new Date().getTimezoneOffset());
      await Promise.all(this.channels.map((c) => this.ptzRoute(c)));
    })().catch((e) => {
      this.loaded = null;
      throw e;
    });
    return this.loaded;
  }

  /** Finds how to steer a channel: directly, or through the recorder's PTZ proxy. */
  private async ptzRoute(c: Channel): Promise<PtzRoute | null> {
    if (this.ptzRoutes.has(c.id)) return this.ptzRoutes.get(c.id)!;
    const paths = c.proxied
      ? [`/ISAPI/ContentMgmt/PTZCtrlProxy/channels/${c.id}`, `/ISAPI/PTZCtrl/channels/${c.id}`]
      : [`/ISAPI/PTZCtrl/channels/${c.id}`];
    let route: PtzRoute | null = null;
    for (const path of paths) {
      const caps = parsePtzCaps(await this.maybe(`${path}/capabilities`).catch(() => ''));
      if (caps.canMove || caps.canZoom) {
        route = { path, ...caps };
        break;
      }
    }
    this.ptzRoutes.set(c.id, route);
    return route;
  }

  async listCameras(): Promise<Camera[]> {
    await this.load();
    return this.channels.map((c) => ({
      key: `${this.config.id}:${c.id}`,
      systemId: this.config.id,
      id: String(c.id),
      name: c.name,
      enabled: c.online,
      zones: [],
      objects: ['person', 'vehicle'],
      ptz: !!this.ptzRoutes.get(c.id),
      aspect: c.width && c.height ? c.width / c.height : 16 / 9,
    }));
  }

  private channelOf(cameraId: string): number {
    const ch = Number(cameraId);
    if (!Number.isInteger(ch) || ch < 1) throw new HikvisionError('Camera not found on this Hikvision device.');
    return ch;
  }

  // -------------------------------------------------------------------------------------------
  // Snapshots and live

  /**
   * `/ISAPI/Streaming/channels/<n>01/picture`. Small tiles ask for the sub stream's picture at its
   * own size, as hikvision_next does (it always passes the stream's resolution).
   */
  snapshot(cameraId: string, opts?: { height?: number }): MediaSource {
    const base = this.baseOrEmpty();
    if (!base) return { uri: '' };
    const ch = Number(cameraId);
    const sub = this.streams.find((s) => s.id === streamId(ch, 'sub'));
    const main = this.streams.find((s) => s.id === streamId(ch, 'main'));
    const pick = opts?.height && opts.height <= 480 && sub?.width && sub.height ? sub : main;
    const id = pick?.id ?? streamId(ch, 'main');
    const size = pick?.width && pick.height ? `?videoResolutionWidth=${pick.width}&videoResolutionHeight=${pick.height}` : '';
    return { uri: `${base}/ISAPI/Streaming/channels/${id}/picture${size}` };
  }

  private async rtspAuth() {
    return {
      host: new URL(this.config.endpoint.lanUrl).hostname,
      port: this.rtspPort,
      user: this.config.username ?? 'admin',
      password: (await secrets.get(this.config.id, SECRET.password)) ?? '',
    };
  }

  async liveStream(cameraId: string, opts?: { quality?: 'main' | 'sub' }): Promise<LiveSource> {
    await this.load();
    const channel = this.channelOf(cameraId);
    return { kind: 'rtsp', url: liveUrl({ ...(await this.rtspAuth()), channel, quality: opts?.quality ?? 'main' }) };
  }

  // -------------------------------------------------------------------------------------------
  // Recordings and events

  /** All pages of a ContentMgmt/search for one channel's main recording track. */
  private async findRecordings(channel: number, start: number, end: number, metadata?: string): Promise<SearchMatch[]> {
    await this.load();
    const searchId = randomSearchId();
    const out: SearchMatch[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const xml = await this.req(
        '/ISAPI/ContentMgmt/search',
        {
          method: 'POST',
          body: searchXml({ searchId, track: streamId(channel, 'main'), start, end, clock: this.clock, position: out.length, maxResults: PAGE, metadata }),
        },
        20_000,
      );
      const res = parseSearchResult(xml, this.clock);
      out.push(...res.matches);
      if (!res.more || !res.matches.length) break;
    }
    return out.filter((m) => m.end > start && m.start < end);
  }

  async recordingSegments(cameraId: string, after: number, before: number): Promise<RecordingSegment[]> {
    return mergeSegments(await this.findRecordings(this.channelOf(cameraId), after, before));
  }

  /** Days with recordings from the per-month calendar (dailyDistribution), this month and the two before. */
  async recordingDays(cameraId: string): Promise<string[]> {
    await this.load();
    const track = streamId(this.channelOf(cameraId), 'main');
    const today = deviceToday(Date.now() / 1000, this.clock);
    const months = [0, 1, 2].map((back) => {
      const d = new Date(Date.UTC(today.year, today.mon - 1 - back, 1));
      return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
    });
    const results = await Promise.allSettled(
      months.map(async (m) =>
        parseDailyDistribution(
          await this.req(`/ISAPI/ContentMgmt/record/tracks/${track}/dailyDistribution`, {
            method: 'POST',
            body: dailyDistributionXml(m.year, m.month),
          }),
          m.year,
          m.month,
        ),
      ),
    );
    const first = results[0];
    if (first.status === 'rejected') throw first.reason;
    const todayKey = `${today.year}-${String(today.mon).padStart(2, '0')}-${String(today.day).padStart(2, '0')}`;
    const days = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
    return [...new Set(days)].filter((d) => d <= todayKey).sort().reverse();
  }

  /**
   * Events are the recorder's event recordings (motion, line crossing, intrusion, AcuSense
   * human/vehicle). Asks for event recordings only ("AllEvent"); devices that don't support
   * that filter get a plain search, keeping only segments whose type marks them as events.
   */
  private async eventMatches(channel: number, after: number, before: number): Promise<SearchMatch[]> {
    try {
      return await this.findRecordings(channel, after, before, 'AllEvent');
    } catch (e) {
      if (!(e instanceof HikvisionError) || e.status === 401 || e.status === 403) throw e;
      return (await this.findRecordings(channel, after, before)).filter((m) => m.recordType);
    }
  }

  async listReview(q: { cameras?: string[]; after?: number; before?: number; severity?: Severity; limit?: number }): Promise<ReviewItem[]> {
    await this.load();
    const before = q.before ?? Date.now() / 1000;
    const after = Math.max(q.after ?? before - 86400, before - REVIEW_DAYS * 86400);
    const ids = q.cameras?.length ? q.cameras : this.channels.map((c) => String(c.id));
    const results = await Promise.allSettled(
      ids.map(async (id) => matchesToReview(await this.eventMatches(this.channelOf(id), after, before), this.config.id, id)),
    );
    const ok = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
    if (!ok.length) {
      const err = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (err) throw err.reason;
    }
    return ok
      .filter((r) => r.startTime <= before && (!q.severity || r.severity === q.severity))
      .sort((a, b) => b.startTime - a.startTime)
      .slice(0, q.limit ?? 100);
  }

  /** RTSP archive playback from `start` (device-local time with "Z", see hikvision-parse.ts). */
  async playback(cameraId: string, start: number, end: number): Promise<PlaybackSource> {
    await this.load();
    const channel = this.channelOf(cameraId);
    const url = playbackUrl({ ...(await this.rtspAuth()), channel, start: Math.floor(start), end: Math.ceil(end), clock: this.clock });
    return { kind: 'stream', source: { kind: 'rtsp', url } };
  }

  // -------------------------------------------------------------------------------------------
  // PTZ

  private async route(cameraId: string): Promise<PtzRoute> {
    await this.load();
    const ch = this.channelOf(cameraId);
    const c = this.channels.find((x) => x.id === ch) ?? { id: ch, name: '', online: true, proxied: false };
    const r = await this.ptzRoute(c);
    if (!r) throw new HikvisionError('This camera can’t be moved.');
    return r;
  }

  async ptzInfo(cameraId: string): Promise<PtzInfo> {
    const r = await this.route(cameraId);
    let presets: string[] = [];
    if (r.canMove) {
      const xml = await this.maybe(`${r.path}/presets`);
      const map = parsePtzPresets(xml);
      this.presets.set(Number(cameraId), map);
      presets = [...map.keys()];
    }
    return { presets, canMove: r.canMove, canZoom: r.canZoom };
  }

  async ptz(cameraId: string, action: PtzAction | `preset_${string}`): Promise<void> {
    const r = await this.route(cameraId);
    if (action.startsWith('preset_')) {
      const ch = Number(cameraId);
      if (!this.presets.has(ch)) this.presets.set(ch, parsePtzPresets(await this.maybe(`${r.path}/presets`)));
      const id = this.presets.get(ch)!.get(action.slice('preset_'.length));
      if (id == null) throw new HikvisionError('That preset no longer exists on the camera.');
      await this.req(`${r.path}/presets/${id}/goto`, { method: 'PUT' });
      return;
    }
    const body = ptzXml(action);
    if (body) await this.req(`${r.path}/continuous`, { method: 'PUT', body });
  }

  dispose() {}
}

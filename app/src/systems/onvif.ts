import * as Crypto from 'expo-crypto';

import { secrets, SECRET } from '@/state/secrets';
import {
  body,
  camerasFromProfiles,
  deviceName,
  envelope,
  faultMessage,
  isAuthFault,
  onvifTimestamp,
  parseCapabilities,
  parseDeviceInfo,
  parseFault,
  parseProfiles,
  parsePresets,
  parsePtzNodes,
  parseServices,
  parseSystemTime,
  parseUri,
  parseUrl,
  securityHeader,
  snapshotUrl,
  streamUrl,
  xaddrPath,
  type OnvifCamera,
  type Preset,
  type PtzNode,
  type ServiceAddrs,
} from '@/systems/onvif-soap';
import type {
  Camera,
  CameraSystemAdapter,
  LiveSource,
  MediaSource,
  PtzAction,
  PtzInfo,
  SystemCapabilities,
  SystemConfig,
} from '@/systems/types';
import { fetchWithTimeout } from '@/util/fetch';
import { WgTunnel } from '@modules/wg-tunnel';

/**
 * Any ONVIF (Profile S/T) IP camera or recorder, set up with just its address and login.
 * SOAP requests go to `baseUrl`, the loopback gateway, which also answers HTTP Digest
 * challenges; WS-Security UsernameToken is added here. Live video is the camera's RTSP stream,
 * restreamed in-app (systems/live.ts).
 *
 * Not implemented: events/review. ONVIF pull-point subscriptions only report what happens while
 * subscribed (no history), so they belong in the always-on Hub, not in app polling.
 */

const DEVICE_PATH = '/onvif/device_service';
const PTZ_SPEED = 0.5;

type ErrorKind = 'auth' | 'network' | 'notfound' | 'fault' | 'other';

class OnvifError extends Error {
  constructor(
    message: string,
    readonly kind: ErrorKind,
  ) {
    super(message);
  }
}

interface State {
  devicePath: string;
  mediaPath: string;
  media2: boolean;
  ptzPath: string | null;
  name: string;
  cameras: OnvifCamera[];
  /** Raw snapshot URIs by camera id, as the camera reported them. */
  snapshots: Map<string, string>;
}

const sha1 = async (data: Uint8Array<ArrayBuffer>) => new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA1, data));

export class OnvifAdapter implements CameraSystemAdapter {
  readonly capabilities: SystemCapabilities = {
    live: !!WgTunnel,
    snapshots: true,
    review: false,
    events: false,
    ptz: false,
    twoWayAudio: false,
  };

  private state: State | null = null;
  private loading: Promise<State> | null = null;
  /** Camera clock minus phone clock, so WS-Security timestamps match the camera. */
  private skewMs = 0;
  /** Cleared when a camera rejects WS-Security but accepts the HTTP login alone. */
  private useWsse = true;
  private pass: string | null = null;
  private streams = new Map<string, string>();
  private nodes: PtzNode[] | null = null;
  private presets = new Map<string, Preset[]>();
  private readonly host: string;
  private readonly port: string;

  constructor(
    readonly config: SystemConfig,
    private baseUrl: string,
  ) {
    const u = parseUrl(config.endpoint.lanUrl);
    this.host = u?.host ?? '';
    this.port = u?.port || (u?.scheme === 'https' ? '443' : '80');
  }

  setBaseUrl(url: string) {
    this.baseUrl = url;
  }

  private async password(): Promise<string> {
    this.pass ??= (await secrets.get(this.config.id, SECRET.password)) ?? '';
    return this.pass;
  }

  /** One SOAP call. Returns the response XML or throws a plain-language OnvifError. */
  private async call(path: string, request: string, opts: { auth?: boolean; timeoutMs?: number } = {}): Promise<string> {
    if (!this.baseUrl) throw new OnvifError('Not connected to the camera yet.', 'network');
    const username = this.config.username ?? '';
    const wsse = (opts.auth ?? true) && this.useWsse && !!username;
    const header = wsse
      ? await securityHeader({
          username,
          password: await this.password(),
          nonce: Crypto.getRandomBytes(16),
          created: onvifTimestamp(Date.now() + this.skewMs),
          sha1,
        })
      : '';

    let res: Response;
    try {
      res = await fetchWithTimeout(
        `${this.baseUrl}${path}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/soap+xml; charset=utf-8' },
          body: envelope(request, header),
        },
        opts.timeoutMs ?? 10000,
      );
    } catch (e) {
      // Never pass the raw message on: it names the app's loopback port ("No response from 127.0.0.1:53817…").
      const timedOut = e instanceof Error && e.message.startsWith('No response');
      throw new OnvifError(
        timedOut
          ? 'The camera didn’t answer in time. Check that it’s on and that the phone is on the same network.'
          : 'Couldn’t reach the camera. Is the phone on the same network?',
        'network',
      );
    }
    const xml = await res.text().catch(() => '');
    const fault = parseFault(xml);

    if (fault) {
      if (isAuthFault(fault) && wsse) {
        // Some cameras reject WS-Security (e.g. a strict clock check) but accept the HTTP login.
        this.useWsse = false;
        try {
          return await this.call(path, request, opts);
        } catch (e) {
          this.useWsse = true;
          if (e instanceof OnvifError && e.kind !== 'auth') throw e;
          throw new OnvifError(authMessage(), 'auth');
        }
      }
      throw new OnvifError(isAuthFault(fault) ? authMessage() : faultMessage(fault), isAuthFault(fault) ? 'auth' : 'fault');
    }
    if (res.status === 401 || res.status === 403) throw new OnvifError(authMessage(), 'auth');
    if (res.status === 404) throw new OnvifError(notFoundMessage(), 'notfound');
    if (res.status === 502 || res.status === 504) {
      throw new OnvifError('Couldn’t reach the camera. Is the phone on the same network?', 'network');
    }
    if (!res.ok) throw new OnvifError(`The camera returned an error (HTTP ${res.status}).`, 'other');
    if (!/<(?:[\w.-]+:)?Envelope[\s>]/.test(xml)) throw new OnvifError(notFoundMessage(), 'notfound');
    return xml;
  }

  async connect(): Promise<void> {
    this.state = null;
    this.loading = null;
    this.pass = null;
    this.streams.clear();
    await this.load();
  }

  private load(): Promise<State> {
    if (this.state) return Promise.resolve(this.state);
    this.loading ??= this.discover()
      .then((s) => {
        this.state = s;
        return s;
      })
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  private async discover(): Promise<State> {
    // 1. Camera clock (no login needed): WS-Security fails when clocks differ by minutes.
    try {
      const t = parseSystemTime(await this.call(DEVICE_PATH, body.getSystemDateAndTime(), { auth: false }));
      if (t != null) this.skewMs = t - Date.now();
    } catch (e) {
      if (e instanceof OnvifError && (e.kind === 'network' || e.kind === 'notfound')) throw e;
    }

    // 2. Where the media/PTZ services live. Newer cameras answer GetServices, older ones only
    //    GetCapabilities. XAddrs hold the camera's own address; only their paths are used.
    let addrs: ServiceAddrs = {};
    try {
      addrs = parseServices(await this.call(DEVICE_PATH, body.getServices()));
    } catch (e) {
      if (e instanceof OnvifError && e.kind !== 'fault' && e.kind !== 'other') throw e;
    }
    if (!addrs.media && !addrs.media2) {
      try {
        addrs = { ...addrs, ...parseCapabilities(await this.call(DEVICE_PATH, body.getCapabilities())) };
      } catch (e) {
        if (e instanceof OnvifError && e.kind !== 'fault' && e.kind !== 'other') throw e;
      }
    }
    const devicePath = xaddrPath(addrs.device, DEVICE_PATH);

    // 3. Name (also the first call that always needs the login).
    let name = '';
    try {
      name = deviceName(parseDeviceInfo(await this.call(devicePath, body.getDeviceInformation())));
    } catch (e) {
      if (e instanceof OnvifError && e.kind === 'auth') throw e;
    }

    // 4. Video profiles: one camera per video source (lens or recorder channel).
    const media2 = !addrs.media && !!addrs.media2;
    const mediaPath = xaddrPath(media2 ? addrs.media2 : addrs.media, media2 ? '/onvif/media2_service' : '/onvif/media_service');
    const profiles = parseProfiles(await this.call(mediaPath, body.getProfiles(media2)));
    const cameras = camerasFromProfiles(profiles);
    if (!cameras.length) throw new OnvifError('The camera has no video streams set up. Check its video settings.', 'other');

    // 5. Snapshot links (optional; tiles fall back to a small live view without one).
    const snapshots = new Map<string, string>();
    await Promise.all(
      cameras.map(async (c) => {
        try {
          const uri = parseUri(await this.call(mediaPath, body.getSnapshotUri(c.main.token, media2), { timeoutMs: 5000 }));
          if (uri) snapshots.set(c.id, uri);
        } catch {
          // No snapshot support.
        }
      }),
    );

    const ptzPath = addrs.ptz ? xaddrPath(addrs.ptz, '/onvif/ptz_service') : null;
    this.capabilities.snapshots = snapshots.size > 0;
    this.capabilities.ptz = !!ptzPath && cameras.some((c) => c.ptzProfile);
    return { devicePath, mediaPath, media2, ptzPath, name, cameras, snapshots };
  }

  private async camera(cameraId: string): Promise<{ s: State; cam: OnvifCamera }> {
    const s = await this.load();
    const cam = s.cameras.find((c) => c.id === cameraId);
    if (!cam) throw new Error('This camera is no longer available. Try removing and adding it again.');
    return { s, cam };
  }

  async listCameras(): Promise<Camera[]> {
    const s = await this.load();
    const custom = this.config.name.trim();
    const base = custom && custom !== 'Home' ? custom : s.name || 'Camera';
    return s.cameras.map((c, i) => ({
      key: `${this.config.id}:${c.id}`,
      systemId: this.config.id,
      id: c.id,
      name: s.cameras.length > 1 ? `${base} ${i + 1}` : base,
      enabled: true,
      zones: [],
      objects: [],
      ptz: !!s.ptzPath && !!c.ptzProfile,
      aspect: c.main.width && c.main.height ? c.main.width / c.main.height : 16 / 9,
    }));
  }

  snapshot(cameraId: string): MediaSource {
    const uri = this.state?.snapshots.get(cameraId);
    return { uri: uri && this.baseUrl ? snapshotUrl(uri, this.baseUrl, this.host, this.port) : '' };
  }

  async liveStream(cameraId: string, opts?: { quality?: 'main' | 'sub' }): Promise<LiveSource> {
    const { s, cam } = await this.camera(cameraId);
    const profile = opts?.quality === 'sub' ? cam.sub : cam.main;
    let url = this.streams.get(profile.token);
    if (!url) {
      const uri = parseUri(await this.call(s.mediaPath, body.getStreamUri(profile.token, s.media2)));
      if (!uri) throw new Error('The camera didn’t provide a video link.');
      url = streamUrl(uri, this.host, this.config.username ?? '', await this.password());
      this.streams.set(profile.token, url);
    }
    return { kind: 'rtsp', url };
  }

  async ptzInfo(cameraId: string): Promise<PtzInfo> {
    const { s, cam } = await this.camera(cameraId);
    if (!s.ptzPath || !cam.ptzProfile) return { presets: [], canMove: false, canZoom: false };
    const ptzPath = s.ptzPath;
    // Remember the nodes only once the camera has listed them; a timeout is retried next time.
    const nodes =
      this.nodes ??
      (await this.call(ptzPath, body.getNodes())
        .then((xml) => (this.nodes = parsePtzNodes(xml)))
        .catch(() => [] as PtzNode[]));
    const nodeToken = cam.ptzProfile.ptz?.nodeToken;
    const node = nodes.find((n) => n.token === nodeToken) ?? nodes[0];
    const presets = await this.loadPresets(ptzPath, cam.ptzProfile.token).catch(() => []);
    return {
      presets: presets.map((p) => p.name),
      canMove: node ? node.canMove : true,
      canZoom: node ? node.canZoom : false,
    };
  }

  private async loadPresets(ptzPath: string, profile: string): Promise<Preset[]> {
    const list = parsePresets(await this.call(ptzPath, body.getPresets(profile)));
    // The UI shows names; keep the first preset for duplicate names.
    const unique = list.filter((p, i) => list.findIndex((q) => q.name === p.name) === i);
    this.presets.set(profile, unique);
    return unique;
  }

  async ptz(cameraId: string, action: PtzAction | `preset_${string}`): Promise<void> {
    const { s, cam } = await this.camera(cameraId);
    if (!s.ptzPath || !cam.ptzProfile) throw new Error('This camera can’t pan or zoom.');
    const profile = cam.ptzProfile.token;

    if (action.startsWith('preset_')) {
      const name = action.slice('preset_'.length);
      const list = this.presets.get(profile) ?? (await this.loadPresets(s.ptzPath, profile));
      const preset = list.find((p) => p.name === name) ?? list.find((p) => p.token === name);
      if (!preset) throw new Error(`Preset “${name}” wasn’t found on the camera.`);
      await this.call(s.ptzPath, body.gotoPreset(profile, preset.token));
      return;
    }

    const v = PTZ_SPEED;
    const request = (() => {
      switch (action as PtzAction) {
        case 'MOVE_UP':
          return body.continuousMove(profile, { x: 0, y: v });
        case 'MOVE_DOWN':
          return body.continuousMove(profile, { x: 0, y: -v });
        case 'MOVE_LEFT':
          return body.continuousMove(profile, { x: -v, y: 0 });
        case 'MOVE_RIGHT':
          return body.continuousMove(profile, { x: v, y: 0 });
        case 'ZOOM_IN':
          return body.continuousMove(profile, { zoom: v });
        case 'ZOOM_OUT':
          return body.continuousMove(profile, { zoom: -v });
        default:
          return body.stop(profile);
      }
    })();
    await this.call(s.ptzPath, request, { timeoutMs: 5000 });
  }

  dispose() {
    this.state = null;
    this.loading = null;
    this.streams.clear();
  }
}

function authMessage() {
  return 'Wrong username or password. Use the camera’s own login; some cameras need a separate ONVIF user, added in the camera’s settings.';
}

function notFoundMessage() {
  return 'No ONVIF camera answered at this address. Turn on ONVIF in the camera’s settings, or add its ONVIF port to the address (often 8000, 2020 or 8899, e.g. 192.168.1.70:2020).';
}

import { AppState } from 'react-native';
import { create } from 'zustand';

import { parseStatus, WgTunnel, type AuthKind } from '@modules/wg-tunnel';
import { secrets, SECRET } from '@/state/secrets';
import { probeHub } from '@/systems/hub';
import type { SystemConfig } from '@/systems/types';
import { useApp } from '@/state/store';
import { describe, usesGateway } from '@/systems/catalog';
import { sameConfig } from '@/util/config';
import { friendlyNetError } from '@/util/errors';
import { fetchWithTimeout } from '@/util/fetch';
import { resolveScheme } from '@/util/url';

export type LinkMode = 'connecting' | 'lan' | 'tunnel' | 'offline';

export interface SystemLink {
  /** Base URL every request for this system should use. */
  baseUrl: string;
  mode: LinkMode;
  error?: string;
  /** Present when routed through the native gateway. */
  port?: number;
  /** Reached through a system's own public link (Sightline Hub), not the VPN. */
  remote?: boolean;
}

interface LinkState {
  links: Record<string, SystemLink>;
  tunnelUp: boolean;
  set(id: string, link: SystemLink): void;
}

export const useLinks = create<LinkState>((set) => ({
  links: {},
  tunnelUp: false,
  set: (id, link) => set((s) => ({ links: { ...s.links, [id]: link } })),
}));

const TUNNEL_SCOPE = 'tunnel';
const LAN_PROBE_MS = 1500;
/** Keep the tunnel alive briefly after backgrounding so quick app switches are instant. */
const BACKGROUND_GRACE_MS = 20_000;
/** How often to check whether the phone switched networks while the app is open. */
const NETWORK_POLL_MS = 5000;

/** Routes for helpers (e.g. the alerts bridge) that should not show in connection status. */
const privateLinks: Record<string, SystemLink> = {};

let tunnelStarting: Promise<void> | null = null;
let stopTimer: ReturnType<typeof setTimeout> | null = null;

function hostPort(url: string): string {
  const u = new URL(url);
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  return `${u.hostname}:${port}`;
}

function authKindFor(s: SystemConfig): AuthKind {
  const kind = describe(s.kind)?.gatewayAuth;
  if (kind) return kind;
  // NVRs/cameras answer with Basic or Digest challenges; the gateway handles either.
  return s.username ? 'http' : '';
}

export async function saveTunnelConfig(conf: string): Promise<string> {
  const err = WgTunnel?.validateConfig(conf) ?? '';
  if (!err) await secrets.set(TUNNEL_SCOPE, SECRET.wireguardConf, conf);
  return err;
}

export async function hasTunnelConfig(): Promise<boolean> {
  return !!(await secrets.get(TUNNEL_SCOPE, SECRET.wireguardConf));
}

export async function ensureTunnel(): Promise<void> {
  if (!WgTunnel) throw new Error('VPN is not available in this build');
  if (parseStatus(WgTunnel.tunnelStatus()).running) return;
  tunnelStarting ??= (async () => {
    const conf = await secrets.get(TUNNEL_SCOPE, SECRET.wireguardConf);
    if (!conf) throw new Error('No VPN configuration. Add one in Settings → VPN.');
    await WgTunnel!.startTunnel(conf);
    useLinks.setState({ tunnelUp: true });
  })().finally(() => {
    tunnelStarting = null;
  });
  return tunnelStarting;
}

interface ConnectOpts {
  /** false: a helper's route (e.g. the alerts bridge), kept out of connection status. */
  publish?: boolean;
  /** Always route over HTTP, whatever kind the config borrows (helpers like the bridge). */
  http?: boolean;
}

interface Attempt {
  config: SystemConfig;
  promise: Promise<SystemLink>;
  /** Set when an edit or disconnect replaced this attempt; its result is then discarded. */
  superseded: boolean;
}

const inflight = new Map<string, Attempt>();

/**
 * Establish (or re-evaluate) the route for one system: LAN first, tunnel as fallback.
 * Returns the link to use; also published in `useLinks`. Concurrent calls for the same
 * system share one attempt, so foreground + screen + background checks don't race to add
 * duplicate gateway routes.
 */
export function connectSystem(s: SystemConfig, opts: ConnectOpts = {}): Promise<SystemLink> {
  const key = `${opts.publish === false ? 'private' : 'public'}:${s.id}`;
  const running = inflight.get(key);
  // An edit (new address or sign-in) starts over instead of reusing the old attempt.
  if (running && sameConfig(running.config, s)) return running.promise;
  if (running) running.superseded = true;
  const attempt: Attempt = { config: s, promise: Promise.resolve({ baseUrl: '', mode: 'connecting' }), superseded: false };
  attempt.promise = connectOnce(s, opts, attempt)
    .then((link) => (attempt.superseded ? currentLink(key, s.id, opts) : link))
    .finally(() => {
      if (inflight.get(key) === attempt) inflight.delete(key);
    });
  inflight.set(key, attempt);
  return attempt.promise;
}

/** What a replaced attempt's callers get instead: the newer attempt, or the route as it is now. */
function currentLink(key: string, id: string, opts: ConnectOpts): Promise<SystemLink> | SystemLink {
  const newer = inflight.get(key);
  if (newer) return newer.promise;
  const link = opts.publish === false ? privateLinks[id] : useLinks.getState().links[id];
  return link ?? { baseUrl: '', mode: 'offline' };
}

async function connectOnce(s: SystemConfig, opts: ConnectOpts, attempt: Attempt): Promise<SystemLink> {
  const publish = opts.publish ?? true;
  // Cameras added by stream link have no HTTP side; their live video is restreamed on demand.
  if (!usesGateway(s.kind) && !opts.http) {
    const link: SystemLink = { baseUrl: '', mode: 'lan' };
    if (publish) useLinks.getState().set(s.id, link);
    return link;
  }
  const links = useLinks.getState();
  const prev = publish ? links.links[s.id] : privateLinks[s.id];
  const store = {
    set: (id: string, link: SystemLink) => {
      // A replaced attempt must not overwrite the newer route, nor keep a route of its own.
      if (attempt.superseded) {
        if (link.port != null && link.port !== prev?.port) WgTunnel?.removeRoute(link.port);
        return;
      }
      if (publish) links.set(id, link);
      else privateLinks[id] = link;
    },
  };

  // A Sightline Hub is reached directly: its home address, else its own public HTTPS link.
  // It never needs the gateway or the VPN.
  if (s.kind === 'hub') {
    store.set(s.id, { ...(prev ?? { baseUrl: s.endpoint.lanUrl }), mode: 'connecting', error: undefined });
    const link = await probeHub(s);
    store.set(s.id, link);
    return link;
  }

  // Expo Go / web: no native gateway, so talk to the server directly (preview only: home
  // network, no VPN, and no self-signed certificates).
  if (!WgTunnel) {
    const baseUrl = s.endpoint.lanUrl.replace(/\/$/, '');
    let link: SystemLink = { baseUrl, mode: 'lan' };
    if (describe(s.kind)?.gatewayAuth === 'frigate') {
      const err = await directFrigateLogin(s, baseUrl);
      if (err) link = { baseUrl, mode: 'offline', error: err };
    }
    store.set(s.id, link);
    return link;
  }

  store.set(s.id, { ...(prev ?? { baseUrl: '' }), mode: 'connecting', error: undefined });
  let target = s.endpoint.lanUrl;
  // A route this attempt added; released again if the attempt fails before it's handed out.
  let addedPort: number | undefined;

  try {
    // A saved https:// address whose server actually speaks plain HTTP (e.g. Frigate 8971 with
    // TLS off) is corrected once and persisted.
    if (publish && prev?.port == null && target.startsWith('https://')) {
      const fixed = await resolveScheme(target, (u) => WgTunnel!.httpCheck(u, false, 4000));
      if (fixed !== target) {
        target = fixed;
        useApp.getState().upsertSystem({ ...s, endpoint: { ...s.endpoint, lanUrl: fixed } });
      }
    }

    let port = prev?.port;
    if (port == null) {
      const pass = (await secrets.get(s.id, SECRET.password)) ?? '';
      port = addedPort = await WgTunnel.addRoute(
        target,
        false,
        s.endpoint.allowSelfSigned ?? true,
        authKindFor(s),
        s.username ?? '',
        pass,
      );
    }
    const baseUrl = `http://127.0.0.1:${port}`;

    // Retry once: the first local connection can fail while iOS shows the Local Network prompt.
    let dialError = await WgTunnel.probeError(hostPort(target), false, LAN_PROBE_MS);
    if (dialError) {
      await new Promise((r) => setTimeout(r, 1000));
      dialError = await WgTunnel.probeError(hostPort(target), false, LAN_PROBE_MS);
    }
    if (!dialError) {
      WgTunnel.setRouteViaTunnel(port, false);
      const link: SystemLink = { baseUrl, port, mode: 'lan' };
      store.set(s.id, link);
      return link;
    }

    if (!s.endpoint.useTunnel || !(await hasTunnelConfig())) {
      const link: SystemLink = {
        baseUrl,
        port,
        mode: 'offline',
        // Plain words here; Settings → Diagnostics shows the raw error step by step.
        error: friendlyNetError(dialError, s.name),
      };
      store.set(s.id, link);
      return link;
    }

    await ensureTunnel();
    WgTunnel.setRouteViaTunnel(port, true);
    const reachable = await WgTunnel.probe(hostPort(target), true, 5000);
    const link: SystemLink = reachable
      ? { baseUrl, port, mode: 'tunnel' }
      : { baseUrl, port, mode: 'offline', error: `Connected to home, but ${s.name} didn’t answer. Make sure it’s turned on.` };
    store.set(s.id, link);
    return link;
  } catch (e) {
    // Don't leave a half-made route (and its listener) behind in the native gateway.
    if (addedPort != null) WgTunnel.removeRoute(addedPort);
    const link: SystemLink = {
      baseUrl: prev?.baseUrl ?? '',
      port: prev?.port,
      mode: 'offline',
      error: friendlyNetError(e instanceof Error ? e.message : String(e), s.name),
    };
    store.set(s.id, link);
    return link;
  }
}

/**
 * Without the gateway, log in with fetch. iOS keeps Frigate's session cookie in the shared
 * cookie store, so later fetches, the WebView live player and AVPlayer all send it.
 * Returns an error message, or null when connected.
 */
async function directFrigateLogin(s: SystemConfig, baseUrl: string): Promise<string | null> {
  try {
    if (s.username) {
      const password = (await secrets.get(s.id, SECRET.password)) ?? '';
      const res = await fetchWithTimeout(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: s.username, password }),
        credentials: 'include',
      });
      if (res.status === 401) return 'Wrong username or password';
      if (!res.ok && res.status !== 404) return `Login failed (HTTP ${res.status})`;
    }
    const probe = await fetchWithTimeout(`${baseUrl}/api/version`, { credentials: 'include' });
    return probe.ok ? null : `${s.name} returned HTTP ${probe.status}`;
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('No response')) return `${e.message}. Is the phone on the same network as ${s.name}?`;
    return baseUrl.startsWith('https')
      ? "Couldn't connect. Expo Go can't accept self-signed certificates; use an http:// address for previews."
      : `Couldn't reach ${s.name} on this network`;
  }
}

/** Forget a system's route (after editing credentials or removing it). */
export function disconnectSystem(id: string) {
  const running = inflight.get(`public:${id}`);
  if (running) {
    running.superseded = true;
    inflight.delete(`public:${id}`);
  }
  const link = useLinks.getState().links[id];
  if (link?.port != null) WgTunnel?.removeRoute(link.port);
  useLinks.setState((st) => {
    const links = { ...st.links };
    delete links[id];
    return { links };
  });
}

/** The phone's local networks; changes when it joins/leaves Wi-Fi. '' without the gateway. */
function networkSignature(): string {
  try {
    return WgTunnel?.localSubnets() ?? '';
  } catch {
    return '';
  }
}

/**
 * Re-evaluate all routes on foreground and when the phone changes networks (home Wi-Fi ↔
 * cellular), stop the tunnel after a grace period in background. `onRerouted` runs after
 * routes settle, so open live streams can switch between LAN and VPN.
 */
export function startLifecycle(getSystems: () => SystemConfig[], onRerouted?: () => void) {
  let network = networkSignature();
  const reroute = async () => {
    await Promise.allSettled(getSystems().map((s) => connectSystem(s)));
    onRerouted?.();
  };
  const sub = AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      if (stopTimer) clearTimeout(stopTimer);
      stopTimer = null;
      network = networkSignature();
      void reroute();
    } else if (state === 'background' && WgTunnel) {
      stopTimer = setTimeout(() => {
        void WgTunnel!.stopTunnel();
        useLinks.setState({ tunnelUp: false });
      }, BACKGROUND_GRACE_MS);
    }
  });
  const netTimer = WgTunnel
    ? setInterval(() => {
        if (AppState.currentState !== 'active') return;
        const now = networkSignature();
        if (now === network) return;
        network = now;
        void reroute();
      }, NETWORK_POLL_MS)
    : null;
  getSystems().forEach((s) => void connectSystem(s));
  return () => {
    sub.remove();
    if (netTimer) clearInterval(netTimer);
  };
}

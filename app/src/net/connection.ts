import { AppState } from 'react-native';
import { create } from 'zustand';

import { parseStatus, WgTunnel, type AuthKind } from '@modules/wg-tunnel';
import { secrets, SECRET } from '@/state/secrets';
import type { SystemConfig } from '@/systems/types';
import { useApp } from '@/state/store';
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
  if (s.kind === 'frigate') return 'frigate';
  return s.username ? 'basic' : '';
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

/**
 * Establish (or re-evaluate) the route for one system: LAN first, tunnel as fallback.
 * Returns the link to use; also published in `useLinks`.
 */
export async function connectSystem(s: SystemConfig, opts: { publish?: boolean } = {}): Promise<SystemLink> {
  const publish = opts.publish ?? true;
  const links = useLinks.getState();
  const prev = publish ? links.links[s.id] : privateLinks[s.id];
  const store = {
    set: (id: string, link: SystemLink) => (publish ? links.set(id, link) : (privateLinks[id] = link)),
  };

  // Expo Go / web: no native gateway, so talk to the server directly (preview only: home
  // network, no VPN, and no self-signed certificates).
  if (!WgTunnel) {
    const baseUrl = s.endpoint.lanUrl.replace(/\/$/, '');
    let link: SystemLink = { baseUrl, mode: 'lan' };
    if (s.kind === 'frigate') {
      const err = await directFrigateLogin(s, baseUrl);
      if (err) link = { baseUrl, mode: 'offline', error: err };
    }
    store.set(s.id, link);
    return link;
  }

  store.set(s.id, { ...(prev ?? { baseUrl: '' }), mode: 'connecting', error: undefined });
  let target = s.endpoint.lanUrl;

  // A saved https:// address whose server actually speaks plain HTTP (e.g. Frigate 8971 with
  // TLS off) is corrected once and persisted.
  if (publish && prev?.port == null && target.startsWith('https://')) {
    const fixed = await resolveScheme(target, (u) => WgTunnel!.httpCheck(u, false, 4000));
    if (fixed !== target) {
      target = fixed;
      useApp.getState().upsertSystem({ ...s, endpoint: { ...s.endpoint, lanUrl: fixed } });
    }
  }

  try {
    let port = prev?.port;
    if (port == null) {
      const pass = (await secrets.get(s.id, SECRET.password)) ?? '';
      port = await WgTunnel.addRoute(
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
        error: `Couldn't reach ${hostPort(target)}: ${dialError}. Settings → Diagnostics can test the connection step by step.`,
      };
      store.set(s.id, link);
      return link;
    }

    await ensureTunnel();
    WgTunnel.setRouteViaTunnel(port, true);
    const reachable = await WgTunnel.probe(hostPort(target), true, 5000);
    const link: SystemLink = reachable
      ? { baseUrl, port, mode: 'tunnel' }
      : { baseUrl, port, mode: 'offline', error: 'VPN connected but the server did not answer' };
    store.set(s.id, link);
    return link;
  } catch (e) {
    const link: SystemLink = {
      baseUrl: prev?.baseUrl ?? '',
      port: prev?.port,
      mode: 'offline',
      error: e instanceof Error ? e.message : String(e),
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
    return probe.ok ? null : `Frigate returned HTTP ${probe.status}`;
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('No response')) return `${e.message}. Is the phone on the same network as Frigate?`;
    return baseUrl.startsWith('https')
      ? "Couldn't connect. Expo Go can't accept Frigate's self-signed certificate; use http://<ip>:5000 for previews."
      : "Couldn't reach Frigate on this network";
  }
}

/** Forget a system's route (after editing credentials or removing it). */
export function disconnectSystem(id: string) {
  const link = useLinks.getState().links[id];
  if (link?.port != null) WgTunnel?.removeRoute(link.port);
  useLinks.setState((st) => {
    const links = { ...st.links };
    delete links[id];
    return { links };
  });
}

/** Re-evaluate all routes on foreground, stop the tunnel after a grace period in background. */
export function startLifecycle(getSystems: () => SystemConfig[]) {
  const sub = AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      if (stopTimer) clearTimeout(stopTimer);
      stopTimer = null;
      getSystems().forEach((s) => void connectSystem(s));
    } else if (state === 'background' && WgTunnel) {
      stopTimer = setTimeout(() => {
        void WgTunnel!.stopTunnel();
        useLinks.setState({ tunnelUp: false });
      }, BACKGROUND_GRACE_MS);
    }
  });
  getSystems().forEach((s) => void connectSystem(s));
  return () => sub.remove();
}

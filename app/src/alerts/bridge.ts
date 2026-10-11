import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import * as Notifications from 'expo-notifications';

import type { CheckInState } from '@/alerts/checkins';
import { hubLearningFor } from '@/alerts/smart';
import { connectSystem } from '@/net/connection';
import { secrets } from '@/state/secrets';
import { WgTunnel } from '@modules/wg-tunnel';
import { useApp } from '@/state/store';
import { useSmart } from '@/state/smart';
import { HubAdapter } from '@/systems/hub';
import { getAdapter } from '@/systems/registry';
import type { SystemConfig } from '@/systems/types';

/**
 * App side of Instant Alerts: pairs with the bridge container and keeps its copy of the
 * notification rules in sync. The bridge is reached through the same gateway (LAN or VPN).
 */
const SCOPE = 'bridge';

export async function bridgeSecret(): Promise<string> {
  let s = await secrets.get(SCOPE, 'secret');
  if (!s) {
    const bytes = Crypto.getRandomBytes(24);
    s = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    await secrets.set(SCOPE, 'secret', s);
  }
  // The notification extension decrypts snapshot thumbnails with this.
  WgTunnel?.setShared('bridge.secret', s);
  return s;
}

export function composeSnippet(secret: string): string {
  return `  sightline-bridge:
    image: ghcr.io/zaadams095/sightline-bridge:latest
    container_name: sightline-bridge
    restart: unless-stopped
    ports:
      - "8086:8086"
    environment:
      MQTT_URL: tcp://mqtt:1883        # same broker Frigate uses
      # MQTT_USER: frigate
      # MQTT_PASSWORD: change-me
      FRIGATE_URL: http://frigate:5000  # Frigate's internal port on this compose network
      BRIDGE_SECRET: ${secret}
      TZ: ${Intl.DateTimeFormat().resolvedOptions().timeZone}
    volumes:
      - ./sightline-bridge:/data`;
}

async function pushToken(): Promise<string> {
  const projectId = Constants.expoConfig?.extra?.eas?.projectId as string | undefined;
  if (!projectId) throw new Error('Push is not configured in this build (missing EAS project ID).');
  const { data } = await Notifications.getExpoPushTokenAsync({ projectId });
  return data;
}

async function deviceId(token: string): Promise<string> {
  const hash = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, token);
  return hash.slice(0, 32);
}

function bridgeSystem(url: string): SystemConfig {
  return { id: 'bridge', kind: 'rtsp', name: 'Bridge', endpoint: { lanUrl: url, useTunnel: true } };
}

async function request(method: string, path: string, body?: unknown): Promise<Response> {
  const bridge = useApp.getState().alerts.bridge;
  if (!bridge) throw new Error('Instant Alerts are not paired yet.');
  WgTunnel?.setShared('bridge.url', bridge.url);
  // `http`: the borrowed 'rtsp' kind has no HTTP side, which would leave baseUrl empty and
  // send these requests to a relative URL.
  const link = await connectSystem(bridgeSystem(bridge.url), { publish: false, http: true });
  if (link.mode === 'offline') throw new Error(link.error ?? 'Could not reach the bridge');
  if (!link.baseUrl) throw new Error('Could not reach the bridge');
  const res = await fetch(`${link.baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Bridge-Secret': await bridgeSecret() },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) throw new Error('The bridge rejected the secret. Re-copy the snippet and restart the container.');
  if (!res.ok) throw new Error(`Bridge returned HTTP ${res.status}: ${await res.text()}`);
  return res;
}

/** This phone's alert settings for one system, in the bridge/Hub device format. */
async function deviceBody(system: SystemConfig, token: string) {
  const st = useApp.getState();
  const prefix = `${system.id}:`;
  const rules = Object.fromEntries(
    Object.entries(st.alerts.rules)
      .filter(([k]) => k.startsWith(prefix))
      .map(([k, r]) => [k.slice(prefix.length), r]),
  );

  let cameraNames: Record<string, string> = {};
  let detectSizes: Record<string, { width: number; height: number }> = {};
  try {
    const cams = await getAdapter(system, await connectSystem(system))?.listCameras();
    cameraNames = Object.fromEntries((cams ?? []).map((c) => [c.id, c.name]));
    detectSizes = Object.fromEntries((cams ?? []).filter((c) => c.detectSize).map((c) => [c.id, c.detectSize!]));
  } catch {}
  const masks = Object.fromEntries(
    Object.entries(st.masks)
      .filter(([k]) => k.startsWith(prefix))
      .map(([k, polys]) => [k.slice(prefix.length), polys]),
  );

  return {
    pushToken: token,
    systemId: system.id,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    defaultRule: st.alerts.defaultRule,
    rules,
    cameraNames,
    masks,
    detectSizes,
    quietHours: st.alerts.quietHours,
    cooldownSec: st.alerts.cooldownSec,
    quietFor: st.alerts.quietFor,
    snoozed: Object.fromEntries(
      Object.entries(st.alerts.snoozed)
        .filter(([k]) => k.startsWith(prefix))
        .map(([k, until]) => [k.slice(prefix.length), until]),
    ),
    health: st.alerts.health,
    packageAlerts: st.alerts.packages.enabled,
    atHome: st.alerts.presence.enabled && st.alerts.presence.atHome,
    alertWhenHome: st.alerts.presence.alertWhenHome.filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)),
    // Learned quieting and family check-ins (smart.ts, checkins-run.ts).
    learning: hubLearningFor(system.id),
    checkins: useSmart.getState().checkins.filter((c) => c.systemId === system.id),
  };
}

/**
 * Registers this phone for instant push with every Sightline Hub it's connected to (the Hub
 * limits alerts to the cameras this phone's access covers). Hubs that accepted the phone are
 * marked `extra.push`, so built-in background checks skip them and nothing arrives twice.
 */
export async function syncHubDevices(): Promise<void> {
  const hubs = useApp.getState().systems.filter((s) => s.kind === 'hub');
  if (hubs.length === 0) return;
  const token = await pushToken();
  const id = await deviceId(token);
  const thumbKey = await bridgeSecret();
  for (const hub of hubs) {
    try {
      const adapter = getAdapter(hub, await connectSystem(hub));
      if (!(adapter instanceof HubAdapter)) continue;
      if (!adapter.info) await adapter.connect();
      if (!adapter.info?.capabilities?.push) continue;
      await adapter.request('PUT', `/v1/devices/${id}`, { ...(await deviceBody(hub, token)), thumbKey });
      // The notification extension fetches a full frame from here on the home network.
      if (!useApp.getState().alerts.bridge) WgTunnel?.setShared('bridge.url', hub.endpoint.lanUrl);
      const cur = useApp.getState().systems.find((s) => s.id === hub.id);
      if (cur && cur.extra?.push !== '1') useApp.getState().upsertSystem({ ...cur, extra: { ...cur.extra, push: '1' } });
    } catch {
      // Unreachable now; the next settings change or app start retries.
    }
  }
}

/** Unregisters this phone from a Hub's push (before removing the system). */
export async function unregisterHubDevice(system: SystemConfig): Promise<void> {
  try {
    const adapter = getAdapter(system, await connectSystem(system));
    if (!(adapter instanceof HubAdapter)) return;
    await adapter.request('DELETE', `/v1/devices/${await deviceId(await pushToken())}`);
  } catch {}
}

/** Register this phone and upload current rules. Call after pairing and whenever rules change. */
export async function syncBridge(): Promise<void> {
  const st = useApp.getState();
  const frigate = st.systems.find((s) => s.kind === 'frigate');
  if (!frigate) throw new Error('Add a Frigate system first.');

  const token = await pushToken();
  const id = await deviceId(token);
  await request('PUT', `/devices/${id}`, await deviceBody(frigate, token));
}

export async function sendBridgeTest(): Promise<void> {
  const id = await deviceId(await pushToken());
  await request('POST', `/test/${id}`);
}

let syncTimer: ReturnType<typeof setTimeout> | null = null;
let hubTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Debounced re-sync whenever alert settings change: to the bridge while Instant Alerts are on,
 * and to every Sightline Hub (whose push needs no setup). Also syncs Hubs once at start.
 */
export function watchBridgeSync() {
  const syncHubsSoon = (ms: number) => {
    if (hubTimer) clearTimeout(hubTimer);
    hubTimer = setTimeout(() => void syncHubDevices().catch(() => {}), ms);
  };
  if (useApp.getState().systems.some((s) => s.kind === 'hub')) syncHubsSoon(3000);
  const unsub = useApp.subscribe((st, prev) => {
    if (st.alerts === prev.alerts && st.masks === prev.masks) return;
    if (st.systems.some((s) => s.kind === 'hub')) syncHubsSoon(1500);
    if (st.alerts.mode !== 'instant' || !st.alerts.bridge) return;
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => void syncBridge().catch(() => {}), 1500);
  });
  // Feedback, learned rules and check-ins live in their own store; Hubs need them too.
  const unsubSmart = useSmart.subscribe((st, prev) => {
    if (st.learning === prev.learning && st.conditions === prev.conditions && st.checkins === prev.checkins) return;
    if (useApp.getState().systems.some((s) => s.kind === 'hub')) syncHubsSoon(1500);
    const a = useApp.getState().alerts;
    if (a.mode !== 'instant' || !a.bridge) return;
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => void syncBridge().catch(() => {}), 1500);
  });
  return () => {
    unsub();
    unsubSmart();
    if (hubTimer) clearTimeout(hubTimer);
  };
}

/** The Hub adapter for a Sightline Hub system, or null. */
async function hubAdapter(systemId: string): Promise<HubAdapter | null> {
  const system = useApp.getState().systems.find((s) => s.id === systemId);
  if (!system || system.kind !== 'hub') return null;
  const adapter = getAdapter(system, await connectSystem(system));
  return adapter instanceof HubAdapter ? adapter : null;
}

/** "Mom's fine" on a check-in the Hub (or the Instant Alerts bridge) runs. */
export async function checkinOkOnHub(systemId: string, checkinId: string): Promise<void> {
  const id = await deviceId(await pushToken());
  const hub = await hubAdapter(systemId);
  if (hub) {
    await hub.request('POST', `/v1/devices/${id}/checkins/${encodeURIComponent(checkinId)}/ok`);
    return;
  }
  await request('POST', `/devices/${id}/checkins/${encodeURIComponent(checkinId)}/ok`);
}

/** Today's check-in state as the Hub sees it (for the Check-ins screen), keyed by check-in ID. */
export async function hubCheckinStates(systemId: string): Promise<Record<string, CheckInState>> {
  const hub = await hubAdapter(systemId);
  if (!hub) return {};
  const id = await deviceId(await pushToken());
  return (await (await hub.request('GET', `/v1/devices/${id}/checkins`)).json()) as Record<string, CheckInState>;
}

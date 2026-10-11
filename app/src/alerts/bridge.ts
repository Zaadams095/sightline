import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import * as Notifications from 'expo-notifications';

import { connectSystem } from '@/net/connection';
import { secrets } from '@/state/secrets';
import { WgTunnel } from '@modules/wg-tunnel';
import { useApp } from '@/state/store';
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
  const link = await connectSystem(bridgeSystem(bridge.url), { publish: false });
  if (link.mode === 'offline') throw new Error(link.error ?? 'Could not reach the bridge');
  const res = await fetch(`${link.baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Bridge-Secret': await bridgeSecret() },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) throw new Error('The bridge rejected the secret. Re-copy the snippet and restart the container.');
  if (!res.ok) throw new Error(`Bridge returned HTTP ${res.status}: ${await res.text()}`);
  return res;
}

/** Register this phone and upload current rules. Call after pairing and whenever rules change. */
export async function syncBridge(): Promise<void> {
  const st = useApp.getState();
  const frigate = st.systems.find((s) => s.kind === 'frigate');
  if (!frigate) throw new Error('Add a Frigate system first.');

  const token = await pushToken();
  const id = await deviceId(token);
  const prefix = `${frigate.id}:`;
  const rules = Object.fromEntries(
    Object.entries(st.alerts.rules)
      .filter(([k]) => k.startsWith(prefix))
      .map(([k, r]) => [k.slice(prefix.length), r]),
  );

  let cameraNames: Record<string, string> = {};
  let detectSizes: Record<string, { width: number; height: number }> = {};
  try {
    const cams = await getAdapter(frigate, await connectSystem(frigate))?.listCameras();
    cameraNames = Object.fromEntries((cams ?? []).map((c) => [c.id, c.name]));
    detectSizes = Object.fromEntries((cams ?? []).filter((c) => c.detectSize).map((c) => [c.id, c.detectSize!]));
  } catch {}
  const masks = Object.fromEntries(
    Object.entries(st.masks)
      .filter(([k]) => k.startsWith(prefix))
      .map(([k, polys]) => [k.slice(prefix.length), polys]),
  );

  await request('PUT', `/devices/${id}`, {
    pushToken: token,
    systemId: frigate.id,
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
    atHome: st.alerts.presence.enabled && st.alerts.presence.atHome,
    alertWhenHome: st.alerts.presence.alertWhenHome
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length)),
  });
}

export async function sendBridgeTest(): Promise<void> {
  const id = await deviceId(await pushToken());
  await request('POST', `/test/${id}`);
}

let syncTimer: ReturnType<typeof setTimeout> | null = null;

/** Debounced re-sync whenever alert settings change while Instant Alerts are on. */
export function watchBridgeSync() {
  return useApp.subscribe((st, prev) => {
    if ((st.alerts === prev.alerts && st.masks === prev.masks) || st.alerts.mode !== 'instant' || !st.alerts.bridge) return;
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => void syncBridge().catch(() => {}), 1500);
  });
}

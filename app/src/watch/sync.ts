import { File, Paths } from 'expo-file-system';
import { AppState } from 'react-native';

import { tr } from '@/i18n';
import { connectSystem, useLinks } from '@/net/connection';
import { useApp } from '@/state/store';
import { hubToken } from '@/systems/hub';
import { getAdapter, type CameraEntry } from '@/systems/registry';
import type { CameraSystemAdapter, SystemConfig } from '@/systems/types';
import { titleFor } from '@/util/format';
import { buildWatchContext, parseWatchRequest, type AlertInput, type WatchAlert } from '@/watch/context';
import { WatchBridge } from '@modules/watch-bridge';

/**
 * Feeds the Apple Watch app (targets/watch). The watch can't use the in-app VPN or the brand
 * adapters, so the phone does the work: it sends the camera list and recent alerts as the
 * WatchConnectivity context, and answers the watch's snapshot requests by fetching the image
 * with the camera's own adapter, so every brand works the same. Hub owners' watches also get
 * the Hub sign-in, so the watch can show snapshots on its own when the phone is out of reach.
 */

const MIN_INTERVAL_MS = 2 * 60_000;
const ALERT_WINDOW_SEC = 24 * 3600;

let lastPush = 0;
let pushing: Promise<void> | null = null;
let lastCredentials = '';
let pendingRing: WatchAlert | null = null;
/** Cameras from the last sync, so snapshot requests don't have to list cameras again. */
const known = new Map<string, CameraEntry>();

const safe = (key: string) => key.replace(/[^A-Za-z0-9_-]/g, '_');

function watchReady(): boolean {
  if (!WatchBridge) return false;
  try {
    const s = WatchBridge.status();
    return s.paired && s.installed;
  } catch {
    return false;
  }
}

/** Every camera across every reachable system (used when the app was woken by the watch). */
async function loadEntries(): Promise<CameraEntry[]> {
  const entries: CameraEntry[] = [];
  await Promise.allSettled(
    useApp.getState().systems.map(async (system) => {
      const link = await connectSystem(system);
      if (link.mode !== 'lan' && link.mode !== 'tunnel') return;
      const adapter = getAdapter(system, link);
      if (!adapter) return;
      const cams = await adapter.listCameras();
      entries.push(...cams.map((camera) => ({ camera, adapter })));
    }),
  );
  return entries;
}

async function recentAlerts(entries: CameraEntry[], now: number): Promise<AlertInput[]> {
  const bySystem = new Map<string, { adapter: CameraSystemAdapter; names: Map<string, string> }>();
  for (const { camera, adapter } of entries) {
    const s = bySystem.get(camera.systemId) ?? { adapter, names: new Map() };
    s.names.set(camera.id, camera.name);
    bySystem.set(camera.systemId, s);
  }
  const out: AlertInput[] = [];
  await Promise.allSettled(
    [...bySystem.values()].map(async ({ adapter, names }) => {
      if (!adapter.listReview || !adapter.capabilities.events) return;
      const items = await adapter.listReview({ after: now - ALERT_WINDOW_SEC, severity: 'alert', limit: 20 });
      for (const item of items) out.push({ item, title: titleFor(item), cameraName: names.get(item.cameraId) ?? item.cameraId });
    }),
  );
  return out;
}

async function sendCredentials(systems: SystemConfig[]) {
  const hubs = [];
  for (const s of systems) {
    if (s.kind !== 'hub') continue;
    const token = await hubToken(s.id).catch(() => '');
    if (token) hubs.push({ id: s.id, token });
  }
  const json = JSON.stringify({ hubs });
  if (json === lastCredentials) return;
  await WatchBridge!.sendCredentials(json);
  lastCredentials = json;
}

/**
 * Sends the camera list and recent alerts to the watch (throttled unless `force`). Called
 * with the Live tab's cameras while the app is open and from background alert checks.
 */
export async function syncWatch(entries: CameraEntry[] | null, opts: { force?: boolean } = {}): Promise<void> {
  if (!watchReady()) return;
  if (!opts.force && Date.now() - lastPush < MIN_INTERVAL_MS) return;
  if (pushing) return pushing;
  lastPush = Date.now();
  pushing = (async () => {
    const list = entries ?? (await loadEntries());
    if (list.length) {
      known.clear();
      for (const e of list) known.set(e.camera.key, e);
    }
    const now = Date.now() / 1000;
    const systems = useApp.getState().systems;
    const ctx = buildWatchContext({
      cameras: [...known.values()].map((e) => e.camera),
      alerts: await recentAlerts([...known.values()], now),
      systems,
      now,
      ring: pendingRing,
    });
    await WatchBridge!.updateContext(JSON.stringify(ctx));
    await sendCredentials(systems);
  })()
    .catch(() => {})
    .finally(() => {
      pushing = null;
    });
  return pushing;
}

/** A ring seen by the phone: put the watch on the doorbell screen right away. */
export function notifyWatchRing(ring: { systemId: string; cameraId: string; at?: string; reviewId?: string }) {
  if (!watchReady()) return;
  const key = `${ring.systemId}:${ring.cameraId}`;
  pendingRing = {
    id: ring.reviewId || `${key}:${ring.at ?? ''}`,
    key,
    title: tr().common.objects.doorbell,
    camera: known.get(key)?.camera.name ?? ring.cameraId,
    time: ring.at ? Number(ring.at) : Math.floor(Date.now() / 1000),
    doorbell: true,
  };
  void syncWatch(null, { force: true }).then(() => sendSnapshot(key, 320));
}

async function snapshotFile(key: string, size: number): Promise<File | null> {
  let entry = known.get(key);
  if (!entry) {
    for (const e of await loadEntries()) known.set(e.camera.key, e);
    entry = known.get(key);
  }
  if (!entry) return null;
  const { camera, adapter } = entry;
  // Off the home network the adapter needs its route (VPN or Hub link) first.
  const link = useLinks.getState().links[camera.systemId];
  if (link?.mode !== 'lan' && link?.mode !== 'tunnel') {
    const system = useApp.getState().systems.find((s) => s.id === camera.systemId);
    if (system) await connectSystem(system);
  }
  const src = adapter.snapshot(camera.id, { height: size > 240 ? 480 : 240 });
  if (!src.uri) return null;
  const dest = new File(Paths.cache, `watch-${safe(key)}.jpg`);
  if (dest.exists) dest.delete();
  return File.downloadFileAsync(src.uri, dest, { headers: src.headers, idempotent: true });
}

async function sendSnapshot(key: string, size: number, requestId?: string) {
  try {
    const file = await snapshotFile(key, size);
    if (!file) throw new Error('no-camera');
    if (requestId) await WatchBridge!.replyImage(requestId, key, file.uri, size);
    else await WatchBridge!.pushImage(key, file.uri, size);
  } catch (e) {
    if (requestId) WatchBridge!.reply(requestId, { error: e instanceof Error ? e.message : 'unavailable' });
  }
}

/** Answers the watch while the app is running (including when the watch woke it up). */
export function startWatchSync(): () => void {
  if (!WatchBridge) return () => {};
  const sub = WatchBridge.addListener('onWatchRequest', ({ id, body }) => {
    const req = parseWatchRequest(body);
    if (!req) {
      if (id) WatchBridge!.reply(id, { error: 'unknown-request' });
      return;
    }
    if (req.type === 'refresh') {
      void syncWatch(null, { force: true }).finally(() => id && WatchBridge!.reply(id, { ok: '1' }));
      return;
    }
    void sendSnapshot(req.key, req.size, id || undefined);
  });
  const appState = AppState.addEventListener('change', (s) => {
    if (s === 'active') void syncWatch(known.size ? [...known.values()] : null);
  });
  return () => {
    sub.remove();
    appState.remove();
  };
}

import { File, Paths } from 'expo-file-system';
import type * as Notifications from 'expo-notifications';
import { AppState } from 'react-native';

import {
  cameraUrl,
  doorbellUrl,
  ENDED_LINGER_SEC,
  EVENT_MAX_SEC,
  eventKey,
  RING_HEADLINE,
  RING_MAX_SEC,
  ringKey,
  safeName,
  splitAlertTitle,
} from '@/alerts/live-activity-format';
import { useLinks } from '@/net/connection';
import { useApp } from '@/state/store';
import { getAdapter } from '@/systems/registry';
import type { CameraSystemAdapter } from '@/systems/types';
import { LiveActivity, type ActivityState } from '@modules/live-activity';

/**
 * "Show on Lock Screen": a doorbell ring or an ongoing camera event as a Live Activity
 * (Lock Screen + Dynamic Island, layout in targets/widget/LiveActivity.swift).
 *
 * Started on the phone only. Expo's push service can't deliver ActivityKit pushes and there
 * is no Sightline cloud server, so Instant Alerts can't start one remotely: activities start
 * when the app sees a ring/event itself (open, or a background check) or receives an alert
 * while running. iOS only lets the app start one while it's in the foreground; attempts from
 * a background check fail quietly. Each activity ends itself after a few minutes.
 */
const TRACK_MS = 20_000;
const IMAGE_MAX_SIDE = 240;

interface Ring {
  systemId: string;
  cameraId: string;
  at?: string;
  reviewId?: string;
}

function enabled(): boolean {
  if (!LiveActivity || useApp.getState().alerts.lockScreen === false) return false;
  try {
    return LiveActivity.isEnabled();
  } catch {
    return false;
  }
}

function adapterFor(systemId: string): CameraSystemAdapter | null {
  const system = useApp.getState().systems.find((s) => s.id === systemId);
  if (!system) return null;
  try {
    return getAdapter(system, useLinks.getState().links[systemId]);
  } catch {
    return null;
  }
}

async function cameraName(adapter: CameraSystemAdapter | null, cameraId: string): Promise<string> {
  const cams = await adapter?.listCameras().catch(() => null);
  return cams?.find((c) => c.id === cameraId)?.name ?? cameraId;
}

/** Downloads a snapshot and stores a small JPEG copy in the App Group for the activity. */
async function saveSnapshot(adapter: CameraSystemAdapter | null, cameraId: string, key: string, url?: string): Promise<string | null> {
  if (!LiveActivity) return null;
  const src = url ?? adapter?.snapshot(cameraId, { height: 360 }).uri;
  if (!src) return null;
  try {
    const tmp = new File(Paths.cache, `live-${safeName(key)}.jpg`);
    if (tmp.exists) tmp.delete();
    const file = await File.downloadFileAsync(src.replace('latest.webp', 'latest.jpg'), tmp);
    return await LiveActivity.saveImage(file.uri, `live/${safeName(key)}-${Date.now()}.jpg`, IMAGE_MAX_SIDE);
  } catch {
    return null;
  }
}

/** Doorbell ring: "Someone's at the door · Front Door" with a Watch button. */
export async function showRing(ring: Ring, opts: { camera?: string; adapter?: CameraSystemAdapter | null; snapshotUrl?: string } = {}) {
  if (!enabled()) return;
  const key = ringKey(ring);
  const adapter = opts.adapter ?? adapterFor(ring.systemId);
  try {
    const [camera, image] = await Promise.all([
      opts.camera ? Promise.resolve(opts.camera) : cameraName(adapter, ring.cameraId),
      saveSnapshot(adapter, ring.cameraId, key, opts.snapshotUrl),
    ]);
    await LiveActivity!.start({
      kind: 'doorbell',
      key,
      camera,
      url: doorbellUrl(ring),
      state: { headline: RING_HEADLINE, image, since: Number(ring.at) || Math.floor(Date.now() / 1000), ended: false },
      maxSeconds: RING_MAX_SEC,
    });
  } catch {
    // Not allowed right now (app in the background) or turned off in iOS Settings.
  }
}

export interface EventInfo {
  systemId: string;
  cameraId: string;
  reviewId?: string;
  /** What was seen, e.g. "Person". */
  headline: string;
  camera?: string;
  /** Unix seconds the event began. */
  since: number;
  snapshotUrl?: string;
}

/** Ongoing event on a camera: what was seen, elapsed time, latest snapshot. */
export async function showEvent(ev: EventInfo, adapter?: CameraSystemAdapter | null) {
  if (!enabled()) return;
  const key = eventKey(ev.systemId, ev.cameraId);
  const a = adapter ?? adapterFor(ev.systemId);
  try {
    const [camera, image] = await Promise.all([
      ev.camera ? Promise.resolve(ev.camera) : cameraName(a, ev.cameraId),
      saveSnapshot(a, ev.cameraId, key, ev.snapshotUrl),
    ]);
    const state: ActivityState = { headline: ev.headline, image, since: ev.since, ended: false };
    const id = await LiveActivity!.start({
      kind: 'event',
      key,
      camera,
      url: cameraUrl(ev.systemId, ev.cameraId),
      state,
      maxSeconds: EVENT_MAX_SEC,
    });
    track(id, key, ev, state);
  } catch {
    // Not allowed right now (app in the background) or turned off in iOS Settings.
  }
}

/** Removes a camera's event activity (the event is over). */
export async function endEvent(systemId: string, cameraId: string) {
  if (!LiveActivity) return;
  const key = eventKey(systemId, cameraId);
  stopTracking(key);
  try {
    for (const a of LiveActivity.list()) if (a.key === key) await LiveActivity.end(a.id, null, 0);
  } catch {}
}

const trackers = new Map<string, ReturnType<typeof setInterval>>();

function stopTracking(key: string) {
  const t = trackers.get(key);
  if (t) clearInterval(t);
  trackers.delete(key);
}

/** While the app runs: refresh the picture and notice when the event is over. */
function track(id: string, key: string, ev: EventInfo, base: ActivityState) {
  stopTracking(key);
  const until = Date.now() + EVENT_MAX_SEC * 1000;
  let busy = false;
  let state = base;
  const timer = setInterval(() => {
    if (busy) return;
    if (Date.now() > until || !LiveActivity) return stopTracking(key);
    busy = true;
    void (async () => {
      try {
        const adapter = adapterFor(ev.systemId);
        if (!adapter) return;
        let ended = false;
        if (ev.reviewId && adapter.listReview) {
          const items = await adapter.listReview({ after: ev.since - 60, limit: 50 }).catch(() => []);
          ended = items.some((i) => i.id === ev.reviewId && i.endTime != null);
        }
        const image = (await saveSnapshot(adapter, ev.cameraId, key)) ?? state.image;
        state = { ...state, image, ended };
        if (ended) {
          stopTracking(key);
          await LiveActivity!.end(id, state, ENDED_LINGER_SEC);
        } else {
          await LiveActivity!.update(id, state);
        }
      } catch {
        // Try again next round.
      } finally {
        busy = false;
      }
    })();
  }, TRACK_MS);
  trackers.set(key, timer);
}

/**
 * An alert notification arrived while the app is running (built-in or Instant Alerts).
 * `ring` is set for doorbell rings.
 */
export function showFromNotification(content: Notifications.NotificationContent, ring: Ring | null) {
  const data = (content.data ?? {}) as Partial<Record<string, string>>;
  if (!data.systemId || !data.cameraId) return;
  const { headline, camera } = splitAlertTitle(content.title ?? '');
  if (ring) {
    void showRing(ring, { camera: camera || undefined });
    return;
  }
  // Camera alerts only; health, package and reminder notifications aren't "ongoing".
  if (data.kind || !data.reviewId) return;
  const since = data.start ? Number(data.start) + 5 : Math.floor(Date.now() / 1000);
  void showEvent({ systemId: data.systemId, cameraId: data.cameraId, reviewId: data.reviewId, headline: headline || 'Activity', camera: camera || undefined, since });
}

/** Tidies up activities whose time ran out while the app was suspended, and honors the toggle. */
export function startLiveActivities(): () => void {
  if (!LiveActivity) return () => {};
  const tidy = () => void LiveActivity!.endStale().catch(() => {});
  tidy();
  const sub = AppState.addEventListener('change', (s) => {
    if (s === 'active') tidy();
  });
  const unsub = useApp.subscribe((st, prev) => {
    if (st.alerts.lockScreen === prev.alerts.lockScreen || st.alerts.lockScreen !== false) return;
    for (const key of [...trackers.keys()]) stopTracking(key);
    void LiveActivity!.endAll().catch(() => {});
  });
  return () => {
    sub.remove();
    unsub();
  };
}

import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { AppState } from 'react-native';

import { showFromNotification, showRing } from '@/alerts/live-activity';
import { isDoorbellCamera, isFreshRing, RING_FRESH_SEC, selectNotifications } from '@/alerts/rules';
import { useLinks } from '@/net/connection';
import { useApp } from '@/state/store';
import { getAdapter } from '@/systems/registry';
import type { CameraSystemAdapter } from '@/systems/types';

/**
 * Doorbell rings, from any system: adapters report a ring as an event whose objects include
 * 'doorbell'. A ring can arrive three ways and all of them end at the same full-screen
 * "Someone's at the door" screen (app/doorbell.tsx):
 * - a built-in background check posts a time-sensitive notification (background.ts),
 * - Instant Alerts push one from the bridge (bridge/engine.go, same category),
 * - or the app is open and notices it by polling (startDoorbellWatch below).
 */
export const DOORBELL_CATEGORY = 'doorbell-ring';
export const ACTION_WATCH = 'doorbell-watch';
const POLL_MS = 8000;
const DOORBELL_RECHECK_MS = 10 * 60_000;

export function registerDoorbellCategory() {
  void Notifications.setNotificationCategoryAsync(DOORBELL_CATEGORY, [
    { identifier: ACTION_WATCH, buttonTitle: 'Watch', options: { opensAppToForeground: true } },
  ]).catch(() => {});
}

export interface RingParams {
  systemId: string;
  cameraId: string;
  /** Unix seconds of the ring. */
  at?: string;
  reviewId?: string;
}

const shown = new Set<string>();
/** Rings already put on the Lock Screen by the in-app poll. */
const liveShown = new Set<string>();
let screenOpen = false;

/** The call screen reports when it's up so a second ring doesn't stack another one. */
export function setDoorbellScreenOpen(open: boolean) {
  screenOpen = open;
}

/** Opens the call screen once per ring. `force` re-opens it for an explicit notification tap. */
export function openDoorbell(p: RingParams, force = false) {
  const id = p.reviewId || `${p.systemId}:${p.cameraId}:${p.at ?? ''}`;
  if (!force && (shown.has(id) || screenOpen)) return;
  shown.add(id);
  if (screenOpen) {
    router.setParams({ ...p });
    return;
  }
  router.push({ pathname: '/doorbell', params: { ...p } });
}

export function isRingNotification(n: Notifications.Notification): boolean {
  const c = n.request.content;
  return c.categoryIdentifier === DOORBELL_CATEGORY || (c.data as Record<string, unknown> | undefined)?.kind === 'doorbell';
}

export function ringParamsFrom(data: Partial<Record<string, string>>): RingParams | null {
  if (!data.systemId || !data.cameraId) return null;
  // Alert notifications carry `start` 5 s before the event for playback; the ring is +5.
  const at = data.at ?? (data.start ? String(Number(data.start) + 5) : undefined);
  return { systemId: data.systemId, cameraId: data.cameraId, at, reviewId: data.reviewId };
}

/**
 * While the app is open: rings pushed to this phone open the call screen right away, and
 * every few seconds systems that report events are checked for a fresh ring.
 */
export function startDoorbellWatch(): () => void {
  const received = Notifications.addNotificationReceivedListener((n) => {
    const ring = isRingNotification(n);
    const p = ring ? ringParamsFrom(n.request.content.data as Partial<Record<string, string>>) : null;
    // Lock Screen / Dynamic Island, for rings and camera events alike.
    showFromNotification(n.request.content, p);
    if (p && useApp.getState().alerts.doorbell.fullScreen) openDoorbell(p);
  });

  let timer: ReturnType<typeof setInterval> | null = null;
  let busy = false;
  // Whether each system has a doorbell camera, re-checked now and then (cameras get added).
  const doorbells = new Map<string, { has: boolean; at: number }>();
  const hasDoorbell = async (systemId: string, adapter: CameraSystemAdapter) => {
    const known = doorbells.get(systemId);
    if (known && Date.now() - known.at < DOORBELL_RECHECK_MS) return known.has;
    const cams = await adapter.listCameras().catch(() => null);
    if (!cams) return known?.has ?? false;
    const has = cams.some(isDoorbellCamera);
    doorbells.set(systemId, { has, at: Date.now() });
    return has;
  };
  const poll = async () => {
    if (busy) return;
    const { systems, alerts } = useApp.getState();
    if (!alerts.doorbell.fullScreen && !alerts.lockScreen) return;
    busy = true;
    try {
      const now = Date.now() / 1000;
      const links = useLinks.getState().links;
      for (const s of systems) {
        const link = links[s.id];
        if (link?.mode !== 'lan' && link?.mode !== 'tunnel') continue;
        const adapter = getAdapter(s, link);
        if (!adapter?.listReview || !adapter.capabilities.events) continue;
        // Asking every recorder for events every few seconds is wasted work without a doorbell.
        if (!(await hasDoorbell(s.id, adapter))) continue;
        const items = await adapter.listReview({ after: now - RING_FRESH_SEC, limit: 20 }).catch(() => []);
        const rings = selectNotifications(items.filter((i) => isFreshRing(i, now)), alerts, {});
        const ring = rings[rings.length - 1];
        if (!ring) continue;
        const p = { systemId: ring.systemId, cameraId: ring.cameraId, at: String(Math.floor(ring.startTime)), reviewId: ring.id };
        if (!liveShown.has(ring.id)) {
          liveShown.add(ring.id);
          void showRing(p, { adapter, snapshotUrl: ring.thumbnailUrl });
        }
        if (alerts.doorbell.fullScreen) openDoorbell(p);
      }
    } finally {
      busy = false;
    }
  };
  const start = () => {
    if (!timer) timer = setInterval(() => void poll(), POLL_MS);
  };
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  if (AppState.currentState === 'active') start();
  const sub = AppState.addEventListener('change', (s) => (s === 'active' ? start() : stop()));

  return () => {
    stop();
    sub.remove();
    received.remove();
  };
}

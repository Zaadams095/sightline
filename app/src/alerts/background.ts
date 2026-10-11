import * as BackgroundTask from 'expo-background-task';
import { File, Paths } from 'expo-file-system';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import * as TaskManager from 'expo-task-manager';

import { ACTION_WATCH, DOORBELL_CATEGORY, openDoorbell, registerDoorbellCategory, ringParamsFrom } from '@/alerts/doorbell';
import { endEvent, showEvent, showRing } from '@/alerts/live-activity';
import { isMasked } from '@/alerts/masks';
import {
  ACTION_GOT_IT,
  packageHandled,
  packageRecheckAfter,
  packageRecheckFilter,
  registerPackageCategory,
  trackPackages,
} from '@/alerts/packages-notify';
import { isDoorbell, nextTimeOfDay, notificationTitle, selectNotifications } from '@/alerts/rules';
import { checkCheckinsBuiltIn, handleCheckinResponse } from '@/alerts/checkins-run';
import { FEEDBACK_ACTIONS, featureData, filterSmart, handleSmartResponse, registerLearnedCategory } from '@/alerts/smart';
import { useSmart } from '@/state/smart';
import { connectSystem, type SystemLink } from '@/net/connection';
import { useApp } from '@/state/store';
import { getAdapter } from '@/systems/registry';
import type { CameraSystemAdapter, ReviewItem, SystemConfig } from '@/systems/types';
import { titleFor } from '@/util/format';
import { recordLastAlert, syncWidgets } from '@/widgets/sync';
import { syncWatch } from '@/watch/sync';
import type { CameraEntry } from '@/systems/registry';

/**
 * Built-in alerts (no server). iOS decides when this runs — typically every 15 min to a
 * few hours — so these are "catch-up" alerts. Instant Alerts use the optional bridge.
 */
export const ALERT_TASK = 'sightline-alert-check';
const MAX_PER_RUN = 5;
/** Category for camera alerts; the bridge sends the same id so actions work on Instant Alerts too. */
export const ALERT_CATEGORY = 'camera-alert';
const ACTION_SNOOZE_HOUR = 'snooze-1h';
const ACTION_SNOOZE_MORNING = 'snooze-morning';
const handledResponses = new Set<string>();

export function setupNotificationHandling() {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });

  // Long-press actions. Snoozing runs in the background without opening the app.
  void Notifications.setNotificationCategoryAsync(ALERT_CATEGORY, [
    { identifier: ACTION_SNOOZE_HOUR, buttonTitle: 'Snooze this camera for 1 hour', options: { opensAppToForeground: false } },
    { identifier: ACTION_SNOOZE_MORNING, buttonTitle: 'Snooze this camera until 7 AM', options: { opensAppToForeground: false } },
    // "Not important" / "Always tell me about this" teach Sightline (smart.ts).
    ...FEEDBACK_ACTIONS,
  ]).catch(() => {});
  registerLearnedCategory();
  registerDoorbellCategory();
  registerPackageCategory();

  Notifications.addNotificationResponseReceivedListener((resp) => void handleResponse(resp));
}

/**
 * Opens the clip for a tapped notification, or applies a snooze action. Also called at startup
 * with the response that launched the app, because a cold start can miss the listener.
 */
export async function handleResponse(resp: Notifications.NotificationResponse) {
  const id = `${resp.notification.request.identifier}:${resp.actionIdentifier}`;
  if (handledResponses.has(id)) return;
  handledResponses.add(id);
  // Background actions (snooze) can launch the app without the UI: write into the saved
  // settings, not the empty defaults that would then overwrite them.
  if (!useApp.persist.hasHydrated()) await useApp.persist.rehydrate();
  // Feedback ("Not important"), what-was-learned and check-in notifications.
  if ((await handleSmartResponse(resp)) || (await handleCheckinResponse(resp))) return;

  const d = resp.notification.request.content.data as Partial<Record<string, string>>;
  if (!d.systemId || !d.cameraId) return;
  const key = `${d.systemId}:${d.cameraId}`;

  if (resp.actionIdentifier === ACTION_SNOOZE_HOUR) {
    useApp.getState().snooze(key, Math.floor(Date.now() / 1000) + 3600);
    return;
  }
  if (resp.actionIdentifier === ACTION_SNOOZE_MORNING) {
    useApp.getState().snooze(key, nextTimeOfDay(7, 0));
    return;
  }
  if (resp.actionIdentifier === ACTION_GOT_IT) {
    for (const k of (d.cameraKeys ?? key).split('|')) void packageHandled(k);
    return;
  }
  // Doorbell (built-in or Instant Alerts): the call screen, or straight to live for "Watch".
  if (d.kind === 'doorbell' || resp.notification.request.content.categoryIdentifier === DOORBELL_CATEGORY) {
    const ring = ringParamsFrom(d);
    if (ring && resp.actionIdentifier !== ACTION_WATCH && useApp.getState().alerts.doorbell.fullScreen) openDoorbell(ring, true);
    else router.push({ pathname: '/camera/[key]', params: { key, unmuted: '1' } });
    return;
  }
  // "Is the package still there?": look at the camera now.
  if (d.kind === 'package-reminder') {
    router.push({ pathname: '/camera/[key]', params: { key } });
    return;
  }
  if (d.start) {
    router.push({
      pathname: '/playback',
      params: { systemId: d.systemId, cameraId: d.cameraId, start: d.start, reviewId: d.reviewId ?? '' },
    });
  } else {
    router.push({ pathname: '/camera/[key]', params: { key } });
  }
}

/** Handles the notification that launched the app (cold start), once navigation is ready. */
export async function handleLaunchNotification() {
  const resp = await Notifications.getLastNotificationResponseAsync().catch(() => null);
  if (resp) {
    await handleResponse(resp);
    await Notifications.clearLastNotificationResponseAsync().catch(() => {});
  }
}

TaskManager.defineTask(ALERT_TASK, async () => {
  try {
    await checkForAlerts();
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

export async function registerBackgroundAlerts() {
  try {
    await register();
  } catch {
    // Unavailable in Expo Go and on some devices; the in-app inbox still works.
  }
}

async function register() {
  const { alerts } = useApp.getState();
  const status = await BackgroundTask.getStatusAsync();
  if (status !== BackgroundTask.BackgroundTaskStatus.Available) return;
  const registered = await TaskManager.isTaskRegisteredAsync(ALERT_TASK);
  // Instant Alerts users still get background catch-up as a safety net, less often.
  const minimumInterval = alerts.mode === 'instant' ? 60 : 15;
  if (registered) await BackgroundTask.unregisterTaskAsync(ALERT_TASK);
  await BackgroundTask.registerTaskAsync(ALERT_TASK, { minimumInterval });
}

export async function requestNotificationPermission(): Promise<boolean> {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  const res = await Notifications.requestPermissionsAsync({
    ios: { allowAlert: true, allowSound: true, allowBadge: false },
  });
  return res.granted;
}

/** Pull new review items from every system and post local notifications for matches. */
export async function checkForAlerts(): Promise<number> {
  await useApp.persist.rehydrate();
  await useSmart.persist.rehydrate();
  const state = useApp.getState();
  let posted = 0;

  for (const system of state.systems) {
    // Hubs that push to this phone already alert instantly; don't post them twice.
    if (system.kind === 'hub' && system.extra?.push === '1') continue;
    // One unreachable or misbehaving system must not stop alerts from the others.
    try {
      posted += await alertsFor(system, state);
    } catch {}
  }
  posted += await checkHealth().catch(() => 0);
  // Family check-ins no Hub runs (best effort: iOS decides when this runs).
  posted += await checkCheckinsBuiltIn().catch(() => 0);
  await refreshWidgetsInBackground();
  return posted;
}

/** New alerts for one system; returns how many notifications were posted. */
async function alertsFor(system: SystemConfig, state: ReturnType<typeof useApp.getState>): Promise<number> {
  const link = await connectSystem(system);
  if (link.mode !== 'lan' && link.mode !== 'tunnel') return 0;
  const adapter = getAdapter(system, link);
  if (!adapter?.listReview) return 0;
  let posted = 0;

  const since = state.lastNotified[system.id] ?? Date.now() / 1000 - 3600;
  const items = await adapter.listReview({ after: since, limit: 50 });
  const fresh = items.filter((i) => i.startTime > since);

  // Packages: new events, plus a second look at cameras with a package still out (an event
  // that was in progress last time may have finished since).
  let cameraNames: Map<string, string> | null = null;
  const nameOf = async (cameraKey: string) => {
    cameraNames ??= new Map((await adapter.listCameras().catch(() => [])).map((c) => [c.id, c.name]));
    const id = cameraKey.slice(system.id.length + 1);
    return cameraNames.get(id) ?? id;
  };
  const recheckAfter = packageRecheckAfter(system.id);
  const recheck =
    recheckAfter != null && recheckAfter < since
      ? (await adapter.listReview({ after: recheckAfter, before: since + 1, limit: 100 }).catch(() => [])).filter(packageRecheckFilter)
      : [];
  const freshIds = new Set(fresh.map((i) => i.id));
  const pkg = await trackPackages([...recheck.filter((i) => !freshIds.has(i.id)), ...fresh], nameOf);
  posted += pkg.posted;
  if (fresh.length === 0) return posted;

  const lastByCamera: Record<string, number> = {};
  // An event announced as "Package delivered" doesn't also alert as "Package".
  // Learned "not important" alerts and likely rain/wind/headlights stay quiet (smart.ts).
  const matched = selectNotifications(filterSmart(fresh.filter((i) => !pkg.deliveredIds.has(i.id)), items), state.alerts, lastByCamera);
  // Drop items whose objects stayed entirely inside the camera's alert masks.
  const unmasked: ReviewItem[] = [];
  for (const item of matched) {
    const masks = state.masks[`${item.systemId}:${item.cameraId}`];
    if (masks?.length && adapter.detectionPoints && isMasked(await adapter.detectionPoints(item).catch(() => []), masks)) continue;
    unmasked.push(item);
  }
  const selected = unmasked.slice(-MAX_PER_RUN);
  for (const item of selected) {
    const name = await nameOf(`${system.id}:${item.cameraId}`);
    const video = item.endTime && adapter.previewClip && !isDoorbell(item) ? adapter.previewClip(item).uri : undefined;
    await post(item, adapter.snapshot(item.cameraId, { height: 480 }).uri, name, video);
    await recordLastAlert(item, titleFor(item), name);
    await showOnLockScreen(item, name, adapter);
    posted++;
  }
  // Events that finished since: take their camera's Live Activity down.
  const ongoing = new Set(fresh.filter((i) => i.endTime == null).map((i) => i.cameraId));
  for (const cameraId of new Set(fresh.filter((i) => i.endTime != null).map((i) => i.cameraId))) {
    if (!ongoing.has(cameraId)) await endEvent(system.id, cameraId);
  }
  useApp.getState().setLastNotified(system.id, Math.max(...fresh.map((i) => i.startTime)));
  return posted;
}

/**
 * Rings and still-ongoing events as a Live Activity. iOS refuses to start one while the app
 * is in the background (it can still update a running one), so this mostly matters when the
 * check runs with the app open.
 */
async function showOnLockScreen(item: ReviewItem, camera: string, adapter: CameraSystemAdapter) {
  if (isDoorbell(item)) {
    const ring = { systemId: item.systemId, cameraId: item.cameraId, at: String(Math.floor(item.startTime)), reviewId: item.id };
    await showRing(ring, { camera, adapter, snapshotUrl: item.thumbnailUrl });
  } else if (item.endTime == null) {
    await showEvent(
      { systemId: item.systemId, cameraId: item.cameraId, reviewId: item.id, headline: titleFor(item), camera, since: item.startTime, snapshotUrl: item.thumbnailUrl },
      adapter,
    );
  }
}

/** Background checks are the only time widgets get new snapshots while the app is closed. */
async function refreshWidgetsInBackground() {
  const entries: CameraEntry[] = [];
  for (const system of useApp.getState().systems) {
    try {
      const link = await connectSystem(system);
      if (link.mode !== 'lan' && link.mode !== 'tunnel') continue;
      const adapter = getAdapter(system, link);
      if (!adapter) continue;
      const cams = await adapter.listCameras().catch(() => []);
      entries.push(...cams.filter((c) => c.enabled).map((camera) => ({ camera, adapter })));
    } catch {}
  }
  await syncWidgets(entries, { force: true }).catch(() => {});
  await syncWatch(entries, { force: true }).catch(() => {});
}

/**
 * Camera offline / storage nearly full / recorder unreachable. Each issue notifies once and
 * re-arms after it clears, so a dead camera doesn't buzz every check.
 */
export async function checkHealth(): Promise<number> {
  const { systems, alerts, healthAlerted } = useApp.getState();
  if (!alerts.health?.enabled) return 0;
  const active: Record<string, number> = {};
  const toPost: { key: string; title: string; body: string }[] = [];

  for (const system of systems) {
    const link = await connectSystem(system).catch((): SystemLink => ({ baseUrl: '', mode: 'offline' }));
    let adapter: CameraSystemAdapter | null = null;
    try {
      adapter = getAdapter(system, link);
    } catch {}
    if (!adapter?.health) continue;
    // Unreachable could just mean we're away without the VPN, so only judge systems we reached.
    if (link.mode !== 'lan' && link.mode !== 'tunnel') {
      // Keep existing issues for this system armed instead of re-alerting when it's back in range.
      for (const k of Object.keys(healthAlerted)) if (k.startsWith(`${system.id}:`)) active[k] = healthAlerted[k];
      continue;
    }
    try {
      const report = await adapter.health();
      const names = new Map((await adapter.listCameras().catch(() => [])).map((c) => [c.id, c.name]));
      for (const cam of report.offline) {
        toPost.push({ key: `${system.id}:offline:${cam}`, title: `${names.get(cam) ?? cam} is offline`, body: `No video from this camera on ${system.name}.` });
      }
      for (const s of report.storage) {
        if (s.usedPct >= alerts.health.storagePct) {
          toPost.push({ key: `${system.id}:storage:${s.path}`, title: `${system.name} storage is ${s.usedPct}% full`, body: `${s.freeGb} GB left. Older video will be replaced sooner than usual.` });
        }
      }
    } catch (e) {
      toPost.push({ key: `${system.id}:down`, title: `${system.name} isn't responding`, body: e instanceof Error ? e.message : String(e) });
    }
  }

  let posted = 0;
  for (const issue of toPost) {
    active[issue.key] = healthAlerted[issue.key] ?? Math.floor(Date.now() / 1000);
    if (healthAlerted[issue.key]) continue;
    await Notifications.scheduleNotificationAsync({ content: { title: issue.title, body: issue.body }, trigger: null });
    posted++;
  }
  useApp.getState().setHealthAlerted(active);
  return posted;
}

async function post(item: ReviewItem, fallbackImage: string, camera: string, videoUrl?: string) {
  const attachments: Notifications.NotificationContentAttachmentIos[] = [];
  // A finished event gets its preview clip, which plays when the notification is expanded.
  if (videoUrl) {
    try {
      const clip = await File.downloadFileAsync(videoUrl, new File(Paths.cache, `alert-${item.id}.mp4`), { idempotent: true });
      attachments.push({ identifier: `${item.id}-clip`, url: clip.uri, type: 'public.mpeg-4', typeHint: 'public.mpeg-4' } as never);
    } catch {
      // Fall back to the snapshot.
    }
  }
  const imageUrl = item.thumbnailUrl ?? fallbackImage;
  if (!attachments.length) {
    try {
      const file = await File.downloadFileAsync(imageUrl, new File(Paths.cache, `alert-${item.id}.webp`), {
        idempotent: true,
      });
      attachments.push({ identifier: item.id, url: file.uri, type: 'public.webp', typeHint: 'public.webp' } as never);
    } catch {
      // Text-only notification is fine.
    }
  }

  const ring = isDoorbell(item);
  await Notifications.scheduleNotificationAsync({
    content: {
      title: notificationTitle(item, camera, titleFor(item)),
      body: `${new Date(item.startTime * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}${
        item.zones.length ? ` in ${item.zones.join(', ')}` : ''
      }`,
      data: {
        systemId: item.systemId,
        cameraId: item.cameraId,
        start: String(Math.floor(item.startTime - 5)),
        reviewId: item.id,
        ...(ring ? { kind: 'doorbell' } : featureData(item, camera)),
      },
      attachments,
      // Rings break through Focus (Time Sensitive entitlement) and open the call screen.
      categoryIdentifier: ring ? DOORBELL_CATEGORY : ALERT_CATEGORY,
      ...(ring ? { interruptionLevel: 'timeSensitive' as const } : {}),
    },
    trigger: null,
  });
}

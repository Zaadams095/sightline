import * as BackgroundTask from 'expo-background-task';
import { File, Paths } from 'expo-file-system';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import * as TaskManager from 'expo-task-manager';

import { isMasked } from '@/alerts/masks';
import { selectNotifications } from '@/alerts/rules';
import { connectSystem } from '@/net/connection';
import { useApp } from '@/state/store';
import { getAdapter } from '@/systems/registry';
import type { ReviewItem } from '@/systems/types';
import { labelFor } from '@/util/format';

/**
 * Built-in alerts (no server). iOS decides when this runs — typically every 15 min to a
 * few hours — so these are "catch-up" alerts. Instant Alerts use the optional bridge.
 */
export const ALERT_TASK = 'sightline-alert-check';
const MAX_PER_RUN = 5;

export function setupNotificationHandling() {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });

  // Tapping a notification opens the clip at the moment it happened.
  Notifications.addNotificationResponseReceivedListener((resp) => {
    const d = resp.notification.request.content.data as Partial<Record<string, string>>;
    if (d.systemId && d.cameraId && d.start) {
      router.push({
        pathname: '/playback',
        params: { systemId: d.systemId, cameraId: d.cameraId, start: d.start, reviewId: d.reviewId ?? '' },
      });
    }
  });
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
  const state = useApp.getState();
  let posted = 0;

  for (const system of state.systems) {
    const link = await connectSystem(system);
    if (link.mode !== 'lan' && link.mode !== 'tunnel') continue;
    const adapter = getAdapter(system, link);
    if (!adapter?.listReview) continue;

    const since = state.lastNotified[system.id] ?? Date.now() / 1000 - 3600;
    const items = await adapter.listReview({ after: since, limit: 50 });
    const fresh = items.filter((i) => i.startTime > since);
    if (fresh.length === 0) continue;

    const lastByCamera: Record<string, number> = {};
    const matched = selectNotifications(fresh, state.alerts, lastByCamera);
    // Drop items whose objects stayed entirely inside the camera's alert masks.
    const unmasked: ReviewItem[] = [];
    for (const item of matched) {
      const masks = state.masks[`${item.systemId}:${item.cameraId}`];
      if (masks?.length && adapter.detectionPoints && isMasked(await adapter.detectionPoints(item).catch(() => []), masks)) continue;
      unmasked.push(item);
    }
    const selected = unmasked.slice(-MAX_PER_RUN);
    const names = new Map((await adapter.listCameras().catch(() => [])).map((c) => [c.id, c.name]));
    for (const item of selected) {
      const name = names.get(item.cameraId) ?? item.cameraId;
      const video = item.endTime && adapter.previewClip ? adapter.previewClip(item).uri : undefined;
      await post(item, adapter.snapshot(item.cameraId, { height: 480 }).uri, name, video);
      posted++;
    }
    useApp.getState().setLastNotified(system.id, Math.max(...fresh.map((i) => i.startTime)));
  }
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

  await Notifications.scheduleNotificationAsync({
    content: {
      title: `${labelFor(item.objects)} · ${camera}`,
      body: `${new Date(item.startTime * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}${
        item.zones.length ? ` in ${item.zones.join(', ')}` : ''
      }`,
      data: {
        systemId: item.systemId,
        cameraId: item.cameraId,
        start: String(Math.floor(item.startTime - 5)),
        reviewId: item.id,
      },
      attachments,
    },
    trigger: null,
  });
}

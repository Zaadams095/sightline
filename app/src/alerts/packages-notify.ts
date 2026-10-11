import { File, Paths } from 'expo-file-system';
import * as Notifications from 'expo-notifications';

import { androidImage, channelOf, showNow } from '@/alerts/channels';
import { clearPackage, reminderPlan, updatePackages, type OpenPackage } from '@/alerts/packages';
import { allowsSpecial } from '@/alerts/rules';
import { tr } from '@/i18n';
import { useApp } from '@/state/store';
import type { ReviewItem } from '@/systems/types';
import { formatClock } from '@/util/format';

/**
 * App side of package tracking: runs the pure state machine (alerts/packages.ts) on new
 * events, posts "Package delivered" / "may have been picked up", and keeps the optional
 * evening reminder scheduled while packages are still out.
 */
export const PACKAGE_CATEGORY = 'package';
export const ACTION_GOT_IT = 'package-got-it';
const REMINDER_ID = 'package-reminder';

export function registerPackageCategory() {
  void Notifications.setNotificationCategoryAsync(PACKAGE_CATEGORY, [
    { identifier: ACTION_GOT_IT, buttonTitle: tr().alerts.packages.gotIt, options: { opensAppToForeground: false } },
  ]).catch(() => {});
}

/**
 * Feeds new events from one system into package tracking. `nameOf` resolves a camera key to
 * its display name (only called when something needs announcing). Returns how many notifications
 * were posted and which events were announced as deliveries (so they don't also alert as "Package").
 */
export async function trackPackages(
  items: ReviewItem[],
  nameOf: (cameraKey: string) => Promise<string>,
): Promise<{ posted: number; deliveredIds: Set<string> }> {
  const st = useApp.getState();
  const deliveredIds = new Set<string>();
  if (!st.alerts.packages.enabled) return { posted: 0, deliveredIds };
  const { state, delivered, pickedUp } = updatePackages(st.packages, items, Math.floor(Date.now() / 1000));

  let posted = 0;
  for (const p of delivered) {
    const name = await nameOf(p.cameraKey);
    if (state[p.cameraKey]) state[p.cameraKey] = { ...state[p.cameraKey], cameraName: name };
    deliveredIds.add(p.reviewId);
    if (!allowsSpecial(st.alerts, p.cameraKey)) continue;
    await postPackage(p, tr().alerts.packages.delivered(name), tr().alerts.packages.arrivedAt(formatClock(p.since)), { pickedUp: false });
    posted++;
  }
  for (const p of pickedUp) {
    if (!allowsSpecial(st.alerts, p.cameraKey)) continue;
    const name = p.cameraName ?? (await nameOf(p.cameraKey));
    await postPackage(p, tr().alerts.packages.pickedUp(name), tr().alerts.packages.pickedUpBody, { pickedUp: true });
    posted++;
  }
  useApp.getState().setPackages(state);
  if (delivered.length || pickedUp.length) await syncPackageReminder();
  return { posted, deliveredIds };
}

/**
 * Events to look at again for cameras that still have a package out: an event that was in
 * progress at the last check (a person still at the door) is only finished now. Returns the
 * earliest start time worth re-reading for a system, or null when nothing is open there.
 */
export function packageRecheckAfter(systemId: string): number | null {
  const open = Object.values(useApp.getState().packages).filter((p) => p.systemId === systemId);
  if (!open.length) return null;
  return Math.max(Math.min(...open.map((p) => p.lastSeen)) - 60, Date.now() / 1000 - 86400);
}

/** Only re-read events on cameras with an open package, from after it arrived. */
export function packageRecheckFilter(item: ReviewItem): boolean {
  const p = useApp.getState().packages[`${item.systemId}:${item.cameraId}`];
  return !!p && item.startTime >= p.since;
}

/** "I got it" (notification action or the Review card): forget it and update the reminder. */
export async function packageHandled(cameraKey: string) {
  const st = useApp.getState();
  st.setPackages(clearPackage(st.packages, cameraKey));
  await syncPackageReminder();
}

/** The user looked at it in the app: keep tracking it, but skip the evening reminder. */
export async function packageSeen(cameraKey: string) {
  const st = useApp.getState();
  const p = st.packages[cameraKey];
  if (!p || p.noReminder) return;
  st.setPackages({ ...st.packages, [cameraKey]: { ...p, noReminder: true } });
  await syncPackageReminder();
}

/** Reschedules (or cancels) the single evening reminder from the current state. */
export async function syncPackageReminder() {
  await Notifications.cancelScheduledNotificationAsync(REMINDER_ID).catch(() => {});
  const { alerts, packages } = useApp.getState();
  if (!alerts.packages.enabled || !alerts.packages.reminder) return;
  const plan = reminderPlan(packages, alerts.packages.reminderTime, {}, new Date());
  if (!plan) return;
  const first = packages[plan.cameraKeys[0]];
  await Notifications.scheduleNotificationAsync({
    identifier: REMINDER_ID,
    content: {
      title: plan.title,
      body: plan.body,
      categoryIdentifier: PACKAGE_CATEGORY,
      data: { kind: 'package-reminder', systemId: first.systemId, cameraId: first.cameraId, cameraKeys: plan.cameraKeys.join('|') },
    },
    trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: new Date(plan.at * 1000), ...channelOf('packages') },
  }).catch(() => {});
}

async function postPackage(p: OpenPackage, title: string, body: string, { pickedUp }: { pickedUp: boolean }) {
  const attachments: Notifications.NotificationContentAttachmentIos[] = [];
  let picture: string | undefined;
  if (!pickedUp && p.thumbnailUrl) {
    try {
      const file = await File.downloadFileAsync(p.thumbnailUrl, new File(Paths.cache, `package-${p.reviewId}.webp`), { idempotent: true });
      attachments.push({ identifier: `package-${p.reviewId}`, url: file.uri, type: 'public.webp', typeHint: 'public.webp' } as never);
      picture = file.uri;
    } catch {
      // Text-only is fine.
    }
  }
  await Notifications.scheduleNotificationAsync({
    content: {
      title,
      body,
      attachments,
      // A delivery offers "I got it"; a pickup is already resolved.
      categoryIdentifier: pickedUp ? undefined : PACKAGE_CATEGORY,
      data: {
        kind: 'package',
        systemId: p.systemId,
        cameraId: p.cameraId,
        cameraKeys: p.cameraKey,
        // Delivery: the drop-off. Pickup: shortly before the person who likely took it left.
        start: String(Math.floor(pickedUp && p.personAfter ? p.personAfter - 60 : p.since - 5)),
        reviewId: p.reviewId,
        ...androidImage(picture),
      },
    },
    trigger: showNow('packages'),
  });
}

import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { Linking } from 'react-native';

import { checkinOkOnHub } from '@/alerts/bridge';
import { clockText, parseHHMM } from '@/alerts/clock';
import { dueCheckIn, nextByTime, newState, observe, okLabel, placeName, markOk, type CheckIn } from '@/alerts/checkins';
import { inQuietHours } from '@/alerts/rules';
import { connectSystem } from '@/net/connection';
import { useApp } from '@/state/store';
import { useSmart } from '@/state/smart';
import { getAdapter } from '@/systems/registry';

/**
 * App side of family check-ins (the schedule itself is in checkins.ts).
 *
 * With a Sightline Hub that pushes to this phone, the Hub runs the check-in around the clock
 * (bridge/checkins.go) and the app only registers the notification buttons. Without one, the
 * app runs the same schedule from its background checks — but iOS decides when those run, so
 * a check-in can come late. As a safety net it also pre-arms a local "couldn't confirm"
 * reminder at the deadline, which is moved to the next day as soon as activity is seen.
 */

export const CHECKIN_CATEGORY_PREFIX = 'checkin-';
const ACTION_WATCH = 'checkin-watch';
const ACTION_CALL = 'checkin-call';
const ACTION_OK = 'checkin-ok';
const PREARM_PREFIX = 'checkin-prearm-';

/** Whether a Hub (or the Instant Alerts bridge) runs this check-in rather than the phone. */
export function runsOnHub(c: Pick<CheckIn, 'systemId'>): boolean {
  const { systems, alerts } = useApp.getState();
  const s = systems.find((x) => x.id === c.systemId);
  if (!s) return false;
  if (s.kind === 'hub') return s.extra?.push === '1';
  return s.kind === 'frigate' && alerts.mode === 'instant' && !!alerts.bridge;
}

const camName = (c: CheckIn, id?: string) => (id && c.cameraNames?.[id]) || id || 'camera';

/** One notification category per check-in: "Watch Kitchen" / "Call Mom" / "Mom's fine". */
export async function registerCheckinCategories() {
  for (const c of useSmart.getState().checkins) {
    const actions: Notifications.NotificationAction[] = [
      { identifier: ACTION_WATCH, buttonTitle: `Watch ${camName(c, c.cameras[0])}`, options: { opensAppToForeground: true } },
    ];
    if (c.phone?.trim()) actions.push({ identifier: ACTION_CALL, buttonTitle: `Call ${c.who.trim() || placeName(c)}`, options: { opensAppToForeground: true } });
    actions.push({ identifier: ACTION_OK, buttonTitle: okLabel(c), options: { opensAppToForeground: false } });
    await Notifications.setNotificationCategoryAsync(`${CHECKIN_CATEGORY_PREFIX}${c.id}`, actions).catch(() => {});
  }
}

/** Re-registers buttons whenever check-ins change (names, phone numbers). */
export function watchCheckinCategories(): () => void {
  void registerCheckinCategories();
  return useSmart.subscribe((s, prev) => {
    if (s.checkins !== prev.checkins) void registerCheckinCategories().then(() => rearmAll());
  });
}

/** Check-in notification taps and buttons. Returns true when handled. */
export async function handleCheckinResponse(resp: Notifications.NotificationResponse): Promise<boolean> {
  const d = resp.notification.request.content.data as Partial<Record<string, string>>;
  if (d.kind !== 'checkin' || !d.checkinId) return false;
  if (!useSmart.persist.hasHydrated()) await useSmart.persist.rehydrate();
  const c = useSmart.getState().checkins.find((x) => x.id === d.checkinId);
  const cameraId = d.cameraId || c?.cameras[0];
  const systemId = d.systemId || c?.systemId;
  switch (resp.actionIdentifier) {
    case ACTION_OK:
      if (c) await markCheckinOk(c);
      return true;
    case ACTION_CALL:
      if (c?.phone) await Linking.openURL(`tel:${c.phone.replace(/[^\d+]/g, '')}`).catch(() => {});
      return true;
    default:
      if (systemId && cameraId) router.push({ pathname: '/camera/[key]', params: { key: `${systemId}:${cameraId}` } });
      return true;
  }
}

/** "Mom's fine": quiets no-activity notices for today, here and on the Hub. */
export async function markCheckinOk(c: CheckIn) {
  const now = Date.now() / 1000;
  const st = useSmart.getState().checkinStates[c.id] ?? newState(now);
  useSmart.getState().setCheckinState(c.id, markOk(st, now));
  if (runsOnHub(c)) await checkinOkOnHub(c.systemId, c.id).catch(() => {});
  await rearm(c);
}

/**
 * Built-in fallback, from background checks: reads today's (and recent) events for each
 * check-in that no Hub runs, and posts what's due. Returns how many notifications it posted.
 */
export async function checkCheckinsBuiltIn(): Promise<number> {
  await useSmart.persist.rehydrate();
  const { checkins } = useSmart.getState();
  const quietHours = useApp.getState().alerts.quietHours;
  let posted = 0;
  for (const c of checkins) {
    if (!c.enabled || runsOnHub(c)) continue;
    const system = useApp.getState().systems.find((s) => s.id === c.systemId);
    if (!system) continue;
    const now = Date.now() / 1000;
    let st = useSmart.getState().checkinStates[c.id] ?? newState(now);
    try {
      const link = await connectSystem(system);
      const adapter = getAdapter(system, link);
      if ((link.mode === 'lan' || link.mode === 'tunnel') && adapter?.listReview) {
        const after = now - 2 * 86400;
        const items = await adapter.listReview({ after, cameras: c.cameras, limit: 300 });
        for (const i of items) {
          st = observe(c, st, { id: i.id, camera: i.cameraId, start: i.startTime, end: i.endTime, objects: i.objects, zones: i.zones }, now);
        }
        // The recorder's own list covers the last two days: today counts as watched.
        st = { ...st, watchingSince: Math.min(st.watchingSince, after) };
      }
    } catch {
      // Can't reach it now: the pre-armed reminder still speaks at the deadline.
    }
    const due = dueCheckIn(c, st, now, inQuietHours(quietHours));
    for (const n of due.notices) {
      await Notifications.scheduleNotificationAsync({
        content: {
          title: n.title,
          body: n.body,
          data: { kind: 'checkin', checkinId: c.id, systemId: c.systemId, cameraId: due.state.lastCamera ?? c.cameras[0], notice: n.kind },
          categoryIdentifier: `${CHECKIN_CATEGORY_PREFIX}${c.id}`,
          ...(n.kind !== 'summary' && c.duringQuietHours ? { interruptionLevel: 'timeSensitive' as const } : {}),
        },
        trigger: null,
      }).catch(() => {});
      posted++;
    }
    useSmart.getState().setCheckinState(c.id, due.state);
    await rearm(c);
  }
  return posted;
}

/**
 * The pre-armed "couldn't confirm" reminder for the next deadline (built-in check-ins only).
 * Moved to tomorrow once today's activity has been seen or someone said she's fine.
 */
async function rearm(c: CheckIn) {
  const id = `${PREARM_PREFIX}${c.id}`;
  await Notifications.cancelScheduledNotificationAsync(id).catch(() => {});
  if (!c.enabled || runsOnHub(c) || !c.byTime) return;
  const at = nextByTime(c, useSmart.getState().checkinStates[c.id], Date.now() / 1000);
  if (!at) return;
  const place = placeName(c);
  await Notifications.scheduleNotificationAsync({
    identifier: id,
    content: {
      title: `Couldn’t confirm activity at ${place} yet`,
      body: `Sightline couldn’t reach the cameras at ${place} to check by ${clockText(...parseHHMM(c.byTime))}. Tap to look. Without a Sightline Hub, check-ins can be late.`,
      data: { kind: 'checkin', checkinId: c.id, systemId: c.systemId, cameraId: c.cameras[0] ?? '', notice: 'unconfirmed' },
      categoryIdentifier: `${CHECKIN_CATEGORY_PREFIX}${c.id}`,
    },
    trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: new Date(at * 1000) },
  }).catch(() => {});
}

async function rearmAll() {
  for (const c of useSmart.getState().checkins) await rearm(c);
  // Drop reminders for check-ins that were deleted.
  const ids = new Set(useSmart.getState().checkins.map((c) => `${PREARM_PREFIX}${c.id}`));
  const scheduled = await Notifications.getAllScheduledNotificationsAsync().catch(() => []);
  for (const n of scheduled) {
    if (n.identifier.startsWith(PREARM_PREFIX) && !ids.has(n.identifier)) await Notifications.cancelScheduledNotificationAsync(n.identifier).catch(() => {});
  }
}

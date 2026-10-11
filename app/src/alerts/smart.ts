import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';

import type { SunPlace } from '@/alerts/clock';
import {
  featuresOf,
  isMotionOnly,
  learnRules,
  newlyLearned,
  ruleExplanation,
  smartQuiet,
  type Feedback,
  type LearnedRule,
  type Verdict,
} from '@/alerts/learning';
import { showNow } from '@/alerts/channels';
import { splitAlertTitle } from '@/alerts/live-activity-format';
import { tr } from '@/i18n';
import { useApp } from '@/state/store';
import { useSmart } from '@/state/smart';
import type { ReviewItem } from '@/systems/types';

/**
 * App glue for "fewer false alarms that learn" (the model itself is in learning.ts): feedback
 * from notifications and the Recordings list, filtering built-in alerts, and what the Hub needs.
 */

export const ACTION_NOT_IMPORTANT = 'not-important';
export const ACTION_ALWAYS = 'always-tell-me';
export const LEARNED_CATEGORY = 'sightline-learned';
const ACTION_LEARNED_UNDO = 'learned-undo';
const ACTION_LEARNED_CONFIRM = 'learned-confirm';

/** Long-press actions added to the camera alert category (Instant Alerts use it too). */
export const FEEDBACK_ACTIONS: Notifications.NotificationAction[] = [
  {
    identifier: ACTION_NOT_IMPORTANT,
    get buttonTitle() {
      return tr().alerts.learned.notImportant;
    },
    options: { opensAppToForeground: false },
  },
  {
    identifier: ACTION_ALWAYS,
    get buttonTitle() {
      return tr().alerts.learned.alwaysTell;
    },
    options: { opensAppToForeground: false },
  },
];

export function registerLearnedCategory() {
  void Notifications.setNotificationCategoryAsync(LEARNED_CATEGORY, [
    { identifier: ACTION_LEARNED_UNDO, buttonTitle: tr().alerts.learned.undo, options: { opensAppToForeground: false, isDestructive: true } },
  ]).catch(() => {});
  void Notifications.setNotificationCategoryAsync(`${LEARNED_CATEGORY}-confirm`, [
    { identifier: ACTION_LEARNED_CONFIRM, buttonTitle: tr().alerts.learned.stopAlerting, options: { opensAppToForeground: false } },
    { identifier: ACTION_LEARNED_UNDO, buttonTitle: tr().alerts.learned.keepAlerting, options: { opensAppToForeground: false } },
  ]).catch(() => {});
}

export const deviceTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Home location from Home & Away, rounded to ~10 km: enough for sunrise and sunset. */
export function sunPlace(): SunPlace | null {
  const home = useApp.getState().alerts.presence.home;
  if (!home) return null;
  return { lat: Math.round(home.latitude * 10) / 10, lon: Math.round(home.longitude * 10) / 10 };
}

export function currentRules(now = Date.now() / 1000): LearnedRule[] {
  return learnRules(useSmart.getState().learning, now);
}

interface FeedbackTarget {
  systemId: string;
  cameraId: string;
  id: string;
  objects: string[];
  zones: string[];
  subLabels?: string[];
  severity: string;
  startTime: number;
  endTime?: number | null;
}

/**
 * Records "Not important" / "Always tell me" for an alert. Returns the rule this created, if
 * any, so the caller can say what Sightline will do from now on (with Undo).
 */
export function recordFeedback(t: FeedbackTarget, verdict: Verdict): LearnedRule | null {
  const now = Date.now() / 1000;
  const before = currentRules(now);
  const f: Feedback = {
    ...featuresOf(
      { camera: `${t.systemId}:${t.cameraId}`, objects: t.objects, zones: t.zones, subLabels: t.subLabels, severity: t.severity, start: t.startTime, end: t.endTime },
      deviceTimezone(),
      sunPlace(),
    ),
    id: t.id,
    at: now,
    verdict,
  };
  useSmart.getState().addFeedback(f);
  return newlyLearned(before, currentRules(now));
}

/** The opinion already given on an event (for the thumbs in the Recordings list). */
export function verdictFor(systemId: string, eventId: string): Verdict | null {
  const f = useSmart.getState().learning.feedback.find((x) => x.id === eventId && x.camera.startsWith(`${systemId}:`));
  return f?.verdict ?? null;
}

/**
 * Built-in alerts: drops items that learned rules or the rain/wind/headlights check quiet.
 * `all` is every recent item (not just the candidates), to spot several cameras at once.
 */
export function filterSmart(candidates: ReviewItem[], all: ReviewItem[]): ReviewItem[] {
  const { conditions } = useSmart.getState();
  const rules = currentRules();
  if (!conditions && rules.length === 0) return candidates;
  const tz = deviceTimezone();
  const sun = sunPlace();
  const recent = all.map((i) => ({ camera: `${i.systemId}:${i.cameraId}`, start: i.startTime, motionOnly: isMotionOnly(i.objects) }));
  return candidates.filter((i) => {
    const camera = `${i.systemId}:${i.cameraId}`;
    const f = featuresOf({ camera, objects: i.objects, zones: i.zones, subLabels: i.subLabels, severity: i.severity, start: i.startTime, end: i.endTime }, tz, sun);
    const others = recent.filter((r) => !(r.camera === camera && r.start === i.startTime));
    return smartQuiet({ ...f, start: i.startTime }, rules, { conditions }, others) == null;
  });
}

/** Extra notification data so "Not important" works from the notification itself. */
export function featureData(item: ReviewItem, cameraName: string): Record<string, string> {
  return {
    objects: item.objects.join(','),
    zones: item.zones.join(','),
    subLabels: (item.subLabels ?? []).join(','),
    severity: item.severity,
    ...(item.endTime != null ? { end: String(Math.floor(item.endTime)) } : {}),
    cameraName,
  };
}

const list = (s?: string) => (s ? s.split(',').filter(Boolean) : []);

/** Says what was learned, with Undo (or, for people, asks first). */
export async function announceLearned(rule: LearnedRule, cameraName: string) {
  await Notifications.scheduleNotificationAsync({
    content: {
      title: rule.needsConfirm ? tr().alerts.learned.askTitle : tr().alerts.learned.learnedTitle,
      body: ruleExplanation(rule, cameraName),
      data: { kind: 'learned', ruleKey: rule.key },
      categoryIdentifier: rule.needsConfirm ? `${LEARNED_CATEGORY}-confirm` : LEARNED_CATEGORY,
      sound: false,
    },
    trigger: showNow('alerts'),
  }).catch(() => {});
}

/** Feedback and "learned" actions from notifications. Returns true when it handled the response. */
export async function handleSmartResponse(resp: Notifications.NotificationResponse): Promise<boolean> {
  const action = resp.actionIdentifier;
  const content = resp.notification.request.content;
  const d = content.data as Partial<Record<string, string>>;
  if (!useSmart.persist.hasHydrated()) await useSmart.persist.rehydrate();

  if (d.kind === 'learned') {
    const rule = currentRules().find((r) => r.key === d.ruleKey);
    if (action === ACTION_LEARNED_UNDO && rule) useSmart.getState().forget(rule);
    else if (action === ACTION_LEARNED_CONFIRM && d.ruleKey) useSmart.getState().confirm(d.ruleKey);
    else if (action === Notifications.DEFAULT_ACTION_IDENTIFIER) router.push('/settings/learned');
    return true;
  }
  if (action !== ACTION_NOT_IMPORTANT && action !== ACTION_ALWAYS) return false;
  if (!d.systemId || !d.cameraId) return true;
  const start = Number(d.start ?? 0) + 5; // notifications carry start − 5 s (for playback)
  const rule = recordFeedback(
    {
      systemId: d.systemId,
      cameraId: d.cameraId,
      id: d.reviewId || `${d.cameraId}:${Math.floor(start)}`,
      objects: list(d.objects),
      zones: list(d.zones),
      subLabels: list(d.subLabels),
      severity: d.severity || 'alert',
      startTime: start,
      endTime: d.end ? Number(d.end) : null,
    },
    action === ACTION_NOT_IMPORTANT ? 'not-important' : 'important',
  );
  if (rule) await announceLearned(rule, d.cameraName || splitAlertTitle(content.title ?? '').camera || d.cameraId);
  return true;
}

/** What a Hub needs for one system's learned quieting (camera keys without the system prefix). */
export function hubLearningFor(systemId: string) {
  const s = useSmart.getState();
  const prefix = `${systemId}:`;
  return {
    feedback: s.learning.feedback.filter((f) => f.camera.startsWith(prefix)).map((f) => ({ ...f, camera: f.camera.slice(prefix.length) })),
    confirmed: s.learning.confirmed.filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)),
    conditions: s.conditions,
    ...(sunPlace() ? { sun: sunPlace() } : {}),
  };
}

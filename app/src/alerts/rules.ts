import type { AlertSettings, CameraAlertRule } from '@/state/store';
import type { ReviewItem } from '@/systems/types';

/**
 * Decides whether a review item should notify. Kept pure (no RN imports) so the same
 * logic can be mirrored by the Instant Alerts bridge (bridge/engine.go).
 */
export function ruleFor(settings: AlertSettings, cameraKey: string): CameraAlertRule {
  return settings.rules[cameraKey] ?? settings.defaultRule;
}

export function matchesRule(item: ReviewItem, rule: CameraAlertRule): boolean {
  if (!rule.enabled) return false;
  if (rule.severities.length && !rule.severities.includes(item.severity)) return false;
  if (rule.objects.length && !item.objects.some((o) => rule.objects.includes(o))) return false;
  if (rule.zones.length && !item.zones.some((z) => rule.zones.includes(z))) return false;
  return true;
}

/** True when everyone recognized in the event is on the quiet list (e.g. family, own car). */
export function onlyKnown(item: ReviewItem, quietFor: string[]): boolean {
  const names = item.subLabels ?? [];
  return names.length > 0 && names.every((n) => quietFor.includes(n));
}

/** Home mode: at home, only cameras explicitly kept on (e.g. the doorbell) alert. */
export function mutedAtHome(settings: AlertSettings, cameraKey: string): boolean {
  const p = settings.presence;
  return !!p?.enabled && p.atHome && !p.alertWhenHome.includes(cameraKey);
}

export function isSnoozed(settings: AlertSettings, cameraKey: string, nowSec: number): boolean {
  return (settings.snoozed?.[cameraKey] ?? 0) > nowSec;
}

/** "HH:MM" quiet hours; supports ranges that cross midnight (e.g. 23:00–06:30). */
export function inQuietHours(q: AlertSettings['quietHours'], at: Date = new Date()): boolean {
  if (!q.enabled) return false;
  const mins = (s: string) => {
    const [h, m] = s.split(':').map(Number);
    return h * 60 + (m || 0);
  };
  const now = at.getHours() * 60 + at.getMinutes();
  const start = mins(q.start);
  const end = mins(q.end);
  return start <= end ? now >= start && now < end : now >= start || now < end;
}

/**
 * Filters new items down to the ones to notify, applying rules, snoozes, known people,
 * quiet hours, and a per-camera cooldown. `lastByCamera` is updated in place.
 */
export function selectNotifications(
  items: ReviewItem[],
  settings: AlertSettings,
  lastByCamera: Record<string, number>,
  at: Date = new Date(),
): ReviewItem[] {
  if (inQuietHours(settings.quietHours, at)) return [];
  const now = at.getTime() / 1000;
  const out: ReviewItem[] = [];
  for (const item of [...items].sort((a, b) => a.startTime - b.startTime)) {
    const key = `${item.systemId}:${item.cameraId}`;
    if (isSnoozed(settings, key, now) || mutedAtHome(settings, key)) continue;
    // A doorbell ring is someone asking for attention: it skips the object/zone/severity
    // filters, known-people quieting and the cooldown, but a camera turned off stays off.
    if (isDoorbell(item)) {
      if (ruleFor(settings, key).enabled) out.push(item);
      continue;
    }
    if (!matchesRule(item, ruleFor(settings, key))) continue;
    if (onlyKnown(item, settings.quietFor ?? [])) continue;
    const last = lastByCamera[key] ?? 0;
    if (item.startTime - last < settings.cooldownSec) continue;
    lastByCamera[key] = item.startTime;
    out.push(item);
  }
  return out;
}

/**
 * Doorbell rings arrive as events whose objects include 'doorbell' (each adapter maps its
 * brand's ring / visitor / call event to that). Packages are 'package' objects.
 */
export function isDoorbell(item: { objects: string[] }): boolean {
  return item.objects.includes('doorbell');
}

/**
 * Whether a camera can ring: adapters that know mark doorbells with a 'doorbell' object;
 * for the rest, a camera named like one ("Doorbell", "Front door bell") counts.
 */
export function isDoorbellCamera(camera: { objects: string[]; name: string }): boolean {
  return camera.objects.includes('doorbell') || /door\s*bell/i.test(camera.name);
}

export function hasPackage(item: { objects: string[] }): boolean {
  return item.objects.includes('package');
}

/**
 * For notifications that don't come from the object rules (package delivered / picked up):
 * still honors quiet hours, snoozes, Home mode and a camera's notifications being off.
 */
export function allowsSpecial(settings: AlertSettings, cameraKey: string, at: Date = new Date()): boolean {
  if (inQuietHours(settings.quietHours, at)) return false;
  if (isSnoozed(settings, cameraKey, at.getTime() / 1000) || mutedAtHome(settings, cameraKey)) return false;
  return ruleFor(settings, cameraKey).enabled;
}

/** A doorbell ring recent enough to still be worth a full-screen "call" (seconds). */
export const RING_FRESH_SEC = 120;

export function isFreshRing(item: { objects: string[]; startTime: number }, nowSec: number): boolean {
  return isDoorbell(item) && nowSec - item.startTime <= RING_FRESH_SEC && item.startTime <= nowSec + 30;
}

/** Notification title for an event; `label` is the usual "Person & Car" title. Mirrors bridge buildMessage. */
export function notificationTitle(item: { objects: string[] }, camera: string, label: string): string {
  if (isDoorbell(item)) return `Someone's at the door · ${camera}`;
  return `${label} · ${camera}`;
}

/** Next local occurrence of hh:mm, as unix seconds (for "snooze until morning"). */
export function nextTimeOfDay(hour: number, minute: number, from: Date = new Date()): number {
  const d = new Date(from);
  d.setHours(hour, minute, 0, 0);
  if (d <= from) d.setDate(d.getDate() + 1);
  return Math.floor(d.getTime() / 1000);
}

import type { AlertSettings, CameraAlertRule } from '@/state/store';
import type { ReviewItem } from '@/systems/types';

/**
 * Decides whether a review item should notify. Kept pure (no RN imports) so the same
 * logic can be mirrored by the Instant Alerts bridge.
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
 * Filters new items down to the ones to notify, applying rules, quiet hours, and a
 * per-camera cooldown. `lastByCamera` is updated in place.
 */
export function selectNotifications(
  items: ReviewItem[],
  settings: AlertSettings,
  lastByCamera: Record<string, number>,
  at: Date = new Date(),
): ReviewItem[] {
  if (inQuietHours(settings.quietHours, at)) return [];
  const out: ReviewItem[] = [];
  for (const item of [...items].sort((a, b) => a.startTime - b.startTime)) {
    const key = `${item.systemId}:${item.cameraId}`;
    if (!matchesRule(item, ruleFor(settings, key))) continue;
    const last = lastByCamera[key] ?? 0;
    if (item.startTime - last < settings.cooldownSec) continue;
    lastByCamera[key] = item.startTime;
    out.push(item);
  }
  return out;
}

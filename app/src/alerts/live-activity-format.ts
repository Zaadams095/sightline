/**
 * Pure helpers for the Lock Screen Live Activity (live-activity.ts), kept free of native
 * imports so they can be unit tested.
 */
import { tr } from '../i18n/index.ts';

/** How long a ring / an event stays on the Lock Screen if nothing ends it sooner. */
export const RING_MAX_SEC = 3 * 60;
export const EVENT_MAX_SEC = 5 * 60;
/** An ended event stays visible (marked "Ended") this long. */
export const ENDED_LINGER_SEC = 60;

/** "Someone's at the door", in the app's language. */
export const ringHeadline = () => tr().alerts.ringHeadline;

/** One activity per ring. */
export function ringKey(p: { systemId: string; cameraId: string; at?: string; reviewId?: string }): string {
  return `ring:${p.reviewId || `${p.systemId}:${p.cameraId}:${p.at ?? ''}`}`;
}

/** One activity per camera: a new event on the same camera replaces the previous one. */
export function eventKey(systemId: string, cameraId: string): string {
  return `event:${systemId}:${cameraId}`;
}

/** Opens the full-screen doorbell call screen (app/doorbell.tsx). */
export function doorbellUrl(p: { systemId: string; cameraId: string; at?: string; reviewId?: string }): string {
  const q: string[] = [`systemId=${encodeURIComponent(p.systemId)}`, `cameraId=${encodeURIComponent(p.cameraId)}`];
  if (p.at) q.push(`at=${encodeURIComponent(p.at)}`);
  if (p.reviewId) q.push(`reviewId=${encodeURIComponent(p.reviewId)}`);
  return `sightline://doorbell?${q.join('&')}`;
}

/** Live view of a camera (app/camera/[key].tsx), like the Home Screen widget's links. */
export function cameraUrl(systemId: string, cameraId: string): string {
  return `sightline://camera/${encodeURIComponent(`${systemId}:${cameraId}`)}`;
}

/**
 * Alert titles are "<what> · <camera>" (rules.ts notificationTitle, bridge/engine.go
 * buildMessage). Splits on the last separator; a title without one is all headline.
 */
export function splitAlertTitle(title: string): { headline: string; camera: string } {
  const i = title.lastIndexOf(' · ');
  if (i < 0) return { headline: title, camera: '' };
  return { headline: title.slice(0, i), camera: title.slice(i + 3) };
}

/** Safe file name part for App Group paths. */
export function safeName(key: string): string {
  return key.replace(/[^A-Za-z0-9_-]/g, '_');
}

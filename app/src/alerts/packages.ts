import type { ReviewItem } from '@/systems/types';

/**
 * Package tracking from generic events (any system whose detector reports `package` objects).
 * Pure: no React Native imports, so it's unit-tested in test/packages.test.ts.
 *
 * Honesty note: recorders differ. Frigate stops creating events for a package once it sits
 * still, and many systems never report a package leaving. So "picked up" is an inference:
 * someone was seen on that camera after the delivery and the package hasn't shown up in any
 * event since. Notifications word it as "may have been picked up".
 */

export interface OpenPackage {
  /** `${systemId}:${cameraId}` */
  cameraKey: string;
  systemId: string;
  cameraId: string;
  /** Review item that first showed the package. */
  reviewId: string;
  thumbnailUrl?: string;
  /** When it was first seen (unix seconds). */
  since: number;
  /** Last time an event showed the package. */
  lastSeen: number;
  /** A person event ended after the package was last seen (a possible pickup), unix seconds. */
  personAfter?: number;
  /** Display name, filled in by the app when it notifies. */
  cameraName?: string;
  /** The user already looked at it: no evening reminder. */
  noReminder?: boolean;
}

/** Open packages keyed by camera key (one tracked package per camera). */
export type PackageState = Record<string, OpenPackage>;

export interface PackageUpdate {
  state: PackageState;
  delivered: OpenPackage[];
  pickedUp: OpenPackage[];
}

/** How long after a person leaves, with no package seen, before we call it picked up. */
export const PICKUP_GRACE_SEC = 10 * 60;
/** Forget packages nobody resolved after this long (no notification). */
export const PACKAGE_EXPIRE_SEC = 3 * 86400;

const hasObj = (i: ReviewItem, o: string) => i.objects.includes(o);

/**
 * Applies new events to the open-package state.
 * - A `package` event on a camera with no open package → delivered.
 * - Another event showing the package → still there (cancels a possible pickup), unless a
 *   person is in it too after the delivery, which is likely someone picking it up.
 * - A finished person event after the package was last seen → possible pickup; confirmed
 *   once PICKUP_GRACE_SEC passes without the package being seen again.
 */
export function updatePackages(prev: PackageState, items: ReviewItem[], nowSec: number): PackageUpdate {
  const state: PackageState = { ...prev };
  const delivered: OpenPackage[] = [];
  const pickedUp: OpenPackage[] = [];

  for (const item of [...items].sort((a, b) => a.startTime - b.startTime)) {
    const key = `${item.systemId}:${item.cameraId}`;
    const open = state[key];
    const end = item.endTime ?? item.startTime;
    if (!open) {
      if (!hasObj(item, 'package')) continue;
      const pkg: OpenPackage = {
        cameraKey: key,
        systemId: item.systemId,
        cameraId: item.cameraId,
        reviewId: item.id,
        thumbnailUrl: item.thumbnailUrl,
        since: item.startTime,
        lastSeen: end,
      };
      state[key] = pkg;
      delivered.push(pkg);
      continue;
    }
    if (item.id === open.reviewId) {
      // The delivery event itself, seen again with a later end time.
      state[key] = { ...open, lastSeen: Math.max(open.lastSeen, end) };
      continue;
    }
    if (item.startTime < open.since) continue;
    const person = hasObj(item, 'person');
    if (hasObj(item, 'package') && !person) {
      state[key] = { ...open, lastSeen: Math.max(open.lastSeen, end), personAfter: undefined };
    } else if (person && item.endTime != null && item.endTime >= open.lastSeen) {
      state[key] = { ...open, personAfter: Math.max(open.personAfter ?? 0, item.endTime) };
    }
  }

  for (const [key, pkg] of Object.entries(state)) {
    if (pkg.personAfter != null && nowSec - pkg.personAfter >= PICKUP_GRACE_SEC) {
      pickedUp.push(pkg);
      delete state[key];
    } else if (nowSec - pkg.lastSeen > PACKAGE_EXPIRE_SEC) {
      delete state[key];
    }
  }
  // Delivered and gone again within one batch (e.g. a late background check): stay quiet.
  const gone = new Set(pickedUp.map((p) => p.reviewId));
  const fresh = new Set(delivered.map((d) => d.reviewId));
  return {
    state,
    delivered: delivered.filter((d) => !gone.has(d.reviewId)),
    pickedUp: pickedUp.filter((p) => !fresh.has(p.reviewId)),
  };
}

/** Removes a package the user dealt with ("I got it"). */
export function clearPackage(state: PackageState, cameraKey: string): PackageState {
  const next = { ...state };
  delete next[cameraKey];
  return next;
}

export interface ReminderPlan {
  /** Unix seconds to fire at. */
  at: number;
  title: string;
  body: string;
  cameraKeys: string[];
}

/**
 * The evening "a package is still outside" reminder: one notification for all open packages
 * the user hasn't already looked at, at the next `HH:MM` after the newest delivery (so a package that
 * arrives after the reminder time is mentioned the next evening).
 */
export function reminderPlan(
  state: PackageState,
  time: string,
  names: Record<string, string>,
  now: Date,
): ReminderPlan | null {
  const open = Object.values(state)
    .filter((p) => !p.noReminder)
    .sort((a, b) => a.since - b.since);
  if (!open.length) return null;
  const [h, m] = time.split(':').map(Number);
  if (!Number.isFinite(h)) return null;
  const at = new Date(now);
  at.setHours(h, Number.isFinite(m) ? m : 0, 0, 0);
  if (at <= now) at.setDate(at.getDate() + 1);

  const places = [...new Set(open.map((p) => names[p.cameraKey] ?? p.cameraName ?? p.cameraId))];
  const where = places.length <= 2 ? places.join(' and ') : `${places.slice(0, -1).join(', ')} and ${places[places.length - 1]}`;
  return {
    at: Math.floor(at.getTime() / 1000),
    title: open.length === 1 ? `A package is still at ${where}` : `${open.length} packages are still outside`,
    body: open.length === 1 ? 'It was delivered earlier and hasn’t been picked up.' : `At ${where}.`,
    cameraKeys: open.map((p) => p.cameraKey),
  };
}

import { atTimeOfDay, clockText, dayKey, whenText, zoned } from './clock.ts';

/**
 * Family check-ins ("Let me know if there's no activity at Mom's by 10 AM"). Pure (no RN
 * imports) and mirrored by the Hub (bridge/checkins.go), which is the reliable path: it keeps
 * watching around the clock and survives restarts. The app runs the same schedule from its
 * background checks as a best-effort fallback when there's no Hub.
 *
 * Wording is gentle and specific: what we expected, what we saw last, and what to do.
 */

export interface CheckIn {
  id: string;
  enabled: boolean;
  /** Who lives there, as the user calls them: "Mom". Used for "Mom's" and "Call Mom". */
  who: string;
  /** Fallback place name when `who` is empty (usually the system's name). */
  place?: string;
  systemId: string;
  /** Camera IDs within the system that show normal life (Kitchen, Hallway). */
  cameras: string[];
  /** Per camera, only these zones count (missing/empty = the whole picture). */
  zones: Record<string, string[]>;
  /** Only people count (otherwise any motion does; pets may then count as activity). */
  peopleOnly: boolean;
  /** "10:00": tell me if there's been no activity by then. null = off. */
  byTime: string | null;
  /** Tell me if there's no activity for this many hours between dayStart and dayEnd. null = off. */
  quietLimitHours: number | null;
  dayStart: string;
  dayEnd: string;
  /** "20:00": a daily "All normal at Mom's" summary. null = off. */
  summaryTime: string | null;
  /** Shown as "Call Mom" on the notification. */
  phone?: string;
  /** IANA time zone the times above are in (normally the one at their house). */
  timezone: string;
  /** Check-ins still come through during my quiet hours (default), with normal sound. */
  duringQuietHours: boolean;
  /** Display names for the cameras (wording without a lookup). */
  cameraNames?: Record<string, string>;
}

export interface CheckInState {
  /** When watching began; "no activity yet today" is only claimed for days watched from midnight. */
  watchingSince: number;
  /** Calendar day (in the check-in's zone) the counts below are for. */
  day?: string;
  firstToday?: number;
  momentsToday: number;
  todayIds?: string[];
  lastActivity?: number;
  lastCamera?: string;
  /** "Mom's fine": quiets no-activity notices for the rest of the day / this quiet spell. */
  okAt?: number;
  firedByTime?: string;
  firedQuietFor?: number;
  summarySent?: string;
}

export interface ActivityEvent {
  id: string;
  camera: string;
  start: number;
  end?: number | null;
  objects: string[];
  zones: string[];
}

export type NoticeKind = 'by-time' | 'quiet' | 'summary';

export interface CheckInNotice {
  kind: NoticeKind;
  title: string;
  body: string;
}

export const DEFAULT_CHECKIN: Omit<CheckIn, 'id' | 'systemId' | 'timezone'> = {
  enabled: true,
  who: '',
  cameras: [],
  zones: {},
  peopleOnly: false,
  byTime: '10:00',
  quietLimitHours: null,
  dayStart: '08:00',
  dayEnd: '21:00',
  summaryTime: null,
  duringQuietHours: true,
};

export function newState(now: number): CheckInState {
  return { watchingSince: now, momentsToday: 0 };
}

/** Whether an event is "normal life" for this check-in. Doorbell rings are visitors, not her. */
export function counts(c: CheckIn, e: ActivityEvent): boolean {
  if (!c.cameras.includes(e.camera) || e.objects.includes('doorbell')) return false;
  const zones = c.zones[e.camera] ?? [];
  if (zones.length && !e.zones.some((z) => zones.includes(z))) return false;
  if (c.peopleOnly && !e.objects.includes('person')) return false;
  return true;
}

/** Starts a new day's counts when the calendar day changed. */
export function rollDay(st: CheckInState, now: number, tz: string): CheckInState {
  const today = dayKey(now, tz);
  if (st.day === today) return st;
  if (st.day && st.day > today) return st; // clock went backwards; keep
  return { ...st, day: today, firstToday: undefined, momentsToday: 0, todayIds: [] };
}

/** Records one event (new or updated; each event counts once). */
export function observe(c: CheckIn, st0: CheckInState, e: ActivityEvent, now: number): CheckInState {
  if (!counts(c, e)) return st0;
  const tz = c.timezone;
  let st = rollDay(st0, now, tz);
  if (dayKey(e.start, tz) === st.day) {
    const ids = st.todayIds ?? [];
    const fresh = !ids.includes(e.id);
    st = {
      ...st,
      firstToday: Math.min(st.firstToday ?? Infinity, e.start),
      momentsToday: st.momentsToday + (fresh ? 1 : 0),
      todayIds: fresh ? [...ids, e.id].slice(-500) : ids,
    };
  }
  const last = Math.max(e.start, e.end ?? 0);
  if (last > (st.lastActivity ?? 0)) st = { ...st, lastActivity: last, lastCamera: e.camera };
  return st;
}

export function placeName(c: CheckIn): string {
  const who = c.who.trim();
  if (!who) return c.place?.trim() || 'home';
  return /s$/i.test(who) ? `${who}’` : `${who}’s`;
}

/** "Mom’s fine" / "All fine". */
export function okLabel(c: CheckIn): string {
  return c.who.trim() ? `${c.who.trim()}’s fine` : 'All fine';
}

const camName = (c: CheckIn, id: string) => c.cameraNames?.[id] || id;

function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? 'the cameras';
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

export function lastText(c: CheckIn, st: CheckInState, now: number): string {
  if (st.lastActivity) return `${camName(c, st.lastCamera ?? '')} was last active ${whenText(st.lastActivity, now, c.timezone)}.`;
  return `Sightline hasn’t seen anyone on ${listNames(c.cameras.map((id) => camName(c, id)))} since it started watching.`;
}

const nowClock = (now: number, tz: string) => {
  const p = zoned(now, tz);
  return clockText(p.h, p.mi);
};

/**
 * What's due at `now`, and the state after sending it. `quietNow`: the user's own quiet hours
 * are on right now (check-ins wait for them to end unless `duringQuietHours`).
 */
export function dueCheckIn(c: CheckIn, st0: CheckInState, now: number, quietNow = false): { notices: CheckInNotice[]; state: CheckInState } {
  const tz = c.timezone;
  let st = rollDay(st0, now, tz);
  const notices: CheckInNotice[] = [];
  if (!c.enabled || c.cameras.length === 0 || (quietNow && !c.duringQuietHours)) return { notices, state: st };
  const today = st.day!;
  const place = placeName(c);
  const midnight = atTimeOfDay(now, '00:00', tz);
  const okToday = st.okAt != null && dayKey(st.okAt, tz) === today;

  if (c.byTime && st.firedByTime !== today) {
    const due = atTimeOfDay(now, c.byTime, tz);
    // Only claim "nothing yet today" for a day watched since midnight.
    if (now >= due && st.firstToday == null && !okToday && st.watchingSince <= midnight) {
      notices.push({ kind: 'by-time', title: `No activity at ${place} yet today`, body: `It’s ${nowClock(now, tz)}. ${lastText(c, st, now)}` });
      st = { ...st, firedByTime: today };
    }
  }

  if (c.quietLimitHours && c.quietLimitHours > 0) {
    const from = atTimeOfDay(now, c.dayStart, tz);
    const until = atTimeOfDay(now, c.dayEnd, tz);
    if (now >= from && now < until) {
      const since = Math.max(st.lastActivity ?? 0, st.okAt ?? 0, from, st.watchingSince);
      if (now - since >= c.quietLimitHours * 3600 && st.firedQuietFor !== since) {
        const h = c.quietLimitHours;
        notices.push({ kind: 'quiet', title: `No activity at ${place} for ${h} hour${h === 1 ? '' : 's'}`, body: lastText(c, st, now) });
        st = { ...st, firedQuietFor: since };
      }
    }
  }

  if (c.summaryTime && st.summarySent !== today && now >= atTimeOfDay(now, c.summaryTime, tz)) {
    if (st.firstToday != null) {
      const p = zoned(st.firstToday, tz);
      const n = st.momentsToday;
      notices.push({
        kind: 'summary',
        title: `All normal at ${place}`,
        body: `First activity ${clockText(p.h, p.mi)} · ${n} moment${n === 1 ? '' : 's'} today.`,
      });
    } else {
      notices.push({ kind: 'summary', title: `No activity at ${place} today`, body: lastText(c, st, now) });
    }
    st = { ...st, summarySent: today };
  }
  return { notices, state: st };
}

/** "Mom’s fine": no more no-activity notices today (and the quiet-spell clock restarts). */
export function markOk(st: CheckInState, now: number): CheckInState {
  return { ...st, okAt: now };
}

/** Plain status for the Check-ins screen: "First activity 7:42 AM · 23 moments today". */
export function statusText(c: CheckIn, st: CheckInState | undefined, now: number): string {
  if (!st) return 'Not checked yet.';
  const s = rollDay(st, now, c.timezone);
  if (s.firstToday != null) {
    const p = zoned(s.firstToday, c.timezone);
    return `First activity today ${clockText(p.h, p.mi)} · ${s.momentsToday} moment${s.momentsToday === 1 ? '' : 's'}.`;
  }
  return `No activity yet today. ${lastText(c, s, now)}`;
}

/**
 * Built-in fallback: the next time a check-in could need to speak (to pre-arm a local
 * notification). Returns unix seconds, or null when nothing is scheduled.
 */
export function nextByTime(c: CheckIn, st: CheckInState | undefined, now: number): number | null {
  if (!c.enabled || !c.byTime) return null;
  const tz = c.timezone;
  const today = dayKey(now, tz);
  const s = st ? rollDay(st, now, tz) : undefined;
  const due = atTimeOfDay(now, c.byTime, tz);
  const doneToday = s && (s.firstToday != null || s.firedByTime === today || (s.okAt != null && dayKey(s.okAt, tz) === today));
  if (now < due && !doneToday) return due;
  // Tomorrow's: noon today + 24h lands on tomorrow whatever DST does.
  return atTimeOfDay(atTimeOfDay(now, '12:00', tz) + 86400, c.byTime, tz);
}

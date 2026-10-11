import { hourBucket, lightAt, zoned, type HourBucket, type Light, type SunPlace } from './clock.ts';

/**
 * "Fewer false alarms that learn". Pure (no RN imports) and mirrored by the Hub
 * (bridge/learning.go) with the same tests, so built-in and Instant Alerts agree.
 *
 * The model is deliberately simple and explainable: feedback is grouped by camera + what was
 * seen (+ day/night). Once someone says "Not important" to LEARN_MIN alerts in a group, with no
 * "Always tell me" since, alerts that look the same are quieted. "The most recent opinion wins".
 * Every learned item is listed in Settings → Alerts → What Sightline learned, and can be removed
 * (which forgets the feedback behind it).
 *
 * Never quieted: doorbell rings. Person alerts only after the user confirms that rule.
 *
 * Also here: the no-service "rain, wind and headlights" heuristic for motion-only alerts.
 */

export type Verdict = 'not-important' | 'important';
export type DurationBucket = 'short' | 'medium' | 'long' | 'unknown';

/** What an alert looked like, as stored with feedback. */
export interface AlertFeatures {
  /** `${systemId}:${cameraId}` in the app; the bare camera ID on the Hub. */
  camera: string;
  /** Sorted, unique, without 'motion'. [] = motion only. */
  objects: string[];
  zones: string[];
  subLabels: string[];
  severity: string;
  hour: HourBucket;
  light: Light;
  duration: DurationBucket;
}

export interface Feedback extends AlertFeatures {
  /** Event ID (one opinion per event; the latest replaces an earlier one). */
  id: string;
  /** Unix seconds the feedback was given. */
  at: number;
  verdict: Verdict;
}

export interface LearnedRule {
  /** `${camera}|${objects}|${light}`; stable, used for confirm/forget. */
  key: string;
  kind: 'quiet' | 'always';
  camera: string;
  objects: string[];
  light: Light | 'any';
  /** Every zone the dismissed alerts were in ([] = they had none: anywhere). */
  zones: string[];
  subLabels: string[];
  severities: string[];
  /** All dismissed alerts were short: a long one still alerts. */
  shortOnly: boolean;
  /** How many alerts the user marked (behind this rule). */
  count: number;
  /** Person rules only work once the user says so. */
  needsConfirm: boolean;
  confirmed: boolean;
}

export interface LearningState {
  feedback: Feedback[];
  /** Keys of person rules the user explicitly confirmed. */
  confirmed: string[];
}

export const LEARN_MIN = 3;
/** Feedback older than this is forgotten (habits change: a new neighbor, a new car). */
export const KEEP_SEC = 120 * 86400;
export const MAX_FEEDBACK = 300;
export const SHORT_SEC = 8;
export const LONG_SEC = 60;

export function normObjects(objects: string[]): string[] {
  return [...new Set(objects.filter((o) => o && o !== 'motion'))].sort();
}

export function durationBucket(start: number, end: number | null | undefined): DurationBucket {
  if (end == null || !(end >= start)) return 'unknown';
  const d = end - start;
  return d < SHORT_SEC ? 'short' : d < LONG_SEC ? 'medium' : 'long';
}

export interface EventLike {
  camera: string;
  objects: string[];
  zones: string[];
  subLabels?: string[];
  severity: string;
  start: number;
  end?: number | null;
}

export function featuresOf(e: EventLike, tz: string, sun?: SunPlace | null): AlertFeatures {
  return {
    camera: e.camera,
    objects: normObjects(e.objects),
    zones: [...new Set(e.zones)].sort(),
    subLabels: [...new Set(e.subLabels ?? [])].sort(),
    severity: e.severity,
    hour: hourBucket(zoned(e.start, tz).h),
    light: lightAt(e.start, tz, sun),
    duration: durationBucket(e.start, e.end),
  };
}

const objKey = (objects: string[]) => (objects.length ? objects.join('+') : 'motion');
export const ruleKey = (camera: string, objects: string[], light: Light | 'any') => `${camera}|${objKey(objects)}|${light}`;

const union = (lists: string[][]) => [...new Set(lists.flat())].sort();

/** Adds (or replaces) the opinion on one event; trims old and excess feedback. */
export function addFeedback(state: LearningState, f: Feedback): LearningState {
  const kept = state.feedback.filter((x) => !(x.id === f.id && x.camera === f.camera) && f.at - x.at < KEEP_SEC);
  return { ...state, feedback: [...kept, f].slice(-MAX_FEEDBACK) };
}

/** The learned rules, derived from feedback each time (nothing hidden is stored). */
export function learnRules(state: LearningState, now: number): LearnedRule[] {
  const groups = new Map<string, Feedback[]>(); // camera|objects
  for (const f of state.feedback) {
    if (now - f.at >= KEEP_SEC || f.objects.includes('doorbell')) continue;
    const k = `${f.camera}|${objKey(f.objects)}`;
    groups.set(k, [...(groups.get(k) ?? []), f]);
  }
  const out: LearnedRule[] = [];
  for (const list of groups.values()) {
    const { camera, objects } = list[0];
    const lastImportant = Math.max(-1, ...list.filter((f) => f.verdict === 'important').map((f) => f.at));
    const dismissed = list.filter((f) => f.verdict === 'not-important' && f.at > lastImportant);
    if (lastImportant >= 0 && dismissed.length === 0) {
      const imp = list.filter((f) => f.verdict === 'important');
      out.push(rule('always', camera, objects, 'any', imp, state));
      continue;
    }
    // Per light first ("cars at night"); if neither is enough alone but together they are
    // clearly a pattern, one rule for any time.
    const byLight = (l: Light) => dismissed.filter((f) => f.light === l);
    let made = false;
    for (const l of ['day', 'night'] as Light[]) {
      if (byLight(l).length >= LEARN_MIN) {
        out.push(rule('quiet', camera, objects, l, byLight(l), state));
        made = true;
      }
    }
    if (!made && dismissed.length >= LEARN_MIN + 1) out.push(rule('quiet', camera, objects, 'any', dismissed, state));
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

function rule(kind: LearnedRule['kind'], camera: string, objects: string[], light: Light | 'any', fs: Feedback[], state: LearningState): LearnedRule {
  const key = ruleKey(camera, objects, light);
  const needsConfirm = kind === 'quiet' && objects.includes('person');
  return {
    key,
    kind,
    camera,
    objects,
    light,
    zones: kind === 'quiet' && fs.every((f) => f.zones.length > 0) ? union(fs.map((f) => f.zones)) : [],
    subLabels: kind === 'quiet' ? union(fs.map((f) => f.subLabels)) : [],
    severities: kind === 'quiet' ? union(fs.map((f) => [f.severity])) : [],
    shortOnly: kind === 'quiet' && fs.every((f) => f.duration === 'short'),
    count: fs.length,
    needsConfirm,
    confirmed: needsConfirm && state.confirmed.includes(key),
  };
}

const subset = (have: string[], allowed: string[]) => have.every((x) => allowed.includes(x));
const sameSet = (a: string[], b: string[]) => a.length === b.length && subset(a, b);

/** The quiet rule this alert falls under, if any (and no "always" pin overrides it). */
export function quietedBy(f: AlertFeatures, rules: LearnedRule[]): LearnedRule | null {
  if (f.objects.includes('doorbell')) return null;
  if (alwaysPinned(f, rules)) return null;
  for (const r of rules) {
    if (r.kind !== 'quiet' || r.camera !== f.camera || !sameSet(r.objects, f.objects)) continue;
    if (r.needsConfirm && !r.confirmed) continue;
    if (r.light !== 'any' && r.light !== f.light) continue;
    if (r.zones.length && (f.zones.length === 0 || !subset(f.zones, r.zones))) continue;
    if (!subset(f.subLabels, r.subLabels)) continue; // someone recognized who wasn't before
    if (r.severities.length && !r.severities.includes(f.severity)) continue;
    if (r.shortOnly && (f.duration === 'medium' || f.duration === 'long')) continue;
    return r;
  }
  return null;
}

export function alwaysPinned(f: AlertFeatures, rules: LearnedRule[]): boolean {
  return rules.some((r) => r.kind === 'always' && r.camera === f.camera && sameSet(r.objects, f.objects));
}

/** Forget a learned item: drop the feedback behind it (and its confirmation). */
export function forgetRule(state: LearningState, r: Pick<LearnedRule, 'key' | 'camera' | 'objects' | 'light' | 'kind'>): LearningState {
  return {
    feedback: state.feedback.filter((f) => {
      if (f.camera !== r.camera || !sameSet(f.objects, r.objects)) return true;
      if (r.kind === 'always') return f.verdict !== 'important';
      return f.verdict !== 'not-important' || (r.light !== 'any' && f.light !== r.light);
    }),
    confirmed: state.confirmed.filter((k) => k !== r.key),
  };
}

/** A rule newly created by the latest feedback (to say "Sightline will stop alerting for those"). */
export function newlyLearned(before: LearnedRule[], after: LearnedRule[]): LearnedRule | null {
  const had = new Set(before.map((r) => `${r.kind}:${r.key}`));
  return after.find((r) => r.kind === 'quiet' && !had.has(`${r.kind}:${r.key}`)) ?? null;
}

// ---- wording ----

const PLURALS: Record<string, string> = { person: 'people', bus: 'buses', mouse: 'mice', face: 'faces', license_plate: 'license plates' };

function nounFor(objects: string[], count: number): string {
  if (objects.length === 0) return count === 1 ? 'motion alert' : 'motion alerts';
  const pretty = (o: string) => o.replace(/_/g, ' ');
  if (objects.length === 1) return count === 1 ? pretty(objects[0]) : (PLURALS[objects[0]] ?? `${pretty(objects[0])}s`);
  return `${objects.map(pretty).join(' & ')} ${count === 1 ? 'alert' : 'alerts'}`;
}

const lightText = (l: Light | 'any') => (l === 'night' ? ' at night' : l === 'day' ? ' during the day' : '');
const zoneText = (zones: string[]) => (zones.length ? ` in ${zones.map((z) => z.replace(/_/g, ' ')).join(' or ')}` : '');

/** Short label: "Cars on Driveway at night". */
export function ruleTitle(r: LearnedRule, cameraName: string): string {
  const n = nounFor(r.objects, 2);
  return `${n[0].toUpperCase()}${n.slice(1)} on ${cameraName}${r.kind === 'quiet' ? lightText(r.light) + zoneText(r.zones) : ''}`;
}

/** "You marked 5 cars on Driveway at night as not important — Sightline will stop alerting for those." */
export function ruleExplanation(r: LearnedRule, cameraName: string): string {
  if (r.kind === 'always') return `You asked to always hear about ${nounFor(r.objects, 2)} on ${cameraName}. They won’t be quieted.`;
  const what = `${r.count} ${nounFor(r.objects, r.count)} on ${cameraName}${lightText(r.light)}${zoneText(r.zones)}`;
  if (r.needsConfirm && !r.confirmed) {
    return `You marked ${what} as not important. Sightline never quiets people on its own — stop alerting for these?`;
  }
  return `You marked ${what} as not important — Sightline will stop alerting for those.`;
}

// ---- rain, wind and headlights (no weather service) ----

export const BURST_WINDOW_SEC = 10;
export const BURST_CAMERAS = 3;

export function isMotionOnly(objects: string[]): boolean {
  return objects.every((o) => o === 'motion');
}

export interface RecentTrigger {
  camera: string;
  start: number;
  motionOnly: boolean;
}

export type LikelyCause = 'weather' | 'headlights';

/**
 * Whether a motion-only alert is probably rain, snow, wind or passing headlights:
 * - weather: BURST_CAMERAS or more different cameras saw object-less motion within
 *   BURST_WINDOW_SEC of each other (rain, snow, lightning and gusts hit every camera at once;
 *   a person walks past one camera at a time);
 * - headlights: at night, a motion-only event that was over in under SHORT_SEC.
 * Anything with a detected object (person, car…) and doorbell rings are never touched.
 */
export function likelyFalseTrigger(f: AlertFeatures & { start: number }, recent: RecentTrigger[]): LikelyCause | null {
  if (f.objects.length > 0) return null;
  const cams = new Set([f.camera]);
  for (const r of recent) {
    if (r.motionOnly && Math.abs(r.start - f.start) <= BURST_WINDOW_SEC) cams.add(r.camera);
  }
  if (cams.size >= BURST_CAMERAS) return 'weather';
  if (f.light === 'night' && f.duration === 'short') return 'headlights';
  return null;
}

export interface SmartPrefs {
  /** "Ignore likely rain, wind and headlights" (motion-only alerts). */
  conditions: boolean;
}

/**
 * Why an alert should stay quiet, or null to send it. Order: doorbell never, "always" pins
 * never, then learned rules, then the conditions heuristic.
 */
export function smartQuiet(
  f: AlertFeatures & { start: number },
  rules: LearnedRule[],
  prefs: SmartPrefs,
  recent: RecentTrigger[],
): { reason: 'learned'; rule: LearnedRule } | { reason: LikelyCause } | null {
  if (f.objects.includes('doorbell') || alwaysPinned(f, rules)) return null;
  const r = quietedBy(f, rules);
  if (r) return { reason: 'learned', rule: r };
  if (prefs.conditions) {
    const c = likelyFalseTrigger(f, recent);
    if (c) return { reason: c };
  }
  return null;
}

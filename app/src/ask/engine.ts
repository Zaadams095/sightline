import type { ReviewItem } from '@/systems/types';

/**
 * "Ask your cameras": the brand-neutral event index, the query it answers, a rule-based
 * question parser (used when Apple Intelligence isn't available, and to back up the on-device
 * model), and plain-language answers.
 *
 * Pure: type imports only, no React Native, so it's unit-tested in test/ask.test.ts. Nothing
 * here touches video; it works on the event lists every adapter already returns.
 */

// ---------------------------------------------------------------------------------------------
// Event index
// ---------------------------------------------------------------------------------------------

/** What a question can be about. Each maps to the object labels recorders report. */
export type Concept = 'person' | 'vehicle' | 'package' | 'delivery' | 'animal' | 'bicycle' | 'doorbell';
export const CONCEPTS: Concept[] = ['person', 'vehicle', 'package', 'delivery', 'animal', 'bicycle', 'doorbell'];

/** Labels per concept, across brands (Frigate/Frigate+, Protect, Reolink, Hikvision, Dahua, Blue Iris…). */
const CONCEPT_LABELS: Record<Concept, string[]> = {
  person: ['person', 'people', 'human', 'face', 'pedestrian'],
  vehicle: ['car', 'truck', 'vehicle', 'van', 'bus', 'motorcycle', 'motorbike', 'license_plate', 'boat'],
  package: ['package', 'parcel'],
  // Frigate+ reports carrier logos as attributes; a delivery is a package or a carrier.
  delivery: ['package', 'parcel', 'amazon', 'ups', 'fedex', 'usps', 'dhl', 'dpd', 'gls', 'an_post', 'purolator', 'postnl', 'nzpost', 'postnord', 'royal_mail'],
  animal: ['animal', 'dog', 'cat', 'bird', 'deer', 'bear', 'horse', 'fox', 'raccoon', 'squirrel', 'rabbit', 'cow', 'sheep', 'goat', 'skunk', 'opossum', 'coyote', 'pet'],
  bicycle: ['bicycle', 'bike', 'scooter'],
  doorbell: ['doorbell'],
};

/** One event, from any system, in the shape questions are answered from. */
export interface EventRecord {
  id: string;
  systemId: string;
  cameraId: string;
  /** `${systemId}:${cameraId}` */
  cameraKey: string;
  /** Display name of the camera. */
  camera: string;
  start: number;
  end: number | null;
  severity: 'alert' | 'detection';
  /** Object labels, lowercased (person, car, package, doorbell…). */
  labels: string[];
  /** Recognized names (faces, known plates), as the recorder spells them. */
  names: string[];
  /** Zones, lowercased. */
  zones: string[];
  package: boolean;
  doorbell: boolean;
  thumbnailUrl?: string;
}

export interface CameraInfo {
  key: string;
  name: string;
  zones?: string[];
  /** A doorbell or a camera watching a door ("Who's at the door?"). */
  door?: boolean;
}

/** What the parser (and the on-device model) may pick from. */
export interface AskContext {
  cameras: CameraInfo[];
  /** Names the recorders can recognize, plus any seen in events. */
  names: string[];
  /** Zone names as the user typed them on the recorder. */
  zones: string[];
}

export function isDoorCamera(camera: { name: string; objects?: string[] }): boolean {
  return !!camera.objects?.includes('doorbell') || /\bdoor|doorbell|porch\b/i.test(camera.name);
}

export function buildIndex(items: ReviewItem[], cameras: CameraInfo[]): EventRecord[] {
  const names = new Map(cameras.map((c) => [c.key, c.name]));
  const seen = new Set<string>();
  const out: EventRecord[] = [];
  for (const i of items) {
    const cameraKey = `${i.systemId}:${i.cameraId}`;
    const uid = `${i.systemId}:${i.id}`;
    if (seen.has(uid)) continue;
    seen.add(uid);
    const labels = [...new Set(i.objects.map((o) => o.toLowerCase()))];
    out.push({
      id: i.id,
      systemId: i.systemId,
      cameraId: i.cameraId,
      cameraKey,
      camera: names.get(cameraKey) ?? i.cameraId,
      start: i.startTime,
      end: i.endTime,
      severity: i.severity,
      labels,
      names: [...new Set(i.subLabels ?? [])].filter(Boolean),
      zones: i.zones.map((z) => z.toLowerCase()),
      package: labels.includes('package') || labels.includes('parcel'),
      doorbell: labels.includes('doorbell'),
      thumbnailUrl: i.thumbnailUrl,
    });
  }
  return out.sort((a, b) => b.start - a.start);
}

export function contextFor(index: EventRecord[], cameras: CameraInfo[], knownNames: string[] = []): AskContext {
  const names = new Map<string, string>();
  for (const n of [...knownNames, ...index.flatMap((e) => e.names)]) {
    const t = n.trim();
    // Carrier attributes (amazon, ups…) are things, not people.
    if (t && !CONCEPT_LABELS.delivery.includes(t.toLowerCase())) names.set(t.toLowerCase(), names.get(t.toLowerCase()) ?? t);
  }
  const zones = new Map<string, string>();
  for (const z of [...cameras.flatMap((c) => c.zones ?? []), ...index.flatMap((e) => e.zones)]) {
    const t = z.trim();
    if (t) zones.set(t.toLowerCase(), zones.get(t.toLowerCase()) ?? t);
  }
  return { cameras, names: [...names.values()], zones: [...zones.values()] };
}

// ---------------------------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------------------------

export type AskKind = 'list' | 'count' | 'when' | 'yesno' | 'who';
export const KINDS: AskKind[] = ['yesno', 'count', 'when', 'who', 'list'];
export type PartOfDay = 'morning' | 'afternoon' | 'evening' | 'night';
export const PARTS_OF_DAY: PartOfDay[] = ['morning', 'afternoon', 'evening', 'night'];

/** Time words the model may pick (the parser understands more, e.g. weekdays and "last 3 hours"). */
export const TIME_WORDS = [
  'right now',
  'past hour',
  'today',
  'this morning',
  'this afternoon',
  'this evening',
  'last night',
  'yesterday',
  'last 24 hours',
  'this weekend',
  'this week',
  'last week',
  'past week',
] as const;
export type TimeWord = (typeof TIME_WORDS)[number];

export interface AskQuery {
  kind: AskKind;
  /** Camera keys; empty = every camera. */
  cameraKeys: string[];
  /** Zone names (lowercased); empty = anywhere. */
  zones: string[];
  /** Any of these; empty = anything. */
  concepts: Concept[];
  /** Recognized names (any of); empty = anyone. */
  names: string[];
  after: number;
  before: number;
  partOfDay?: PartOfDay;
  /** "today", "last night", "in the past week"… */
  timeLabel: string;
  /** The time range came from the question (not the default). */
  timeGiven: boolean;
}

export const WINDOW_DAYS = 7;
const HOUR = 3600;
const DAY = 86400;

function startOfDay(t: number, daysBack = 0): number {
  const d = new Date(t * 1000);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysBack);
  return d.getTime() / 1000;
}

function atHour(dayStart: number, hour: number): number {
  const d = new Date(dayStart * 1000);
  d.setHours(hour, 0, 0, 0);
  return d.getTime() / 1000;
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export function resolveTime(word: TimeWord, now: number): { after: number; before: number; label: string } {
  const today = startOfDay(now);
  const hour = new Date(now * 1000).getHours();
  switch (word) {
    case 'right now':
      return { after: now - 15 * 60, before: now, label: 'in the last few minutes' };
    case 'past hour':
      return { after: now - HOUR, before: now, label: 'in the last hour' };
    case 'today':
      return { after: today, before: now, label: 'today' };
    case 'this morning':
      return { after: atHour(today, 5), before: Math.min(now, atHour(today, 12)), label: 'this morning' };
    case 'this afternoon':
      return { after: atHour(today, 12), before: Math.min(now, atHour(today, 17)), label: 'this afternoon' };
    case 'this evening':
      // Just after midnight, "tonight" still means the evening that just passed.
      if (hour < 5) return resolveTime('last night', now);
      return { after: atHour(today, 17), before: now, label: 'this evening' };
    case 'last night': {
      // 6 PM yesterday to 7 AM today (or now, if it's still night).
      return { after: atHour(startOfDay(now, 1), 18), before: Math.min(now, atHour(today, 7)), label: 'last night' };
    }
    case 'yesterday':
      return { after: startOfDay(now, 1), before: today, label: 'yesterday' };
    case 'last 24 hours':
      return { after: now - DAY, before: now, label: 'in the last 24 hours' };
    case 'this weekend': {
      const dow = new Date(now * 1000).getDay();
      // Most recent Saturday (today if it's Saturday; yesterday if Sunday).
      const back = dow === 6 ? 0 : dow === 0 ? 1 : dow + 1;
      const sat = startOfDay(now, back);
      return { after: sat, before: Math.min(now, startOfDay(sat + 2.5 * DAY)), label: 'this weekend' };
    }
    case 'this week':
      return { after: startOfDay(now, 6), before: now, label: 'this week' };
    case 'last week':
      return { after: startOfDay(now, 13), before: startOfDay(now, 6), label: 'last week' };
    case 'past week':
    default:
      return { after: startOfDay(now, WINDOW_DAYS - 1), before: now, label: 'in the past week' };
  }
}

/** Most recent given weekday (today counts). */
function weekdayRange(name: string, now: number): { after: number; before: number; label: string } {
  const target = WEEKDAYS.indexOf(name);
  const dow = new Date(now * 1000).getDay();
  const back = (dow - target + 7) % 7;
  const start = startOfDay(now, back);
  const label = back === 0 ? 'today' : back === 1 ? 'yesterday' : `on ${name[0].toUpperCase()}${name.slice(1)}`;
  return { after: start, before: Math.min(now, startOfDay(start + 1.5 * DAY)), label };
}

function hourOf(t: number): number {
  return new Date(t * 1000).getHours();
}

export function inPartOfDay(t: number, part: PartOfDay): boolean {
  const h = hourOf(t);
  switch (part) {
    case 'morning':
      return h >= 5 && h < 12;
    case 'afternoon':
      return h >= 12 && h < 17;
    case 'evening':
      return h >= 17 && h < 22;
    case 'night':
      return h >= 21 || h < 6;
  }
}

function matchesConcept(e: EventRecord, c: Concept): boolean {
  if (c === 'doorbell') return e.doorbell;
  const labels = CONCEPT_LABELS[c];
  if (e.labels.some((l) => labels.includes(l))) return true;
  // Carrier names arrive as sub-labels on some systems.
  return c === 'delivery' && e.names.some((n) => labels.includes(n.toLowerCase()));
}

/** Matching events, newest first. */
export function runQuery(index: EventRecord[], q: AskQuery): EventRecord[] {
  const names = q.names.map((n) => n.toLowerCase());
  // A name already means a person; other things ("Zach's car") still have to match.
  const concepts = names.length ? q.concepts.filter((c) => c !== 'person') : q.concepts;
  return index
    .filter((e) => {
      // Still going (no end yet) counts as up to an hour long.
      const end = e.end ?? Math.min(q.before, e.start + HOUR);
      if (e.start > q.before || Math.max(end, e.start) < q.after) return false;
      if (q.cameraKeys.length && !q.cameraKeys.includes(e.cameraKey)) return false;
      if (q.zones.length && !e.zones.some((z) => q.zones.includes(z))) return false;
      if (names.length && !e.names.some((n) => names.includes(n.toLowerCase()))) return false;
      if (concepts.length && !concepts.some((c) => matchesConcept(e, c))) return false;
      if (q.partOfDay && !inPartOfDay(e.start, q.partOfDay)) return false;
      return true;
    })
    .sort((a, b) => b.start - a.start);
}

// ---------------------------------------------------------------------------------------------
// Rule-based parser
// ---------------------------------------------------------------------------------------------

const CONCEPT_WORDS: [RegExp, Concept][] = [
  [/\b(deliver(y|ies|ed)?|delivery (driver|guy|person|man)|mail ?(man|carrier)|courier|amazon|ups|fed ?ex|usps|dhl|postman|postie)\b/, 'delivery'],
  [/\b(packages?|parcels?|box(es)?)\b/, 'package'],
  [/\b(cars?|trucks?|vehicles?|vans?|suvs?|motorcycles?|motorbikes?|bus(es)?|pickups?|drove|driving|park(ed)?)\b/, 'vehicle'],
  [/\b(dogs?|cats?|birds?|animals?|deer|bears?|fox(es)?|raccoons?|coyotes?|pets?|squirrels?|rabbits?|critters?|wildlife|skunks?|possums?|opossums?)\b/, 'animal'],
  [/\b(bikes?|bicycles?|scooters?|cyclists?)\b/, 'bicycle'],
  [/\b(door ?bell|rang|ring(s|ing)?|buzz(ed|er)?|knock(ed|ing)?)\b/, 'doorbell'],
  [
    /\b(person|persons|people|some(one|body)|any(one|body)|visitors?|guests?|m[ae]n|wom[ae]n|kids?|child(ren)?|guys?|strangers?|intruders?|humans?|family|teens?|teenagers?|neighbou?rs?|walk(ed|ing)? (by|up|past)|come home|came home|get home|got home|arriv(e|ed|ing)|left|leave|came by|stopped by|who)\b/,
    'person',
  ],
];

const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, few: 3, several: 3 };

const GENERIC_CAMERA_WORDS = new Set(['camera', 'cam', 'cams', 'cctv', 'ipc', 'ip', 'nvr', 'channel', 'ch', 'the', 'my', 'of', 'and']);
const WEAK_WORDS = new Set(['front', 'back', 'side', 'rear', 'left', 'right', 'north', 'south', 'east', 'west', 'upper', 'lower', 'main', 'new', 'old', 'outside', 'inside', 'outdoor', 'indoor']);

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whole-word phrase match; also matches the phrase written as one word ("back yard" ↔ "backyard"). */
function hasPhrase(text: string, phrase: string): boolean {
  const p = norm(phrase);
  if (!p) return false;
  if (new RegExp(`\\b${escapeRe(p)}s?\\b`).test(text)) return true;
  const joined = p.replace(/ /g, '');
  if (joined.length < 5) return false;
  const words = text.split(' ');
  for (let i = 0; i < words.length; i++) {
    let acc = '';
    for (let j = i; j < Math.min(words.length, i + 4); j++) {
      acc += words[j];
      if (acc === joined || acc === `${joined}s`) return true;
      if (acc.length > joined.length + 1) break;
    }
  }
  return false;
}

function cameraCore(name: string): string[] {
  return norm(name)
    .split(' ')
    .filter((w) => w && !GENERIC_CAMERA_WORDS.has(w) && !/^\d+$/.test(w));
}

/** Cameras the question names. A full name beats a single word ("door" → every door camera). */
export function matchCameras(text: string, cameras: CameraInfo[]): string[] {
  const t = norm(text);
  const strong = cameras.filter((c) => {
    const core = cameraCore(c.name);
    return (core.length > 0 && hasPhrase(t, core.join(' '))) || hasPhrase(t, c.name);
  });
  if (strong.length) {
    // "front door" shouldn't also pick "Door" when "Front Door" matched more of the question.
    const cores = strong.map((c) => cameraCore(c.name));
    return strong
      .filter((_, i) => !cores.some((o, j) => j !== i && o.length > cores[i].length && cores[i].every((w) => o.includes(w))))
      .map((c) => c.key);
  }
  const weak = cameras.filter((c) =>
    cameraCore(c.name).some((w) => w.length >= 3 && !WEAK_WORDS.has(w) && hasPhrase(t, w)),
  );
  if (weak.length) return weak.map((c) => c.key);
  // "at the door" / "front door" with no camera called that: the door cameras.
  if (/\b(door|doorstep|porch|doorbell)\b/.test(t)) return cameras.filter((c) => c.door).map((c) => c.key);
  return [];
}

function parseTime(t: string, now: number): { after: number; before: number; label: string; given: boolean; part?: PartOfDay } {
  const fixed: [RegExp, TimeWord][] = [
    [/\b(last night|overnight|during the night)\b/, 'last night'],
    [/\bthis morning\b/, 'this morning'],
    [/\bthis afternoon\b/, 'this afternoon'],
    [/\b(this evening|tonight)\b/, 'this evening'],
    [/\byesterday\b/, 'yesterday'],
    [/\b(today|so far)\b/, 'today'],
    [/\b(this|the|last) weekend\b|\bweekend\b/, 'this weekend'],
    [/\blast week\b/, 'last week'],
    [/\b(this week|past week|the week|last 7 days|past 7 days)\b/, 'this week'],
    [/\b(past|last) (hour)\b|\bhour ago\b/, 'past hour'],
    [/\b(last|past) (24 hours|day)\b/, 'last 24 hours'],
    [/\b(right now|now|currently|at the moment|just now)\b/, 'right now'],
  ];
  let part: PartOfDay | undefined;
  if (!/\b(this morning|this afternoon|this evening|tonight|last night)\b/.test(t)) {
    if (/\b(morning|mornings)\b/.test(t)) part = 'morning';
    else if (/\bafternoons?\b/.test(t)) part = 'afternoon';
    else if (/\bevenings?\b/.test(t)) part = 'evening';
    else if (/\b(at night|nights|night ?time|after dark|midnight)\b/.test(t)) part = 'night';
  }
  const n = /\b(?:past|last|previous) (\d+|a|an|one|two|three|four|five|six|few|several) (minutes?|mins?|hours?|hrs?|days?)\b/.exec(t);
  if (n) {
    const count = /^\d+$/.test(n[1]) ? Number(n[1]) : NUMBER_WORDS[n[1]] ?? 1;
    const unit = n[2].startsWith('m') ? 60 : n[2].startsWith('h') ? HOUR : DAY;
    const plural = count === 1 ? n[2].replace(/s$/, '') : n[2].endsWith('s') ? n[2] : `${n[2]}s`;
    return { after: now - count * unit, before: now, label: `in the last ${count === 1 ? '' : `${count} `}${plural}`.replace(/\s+/g, ' '), given: true, part };
  }
  for (const [re, word] of fixed) if (re.test(t)) return { ...resolveTime(word, now), given: true, part };
  const day = WEEKDAYS.find((d) => new RegExp(`\\b${d}\\b`).test(t));
  if (day) return { ...weekdayRange(day, now), given: true, part };
  return { ...resolveTime('past week', now), given: false, part };
}

function parseKind(t: string): AskKind {
  if (/\bhow (many|often|much)\b|\bnumber of\b|\bcount\b/.test(t)) return 'count';
  if (/^(when|what time|at what time)\b|\bwhen (did|was|were|is|do|does)\b|\bwhat time\b/.test(t)) return 'when';
  if (/^(who|whos|who's)\b|\bwho (was|is|came|rang|stopped|dropped|walked|left)\b/.test(t)) return 'who';
  if (/^(did|was|were|is|are|has|have|had|do|does|any|anything|anyone|anybody|someone|somebody|has anyone|is there|were there|was there)\b/.test(t)) return 'yesno';
  return 'list';
}

/** Rule-based understanding of common questions. Works everywhere, in English. */
export function parseQuestion(question: string, ctx: AskContext, now: number): AskQuery {
  const t = norm(question);
  const time = parseTime(t, now);
  const names = ctx.names.filter((n) => hasPhrase(t, n));
  let cameraKeys = matchCameras(question, ctx.cameras);
  // A zone that isn't also a camera name ("up the driveway" where Driveway is a zone).
  const cameraWords = new Set(ctx.cameras.filter((c) => cameraKeys.includes(c.key)).flatMap((c) => cameraCore(c.name)));
  const zones = ctx.zones
    .filter((z) => hasPhrase(t, z) && !cameraCore(z).every((w) => cameraWords.has(w)))
    .map((z) => z.toLowerCase());
  if (zones.length && cameraKeys.length) {
    // "the driveway" matched both a weak camera word and a zone: trust the zone.
    const zoneWords = new Set(zones.flatMap((z) => cameraCore(z)));
    const viaZoneOnly = ctx.cameras.filter((c) => cameraKeys.includes(c.key) && cameraCore(c.name).every((w) => !hasPhrase(t, w) || zoneWords.has(w)));
    if (viaZoneOnly.length === cameraKeys.length) cameraKeys = [];
  }
  // Words that named a camera or a person don't also count as things ("Doorbell" camera).
  let rest = t;
  for (const c of ctx.cameras.filter((c) => cameraKeys.includes(c.key))) rest = rest.replace(new RegExp(`\\b${escapeRe(norm(c.name))}\\b`, 'g'), ' ');
  for (const n of names) rest = rest.replace(new RegExp(`\\b${escapeRe(norm(n))}\\b`, 'g'), ' ');
  // The delivery driver is the delivery, not any person.
  rest = rest.replace(/\bdelivery (driver|guy|person|man|woman|people)\b/g, 'delivery');
  const concepts: Concept[] = [];
  for (const [re, c] of CONCEPT_WORDS) if (re.test(rest) && !concepts.includes(c)) concepts.push(c);
  // "package delivered" is about the package, not the carrier logo.
  if (concepts.includes('package') && concepts.includes('delivery')) concepts.splice(concepts.indexOf('delivery'), 1);
  let kind = parseKind(t);
  // "Did the doorbell ring" is about the ring. "Who rang the doorbell" keeps people too: most
  // doorbells only report the person standing there.
  if (kind !== 'who' && concepts.includes('doorbell') && concepts.includes('person') && !/\b(person|people|someone|somebody|anyone|anybody|visitors?)\b/.test(rest)) {
    concepts.splice(concepts.indexOf('person'), 1);
  }
  if (kind === 'who' && !concepts.includes('person') && !names.length) concepts.push('person');
  // "Show me…", "Find…", "What happened…" are lists; "Anything on the porch?" is yes/no.
  if (kind === 'list' && /^(any|anything)\b/.test(t)) kind = 'yesno';
  // "Who's at the door?" / "Is anyone there?" ask about now.
  if (!time.given && /\b(who's|whos|who is|is (anyone|someone|anybody|somebody|there)|are there) (at|on|in|outside|by|there)\b/.test(t)) {
    Object.assign(time, resolveTime('right now', now), { given: true });
  }
  return {
    kind,
    cameraKeys,
    zones,
    concepts,
    names,
    after: time.after,
    before: time.before,
    partOfDay: time.part,
    timeLabel: time.label,
    timeGiven: time.given,
  };
}

// ---------------------------------------------------------------------------------------------
// The on-device model's plan → query
// ---------------------------------------------------------------------------------------------

/** What the app sends the model: the only values it's allowed to choose from. */
export interface PlanContext {
  cameras: string[];
  names: string[];
  places: string[];
  things: string[];
  kinds: string[];
  times: string[];
  parts: string[];
  /** Local date and time, written out ("Saturday, October 11, 2026 at 10:45 AM"). */
  now: string;
}

export const THING_WORDS: Record<string, Concept | null> = {
  person: 'person',
  vehicle: 'vehicle',
  package: 'package',
  delivery: 'delivery',
  animal: 'animal',
  bicycle: 'bicycle',
  'doorbell ring': 'doorbell',
  anything: null,
};

export function planContext(ctx: AskContext, now: number): PlanContext {
  const d = new Date(now * 1000);
  const uniq = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];
  return {
    cameras: uniq(ctx.cameras.map((c) => c.name)),
    names: uniq(ctx.names),
    places: uniq(ctx.zones),
    things: Object.keys(THING_WORDS),
    kinds: KINDS,
    times: [...TIME_WORDS],
    parts: ['any', ...PARTS_OF_DAY],
    now: `${d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })} at ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`,
  };
}

const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/**
 * Turns the model's structured output into a query. Every value is checked against what the
 * app offered; anything the model leaves out that the rule parser found (a camera, a time
 * word) is filled in from the parser, so the small model can only add understanding.
 */
export function planToQuery(plan: unknown, ctx: AskContext, now: number, parsed: AskQuery): AskQuery {
  const p = (plan && typeof plan === 'object' ? plan : {}) as Record<string, unknown>;
  const kind = KINDS.includes(p.kind as AskKind) ? (p.kind as AskKind) : parsed.kind;
  const lower = (s: string) => s.trim().toLowerCase();

  const cameraKeys = strList(p.cameras)
    .flatMap((n) => ctx.cameras.filter((c) => lower(c.name) === lower(n)).map((c) => c.key))
    .filter((k, i, a) => a.indexOf(k) === i);
  const names = strList(p.people)
    .map((n) => ctx.names.find((x) => lower(x) === lower(n)))
    .filter((n): n is string => !!n);
  const zones = strList(p.places)
    .filter((z) => ctx.zones.some((x) => lower(x) === lower(z)))
    .map(lower);
  const concepts = strList(p.things)
    .map((th) => THING_WORDS[lower(th)])
    .filter((c): c is Concept => !!c)
    .filter((c, i, a) => a.indexOf(c) === i);

  const timeWord = TIME_WORDS.find((w) => w === lower(String(p.time ?? '')));
  let time = { after: parsed.after, before: parsed.before, label: parsed.timeLabel };
  // The parser's time wins when the question literally said one; otherwise take the model's.
  if (!parsed.timeGiven && timeWord && timeWord !== 'past week') time = resolveTime(timeWord, now);
  const part = PARTS_OF_DAY.find((x) => x === lower(String(p.partOfDay ?? '')));

  return {
    kind,
    cameraKeys: cameraKeys.length ? cameraKeys : parsed.cameraKeys,
    zones: zones.length ? zones : parsed.zones,
    concepts: concepts.length ? concepts : parsed.concepts,
    names: names.length ? names : parsed.names,
    after: time.after,
    before: time.before,
    partOfDay: parsed.partOfDay ?? (time.label.startsWith('this ') || time.label === 'last night' ? undefined : part),
    timeLabel: time.label,
    timeGiven: parsed.timeGiven || (!!timeWord && timeWord !== 'past week'),
  };
}

// ---------------------------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------------------------

const NOUNS: Record<Concept, [string, string]> = {
  person: ['someone', 'people'],
  vehicle: ['a car', 'cars'],
  package: ['a package', 'packages'],
  delivery: ['a delivery', 'deliveries'],
  animal: ['an animal', 'animals'],
  bicycle: ['a bike', 'bikes'],
  doorbell: ['a doorbell ring', 'doorbell rings'],
};

function orList(xs: string[]): string {
  if (xs.length <= 1) return xs[0] ?? '';
  return `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}`;
}

function andList(xs: string[]): string {
  if (xs.length <= 1) return xs[0] ?? '';
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function what(q: AskQuery, plural = false): string {
  if (q.names.length) return orList(q.names);
  if (!q.concepts.length) return plural ? 'events' : 'anything';
  return orList(q.concepts.map((c) => NOUNS[c][plural ? 1 : 0]));
}

function where(q: AskQuery, ctx: AskContext): string {
  const cams = ctx.cameras.filter((c) => q.cameraKeys.includes(c.key)).map((c) => c.name);
  const zones = q.zones.map((z) => ctx.zones.find((x) => x.toLowerCase() === z) ?? z);
  if (zones.length) return ` in ${orList(zones)}${cams.length ? ` on ${orList(cams)}` : ''}`;
  return cams.length ? ` on ${orList(cams)}` : '';
}

function when(q: AskQuery): string {
  const part = q.partOfDay ? (q.partOfDay === 'night' ? ' at night' : ` in the ${q.partOfDay}`) : '';
  return `${q.timeLabel}${part}`;
}

export function clock(t: number): string {
  return new Date(t * 1000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

/** "at 3:42 PM", "yesterday at 9:10 PM", "on Tuesday at 7:05 AM". */
export function spokenTime(t: number, now: number): string {
  const day = startOfDay(t);
  if (day === startOfDay(now)) return `at ${clock(t)}`;
  if (day === startOfDay(now, 1)) return `yesterday at ${clock(t)}`;
  const wd = new Date(t * 1000).toLocaleDateString('en-US', { weekday: 'long' });
  return `on ${wd} at ${clock(t)}`;
}

const LABEL_NOUN: Record<string, string> = {
  person: 'someone',
  face: 'someone',
  car: 'a car',
  truck: 'a truck',
  vehicle: 'a vehicle',
  motorcycle: 'a motorcycle',
  bus: 'a bus',
  package: 'a package',
  dog: 'a dog',
  cat: 'a cat',
  bird: 'a bird',
  bicycle: 'a bike',
  doorbell: 'a doorbell ring',
};

/** What an event shows, in words: "Emma", "a package", "someone". */
export function eventSubject(e: EventRecord, q?: AskQuery): string {
  const names = e.names.filter((n) => !CONCEPT_LABELS.delivery.includes(n.toLowerCase()));
  if (names.length) return andList(names);
  if (e.doorbell && (!q || q.concepts.includes('doorbell'))) return 'a doorbell ring';
  // Prefer the thing that was asked about.
  for (const c of q?.concepts ?? []) if (c !== 'doorbell' && matchesConcept(e, c)) return c === 'delivery' && !e.package ? 'a delivery' : NOUNS[c][0];
  for (const l of e.labels) if (LABEL_NOUN[l]) return LABEL_NOUN[l];
  if (e.labels.length) return `a ${e.labels[0].replace(/_/g, ' ')}`;
  return 'motion';
}

function describe(e: EventRecord, now: number, q?: AskQuery): string {
  return `${eventSubject(e, q)} on ${e.camera} ${spokenTime(e.start, now)}`;
}

export interface Answer {
  text: string;
  /** Plain facts for the on-device model to phrase from (it may use nothing else). */
  facts: string[];
}

export function composeAnswer(q: AskQuery, matches: EventRecord[], ctx: AskContext, now: number): Answer {
  const n = matches.length;
  const latest = matches[0];
  const w = where(q, ctx);
  const tw = when(q);
  let text: string;
  switch (q.kind) {
    case 'yesno':
      if (!n) text = q.concepts.length || q.names.length ? `No, I didn't see ${what(q)}${w} ${tw}.` : `No, nothing was recorded${w} ${tw}.`;
      else if (n === 1) text = `Yes. ${cap(eventSubject(latest, q))} was seen on ${latest.camera} ${spokenTime(latest.start, now)}.`;
      else text = `Yes, ${n} times ${tw}. The latest was ${describe(latest, now, q)}.`;
      break;
    case 'count':
      if (!n) text = `None. I didn't see ${what(q)}${w} ${tw}.`;
      else text = `I saw ${what(q, true)}${w} ${n === 1 ? 'once' : `${n} times`} ${tw}. The latest was ${describe(latest, now, q)}.`;
      break;
    case 'when': {
      if (!n) {
        text = `I didn't see ${what(q)}${w} ${tw}.`;
        break;
      }
      text = `${cap(eventSubject(latest, q))} was seen ${spokenTime(latest.start, now)} on ${latest.camera}.`;
      const earlier = matches.slice(1, 4).map((e) => spokenTime(e.start, now).replace(/^at /, ''));
      if (earlier.length) text += ` Before that: ${andList(earlier)}.`;
      break;
    }
    case 'who': {
      if (!n) {
        text = `Nobody was seen${w} ${tw}.`;
        break;
      }
      const known = [...new Set(matches.flatMap((e) => e.names.filter((x) => !CONCEPT_LABELS.delivery.includes(x.toLowerCase()))))];
      // Events aren't people (one visitor can make several), so unknowns stay "someone".
      const unknown = matches.some((e) => !e.names.length);
      const shown = known.slice(0, 4);
      const who = andList([...shown, ...(unknown ? ["someone I don't recognize"] : [])]);
      const plural = shown.length + (unknown ? 1 : 0) > 1;
      text = `${cap(who)} ${plural ? 'were' : 'was'} seen${w} ${tw}.`;
      if (n > 1) text += ` The latest was ${describe(latest, now, q)}.`;
      break;
    }
    case 'list':
    default:
      if (!n) text = `I didn't find ${what(q)}${w} ${tw}.`;
      else text = `${n === 1 ? 'One match' : `${n} matches`} ${tw}. The latest is ${describe(latest, now, q)}.`;
  }

  const facts = [
    `Question type: ${q.kind}`,
    `Looking for: ${what(q, true)}${w}, ${tw}`,
    `Matching recordings: ${n}`,
    ...matches.slice(0, 5).map((e) => `- ${eventSubject(e, q)} on ${e.camera} ${spokenTime(e.start, now)}`),
    `Draft answer: ${text}`,
  ];
  return { text, facts };
}

/**
 * Guard against the model inventing details: its answer may only use numbers (counts, times)
 * and camera names that appear in the facts, and must stay short. Otherwise the app shows its
 * own sentence.
 */
export function acceptModelAnswer(answer: string, facts: string[], ctx: AskContext): boolean {
  const a = answer.trim();
  if (!a || a.length > 320) return false;
  const factText = facts.join('\n').toLowerCase();
  for (const num of a.match(/\d+/g) ?? []) if (!new RegExp(`\\b${num}\\b`).test(factText)) return false;
  const lowerA = a.toLowerCase();
  for (const c of ctx.cameras) {
    const name = c.name.toLowerCase();
    if (name.length >= 3 && lowerA.includes(name) && !factText.includes(name)) return false;
  }
  for (const n of ctx.names) {
    const name = n.toLowerCase();
    if (name.length >= 2 && new RegExp(`\\b${escapeRe(name)}\\b`).test(lowerA) && !factText.includes(name)) return false;
  }
  // "Yes" vs "No" must agree with the count.
  const none = /Matching recordings: 0\b/.test(facts.join('\n'));
  if (none && /^yes\b/i.test(a)) return false;
  if (!none && /^no\b/i.test(a) && /Question type: yesno/.test(facts.join('\n'))) return false;
  return true;
}

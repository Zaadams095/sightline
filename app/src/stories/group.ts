import type { CameraMap } from '@/state/store';

/**
 * "One story across cameras": related events on different cameras grouped into a single
 * sequence ("Person came up the driveway → front porch → side gate → backyard (2 min)").
 *
 * Pure (type-only imports) so it runs in unit tests and in background alert checks. Works for
 * every brand: it only needs start/end times, object labels and (optionally) recognized names,
 * plus the user's property map when there is one.
 */

/** The fields of a review item the grouping needs (ReviewItem satisfies this). */
export interface StoryInput {
  id: string;
  systemId: string;
  cameraId: string;
  startTime: number;
  endTime: number | null;
  objects: string[];
  /** Recognized names (from the system or on-device recognition). */
  subLabels?: string[];
  thumbnailUrl?: string;
}

/** One stop of a story: consecutive events on the same camera are merged into one step. */
export interface StoryStep<T extends StoryInput = StoryInput> {
  cameraKey: string;
  systemId: string;
  cameraId: string;
  start: number;
  end: number;
  items: T[];
  objects: string[];
  names: string[];
}

export interface Story<T extends StoryInput = StoryInput> {
  /** Stable for the same first event: `${systemId}:${firstItemId}`. */
  id: string;
  steps: StoryStep<T>[];
  start: number;
  end: number;
  /** Distinct cameras in order of first appearance. */
  cameras: string[];
  objects: string[];
  names: string[];
  /** True when adjacency came from the map (links or placements) for every hop. */
  mapped: boolean;
}

export interface GroupOptions {
  /** Assumed duration of an event that is still in progress or has no end (s). */
  openEventSec: number;
  /** Max gap between cameras when the map can't say whether they're near each other (s). */
  unmappedGapSec: number;
  /** Placed cameras further apart than this (fraction of map width) are not neighbors. */
  maxPlacedDistance: number;
  /** A story never spans more than this (s). */
  maxDurationSec: number;
  maxSteps: number;
  /** Same-camera events closer than this merge into one step (s). */
  sameCameraGapSec: number;
}

export const DEFAULT_GROUP_OPTIONS: GroupOptions = {
  openEventSec: 30,
  unmappedGapSec: 30,
  maxPlacedDistance: 0.8,
  maxDurationSec: 15 * 60,
  maxSteps: 12,
  sameCameraGapSec: 45,
};

const VEHICLES = new Set(['car', 'truck', 'vehicle', 'motorcycle', 'bus', 'bicycle', 'license_plate', 'van']);
const ANIMALS = new Set(['dog', 'cat', 'animal', 'bird', 'horse', 'deer', 'bear', 'raccoon', 'fox']);
const PEOPLE = new Set(['person', 'face', 'people', 'human']);

/** Collapses brand-specific labels into the kinds that can follow each other. */
export function objectKind(label: string): 'person' | 'vehicle' | 'animal' | 'other' {
  const l = label.toLowerCase();
  if (PEOPLE.has(l)) return 'person';
  if (VEHICLES.has(l)) return 'vehicle';
  if (ANIMALS.has(l)) return 'animal';
  return 'other';
}

/** Kinds that matter for following (doorbell rings / packages / motion don't pin a kind). */
function kindsOf(objects: string[]): Set<string> {
  return new Set(objects.map(objectKind).filter((k) => k !== 'other'));
}

/**
 * Seconds someone plausibly takes from camera a to b, or null when the map says they aren't
 * neighbors. `mapped` is false when the map can't tell (no map, or a camera not placed).
 */
export function transitBetween(
  map: CameraMap | null | undefined,
  a: string,
  b: string,
  o: GroupOptions = DEFAULT_GROUP_OPTIONS,
): { sec: number; mapped: boolean } | null {
  if (a === b) return { sec: 0, mapped: true };
  const link = map?.links.find((l) => (l.a === a && l.b === b) || (l.a === b && l.b === a));
  if (link) return { sec: Math.max(0, link.transitSec), mapped: true };
  const pa = map?.placements[a];
  const pb = map?.placements[b];
  if (!map || !pa || !pb) return { sec: o.unmappedGapSec, mapped: false };
  const d = Math.hypot((pa.x - pb.x) * (map.aspect || 1), pa.y - pb.y);
  if (d > o.maxPlacedDistance) return null;
  // Same rough default as map/graph.ts neighborsOf: a ~40 m property at walking pace.
  return { sec: Math.round(10 + d * 40), mapped: true };
}

const endOf = (i: StoryInput, o: GroupOptions) => i.endTime ?? i.startTime + o.openEventSec;
const keyOf = (i: StoryInput) => `${i.systemId}:${i.cameraId}`;
const uniq = <T>(xs: T[]) => [...new Set(xs)];

interface Chain<T extends StoryInput> {
  steps: StoryStep<T>[];
  mapped: boolean;
}

function chainNames<T extends StoryInput>(c: Chain<T>): Set<string> {
  return new Set(c.steps.flatMap((s) => s.names));
}

function chainKinds<T extends StoryInput>(c: Chain<T>): Set<string> {
  return new Set(c.steps.flatMap((s) => [...kindsOf(s.objects)]));
}

/**
 * How well `item` continues `chain` (higher = better), or null when it can't.
 * Rules: starts no earlier than the last step started; within the transit window (overlap is
 * fine: someone is often visible on two cameras at once); compatible object kinds; never two
 * different recognized people; and the whole story stays under maxDurationSec.
 */
function fit<T extends StoryInput>(
  chain: Chain<T>,
  item: T,
  map: CameraMap | null | undefined,
  o: GroupOptions,
): { score: number; mapped: boolean; sameStep: boolean } | null {
  const last = chain.steps[chain.steps.length - 1];
  const key = keyOf(item);
  if (item.startTime < last.start) return null;
  if (endOf(item, o) - chain.steps[0].start > o.maxDurationSec) return null;

  const names = item.subLabels ?? [];
  const known = chainNames(chain);
  const sharesName = names.some((n) => known.has(n));
  if (names.length && known.size && !sharesName) return null;

  const kinds = kindsOf(item.objects);
  const have = chainKinds(chain);
  const sharesKind = [...kinds].some((k) => have.has(k));
  if (kinds.size && have.size && !sharesKind) return null;

  const gap = item.startTime - last.end;
  if (key === last.cameraKey) {
    if (gap > o.sameCameraGapSec) return null;
    return { score: 50 - Math.max(0, gap) + (sharesName ? 100 : 0), mapped: chain.mapped, sameStep: true };
  }
  // A camera already visited earlier (not the last step) is fine: people walk back.
  const t = transitBetween(map, last.cameraKey, key, o);
  if (!t) return null;
  // Recognized as the same person/car: allow a slower walk.
  const window = (t.mapped ? t.sec * 2 + 15 : t.sec) * (sharesName ? 2 : 1);
  if (gap > window) return null;
  if (!t.mapped && !sharesName && !(kinds.size && sharesKind)) return null;
  // Closer cameras win ties: with two people about, each hop goes to the nearer trail.
  const score = (sharesName ? 100 : 0) + (t.mapped ? 20 : 0) + (sharesKind ? 10 : 0) - Math.max(0, gap) / 10 - t.sec / 10;
  return { score, mapped: chain.mapped && t.mapped, sameStep: false };
}

function stepOf<T extends StoryInput>(item: T, o: GroupOptions): StoryStep<T> {
  return {
    cameraKey: keyOf(item),
    systemId: item.systemId,
    cameraId: item.cameraId,
    start: item.startTime,
    end: endOf(item, o),
    items: [item],
    objects: uniq(item.objects),
    names: uniq(item.subLabels ?? []),
  };
}

/**
 * Groups events into stories. Every event is used at most once; chains that never leave one
 * camera are not stories and are dropped. Events may come from any number of systems.
 */
export function groupStories<T extends StoryInput>(
  events: T[],
  map: CameraMap | null | undefined,
  opts: Partial<GroupOptions> = {},
): Story<T>[] {
  const o = { ...DEFAULT_GROUP_OPTIONS, ...opts };
  const sorted = [...events].sort((a, b) => a.startTime - b.startTime || keyOf(a).localeCompare(keyOf(b)));
  const open: Chain<T>[] = [];
  const done: Chain<T>[] = [];

  for (const item of sorted) {
    // Retire chains nothing can continue any more (keeps this linear on long histories).
    for (let i = open.length - 1; i >= 0; i--) {
      const last = open[i].steps[open[i].steps.length - 1];
      const horizon = Math.max(o.sameCameraGapSec, o.unmappedGapSec, longestWindow(map, o)) * 2;
      if (item.startTime - last.end > horizon || item.startTime - open[i].steps[0].start > o.maxDurationSec) {
        done.push(...open.splice(i, 1));
      }
    }
    let best: { chain: Chain<T>; score: number; mapped: boolean; sameStep: boolean } | null = null;
    for (const chain of open) {
      if (chain.steps.length >= o.maxSteps) continue;
      const f = fit(chain, item, map, o);
      if (f && (!best || f.score > best.score)) best = { chain, ...f };
    }
    if (!best) {
      open.push({ steps: [stepOf(item, o)], mapped: true });
      continue;
    }
    const last = best.chain.steps[best.chain.steps.length - 1];
    if (best.sameStep) {
      last.items.push(item);
      last.end = Math.max(last.end, endOf(item, o));
      last.objects = uniq([...last.objects, ...item.objects]);
      last.names = uniq([...last.names, ...(item.subLabels ?? [])]);
    } else {
      best.chain.steps.push(stepOf(item, o));
      best.chain.mapped = best.mapped;
    }
  }
  done.push(...open);

  return done
    .filter((c) => new Set(c.steps.map((s) => s.cameraKey)).size >= 2)
    .map((c) => toStory(c))
    .sort((a, b) => b.start - a.start);
}

function longestWindow(map: CameraMap | null | undefined, o: GroupOptions): number {
  const longestLink = Math.max(0, ...(map?.links ?? []).map((l) => l.transitSec));
  return Math.max(longestLink, 10 + o.maxPlacedDistance * 40) * 2 * 2 + 15;
}

function toStory<T extends StoryInput>(c: Chain<T>): Story<T> {
  const first = c.steps[0];
  return {
    id: `${first.systemId}:${first.items[0].id}`,
    steps: c.steps,
    start: first.start,
    end: Math.max(...c.steps.map((s) => s.end)),
    cameras: uniq(c.steps.map((s) => s.cameraKey)),
    objects: uniq(c.steps.flatMap((s) => s.objects)),
    names: uniq(c.steps.flatMap((s) => s.names)),
    mapped: c.mapped,
  };
}

/** Builds a story from events the caller already knows belong together (e.g. a notification tap). */
export function storyFromItems<T extends StoryInput>(items: T[], opts: Partial<GroupOptions> = {}): Story<T> | null {
  const o = { ...DEFAULT_GROUP_OPTIONS, ...opts };
  const sorted = [...items].sort((a, b) => a.startTime - b.startTime);
  if (!sorted.length) return null;
  const steps: StoryStep<T>[] = [];
  for (const item of sorted) {
    const last = steps[steps.length - 1];
    if (last && last.cameraKey === keyOf(item)) {
      last.items.push(item);
      last.end = Math.max(last.end, endOf(item, o));
      last.objects = uniq([...last.objects, ...item.objects]);
      last.names = uniq([...last.names, ...(item.subLabels ?? [])]);
    } else {
      steps.push(stepOf(item, o));
    }
  }
  return toStory({ steps, mapped: false });
}

function pretty(label: string): string {
  return label.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

/** "Dad", "Dad & Sam", or "Person" / "Car" from the main object kind. */
export function storyWho(story: Pick<Story, 'names' | 'objects'>): string {
  if (story.names.length) return story.names.slice(0, 2).join(' & ') + (story.names.length > 2 ? ` +${story.names.length - 2}` : '');
  const order = ['person', 'car', 'truck', 'motorcycle', 'bicycle', 'dog', 'cat'];
  const main = [...story.objects].sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  })[0];
  return main ? pretty(main) : 'Motion';
}

export function formatSpan(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/**
 * One-line summary: "Person: Driveway → Front porch → Side gate → Backyard (2 min)".
 * Repeat visits to the same camera stay in the path ("Porch → Yard → Porch").
 */
export function storySummary(story: Story, nameOf: (cameraKey: string) => string): string {
  const path = story.steps.map((s) => nameOf(s.cameraKey));
  return `${storyWho(story)}: ${path.join(' → ')} (${formatSpan(story.end - story.start)})`;
}

/** Short notification/list title: "Person across 4 cameras". */
export function storyTitle(story: Story): string {
  return `${storyWho(story)} across ${story.cameras.length} cameras`;
}

/**
 * For built-in alerts: events chosen to notify that belong to a multi-camera story become one
 * notification for the story ("Person across 4 cameras") instead of one per camera. `context`
 * is every new event (including ones the rules didn't pick, e.g. a cooldown), so the path is
 * complete; a story only notifies when at least one of its events was picked.
 */
export function bundleAlerts<T extends StoryInput>(
  selected: T[],
  context: T[],
  map: CameraMap | null | undefined,
  opts: Partial<GroupOptions> = {},
): { stories: Story<T>[]; singles: T[] } {
  const byKey = new Map<string, T>();
  for (const i of [...context, ...selected]) byKey.set(`${i.systemId}:${i.id}`, i);
  const all = groupStories([...byKey.values()], map, opts);
  const picked = new Set(selected.map((i) => `${i.systemId}:${i.id}`));
  const stories = all.filter((s) => s.steps.some((st) => st.items.some((i) => picked.has(`${i.systemId}:${i.id}`))));
  const inStory = new Set(stories.flatMap((s) => s.steps.flatMap((st) => st.items.map((i) => `${i.systemId}:${i.id}`))));
  return { stories: stories.sort((a, b) => a.start - b.start), singles: selected.filter((i) => !inStory.has(`${i.systemId}:${i.id}`)) };
}

/** The story an event belongs to, if any. */
export function storyOf<T extends StoryInput>(stories: Story<T>[], systemId: string, itemId: string): Story<T> | null {
  return stories.find((s) => s.steps.some((st) => st.systemId === systemId && st.items.some((i) => i.id === itemId))) ?? null;
}

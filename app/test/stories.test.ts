import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  bundleAlerts,
  formatSpan,
  groupStories,
  objectKind,
  storyFromItems,
  storyOf,
  storySummary,
  storyTitle,
  transitBetween,
  type StoryInput,
} from '../src/stories/group.ts';

const ev = (id: string, cam: string, start: number, end: number | null, objects = ['person'], subLabels: string[] = [], systemId = 's'): StoryInput => ({
  id,
  systemId,
  cameraId: cam,
  startTime: start,
  endTime: end,
  objects,
  subLabels,
});

// Driveway → porch → gate → backyard, linked in a line.
const lineMap = {
  aspect: 1,
  placements: {},
  links: [
    { a: 's:drive', b: 's:porch', transitSec: 15 },
    { a: 's:porch', b: 's:gate', transitSec: 20 },
    { a: 's:gate', b: 's:back', transitSec: 15 },
  ],
} as never;

const names = (k: string) => ({ 's:drive': 'Driveway', 's:porch': 'Front porch', 's:gate': 'Side gate', 's:back': 'Backyard' })[k] ?? k;

test('a walk across linked cameras becomes one story', () => {
  const events = [
    ev('1', 'drive', 0, 20),
    ev('2', 'porch', 30, 60),
    ev('3', 'gate', 75, 90),
    ev('4', 'back', 100, 120),
  ];
  const stories = groupStories(events, lineMap);
  assert.equal(stories.length, 1);
  const s = stories[0];
  assert.deepEqual(s.cameras, ['s:drive', 's:porch', 's:gate', 's:back']);
  assert.equal(s.mapped, true);
  assert.equal(storySummary(s, names), 'Person: Driveway → Front porch → Side gate → Backyard (2 min)');
  assert.equal(storyTitle(s), 'Person across 4 cameras');
  assert.equal(s.id, 's:1');
});

test('events on one camera only are not a story', () => {
  assert.equal(groupStories([ev('1', 'drive', 0, 20), ev('2', 'drive', 30, 40)], lineMap).length, 0);
});

test('same-camera events merge into one step', () => {
  const stories = groupStories([ev('1', 'drive', 0, 10), ev('2', 'drive', 20, 30), ev('3', 'porch', 40, 50)], lineMap);
  assert.equal(stories.length, 1);
  assert.equal(stories[0].steps.length, 2);
  assert.equal(stories[0].steps[0].items.length, 2);
  assert.equal(stories[0].steps[0].end, 30);
});

test('too long a gap splits stories', () => {
  // porch→gate transit 20 s: window 55 s after the porch event ends.
  const stories = groupStories([ev('1', 'porch', 0, 10), ev('2', 'gate', 400, 410)], lineMap);
  assert.equal(stories.length, 0);
});

test('overlapping (simultaneous) sightings still chain', () => {
  const stories = groupStories([ev('1', 'drive', 0, 40), ev('2', 'porch', 25, 60)], lineMap);
  assert.equal(stories.length, 1);
});

test('different object kinds do not chain', () => {
  const stories = groupStories([ev('1', 'drive', 0, 20, ['car']), ev('2', 'porch', 25, 40, ['dog'])], lineMap);
  assert.equal(stories.length, 0);
});

test('labels from different brands fold into kinds', () => {
  assert.equal(objectKind('Truck'), 'vehicle');
  assert.equal(objectKind('face'), 'person');
  assert.equal(objectKind('doorbell'), 'other');
  const stories = groupStories([ev('1', 'drive', 0, 20, ['car']), ev('2', 'porch', 25, 40, ['vehicle'])], lineMap);
  assert.equal(stories.length, 1);
});

test('motion-only events can join a person story', () => {
  const stories = groupStories([ev('1', 'drive', 0, 20), ev('2', 'porch', 25, 40, [])], lineMap);
  assert.equal(stories.length, 1);
});

test('two recognized people at once make two stories', () => {
  const events = [
    ev('a1', 'drive', 0, 20, ['person'], ['Dad']),
    ev('b1', 'drive', 5, 25, ['person'], ['Sam']),
    ev('a2', 'porch', 30, 50, ['person'], ['Dad']),
    ev('b2', 'porch', 35, 55, ['person'], ['Sam']),
  ];
  const stories = groupStories(events, lineMap);
  assert.equal(stories.length, 2);
  const byName = Object.fromEntries(stories.map((s) => [s.names.join(','), s.steps.flatMap((st) => st.items.map((i) => i.id))]));
  assert.deepEqual(byName.Dad, ['a1', 'a2']);
  assert.deepEqual(byName.Sam, ['b1', 'b2']);
  assert.equal(storyTitle(stories.find((s) => s.names[0] === 'Dad')!), 'Dad across 2 cameras');
});

test('overlapping unknown people on separate trails go to the nearer trail', () => {
  // Two separate pairs: drive↔porch (front) and back↔gate (rear), far apart.
  const map = {
    aspect: 1,
    placements: {
      's:drive': { x: 0.1, y: 0.1, heading: 0, fov: 90 },
      's:porch': { x: 0.2, y: 0.1, heading: 0, fov: 90 },
      's:back': { x: 0.9, y: 0.9, heading: 0, fov: 90 },
      's:gate': { x: 0.8, y: 0.9, heading: 0, fov: 90 },
    },
    links: [],
  } as never;
  const stories = groupStories(
    [ev('f1', 'drive', 0, 30), ev('r1', 'back', 5, 35), ev('f2', 'porch', 20, 40), ev('r2', 'gate', 25, 45)],
    map,
    { maxPlacedDistance: 0.5 },
  );
  assert.equal(stories.length, 2);
  const sets = stories.map((s) => s.cameras.slice().sort().join('|')).sort();
  assert.deepEqual(sets, ['s:back|s:gate', 's:drive|s:porch']);
});

test('without a map: only close-in-time, same-kind events chain', () => {
  const stories = groupStories([ev('1', 'a', 0, 10), ev('2', 'b', 20, 30), ev('3', 'c', 200, 210)], null);
  assert.equal(stories.length, 1);
  assert.deepEqual(stories[0].cameras, ['s:a', 's:b']);
  assert.equal(stories[0].mapped, false);
  // Motion-only events without a map are too vague to link.
  assert.equal(groupStories([ev('1', 'a', 0, 10, []), ev('2', 'b', 15, 30, [])], null).length, 0);
});

test('cameras without positions fall back to the time-only rule', () => {
  const map = { aspect: 1, placements: { 's:a': { x: 0.1, y: 0.1, heading: 0, fov: 90 } }, links: [] } as never;
  assert.deepEqual(transitBetween(map, 's:a', 's:b'), { sec: 30, mapped: false });
  assert.equal(groupStories([ev('1', 'a', 0, 10), ev('2', 'b', 25, 30)], map).length, 1);
  assert.equal(groupStories([ev('1', 'a', 0, 10), ev('2', 'b', 60, 70)], map).length, 0);
});

test('placed cameras far apart are not neighbors', () => {
  const map = {
    aspect: 1,
    placements: { 's:a': { x: 0, y: 0, heading: 0, fov: 90 }, 's:b': { x: 1, y: 1, heading: 0, fov: 90 } },
    links: [],
  } as never;
  assert.equal(transitBetween(map, 's:a', 's:b'), null);
  assert.equal(groupStories([ev('1', 'a', 0, 10), ev('2', 'b', 12, 20)], map).length, 0);
});

test('recognized names allow a slower walk; different names never merge', () => {
  // porch→gate window is 55 s normally; with the same name, 110 s.
  assert.equal(groupStories([ev('1', 'porch', 0, 10, ['person'], ['Dad']), ev('2', 'gate', 90, 100, ['person'], ['Dad'])], lineMap).length, 1);
  assert.equal(groupStories([ev('1', 'porch', 0, 10, ['person'], ['Dad']), ev('2', 'gate', 20, 30, ['person'], ['Sam'])], lineMap).length, 0);
});

test('in-progress events and multiple systems', () => {
  const map = { aspect: 1, placements: {}, links: [{ a: 'nvr:front', b: 'hub:door', transitSec: 10 }] } as never;
  const stories = groupStories([ev('1', 'front', 0, null, ['person'], [], 'nvr'), ev('2', 'door', 35, null, ['person'], [], 'hub')], map);
  assert.equal(stories.length, 1);
  assert.equal(stories[0].end, 65);
  assert.equal(storyOf(stories, 'hub', '2')?.id, 'nvr:1');
  assert.equal(storyOf(stories, 'hub', 'zzz'), null);
});

test('stories are capped in length and duration', () => {
  const events = Array.from({ length: 30 }, (_, i) => ev(String(i), i % 2 ? 'porch' : 'drive', i * 20, i * 20 + 10));
  const stories = groupStories(events, lineMap, { maxSteps: 5 });
  assert.ok(stories.length >= 2);
  for (const s of stories) {
    assert.ok(s.steps.length <= 5);
    assert.ok(s.end - s.start <= 15 * 60);
  }
});

test('walking back to a camera keeps it in the path', () => {
  const s = groupStories([ev('1', 'porch', 0, 10), ev('2', 'gate', 20, 30), ev('3', 'porch', 50, 60)], lineMap)[0];
  assert.deepEqual(s.steps.map((x) => x.cameraKey), ['s:porch', 's:gate', 's:porch']);
  assert.deepEqual(s.cameras, ['s:porch', 's:gate']);
});

test('storyFromItems and formatSpan', () => {
  const s = storyFromItems([ev('2', 'porch', 30, 40), ev('1', 'drive', 0, 10), ev('1b', 'drive', 12, 20)])!;
  assert.deepEqual(s.steps.map((x) => x.items.length), [2, 1]);
  assert.equal(storyFromItems([]), null);
  assert.equal(formatSpan(42), '42 s');
  assert.equal(formatSpan(150), '3 min');
  assert.equal(formatSpan(3900), '1 h 5 min');
});

test('built-in alerts: a multi-camera walk is one notification', () => {
  const events = [ev('1', 'drive', 0, 20), ev('2', 'porch', 30, 60), ev('3', 'gate', 75, 90), ev('x', 'back', 2000, 2010)];
  // Cooldown let only 1 and 3 through, plus an unrelated later event.
  const { stories, singles } = bundleAlerts([events[0], events[2], events[3]], events, lineMap);
  assert.equal(stories.length, 1);
  assert.deepEqual(stories[0].cameras, ['s:drive', 's:porch', 's:gate']);
  assert.deepEqual(singles.map((i) => i.id), ['x']);
  // A story none of whose events were picked doesn't notify.
  assert.equal(bundleAlerts([events[3]], events, lineMap).stories.length, 0);
});

test('empty input', () => {
  assert.deepEqual(groupStories([], null), []);
});

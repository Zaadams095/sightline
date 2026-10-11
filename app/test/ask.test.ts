import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  acceptModelAnswer,
  buildIndex,
  composeAnswer,
  contextFor,
  matchCameras,
  parseQuestion,
  planContext,
  planToQuery,
  resolveTime,
  runQuery,
  type CameraInfo,
} from '../src/ask/engine.ts';
import { assistantSnapshot } from '../src/ask/assistant-data.ts';

/** Local time helper: a fixed Saturday afternoon, in whatever time zone the tests run. */
const at = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m).getTime() / 1000;
// Saturday, October 10, 2026, 4:00 PM.
const NOW = at(10, 16);

const cameras: CameraInfo[] = [
  { key: 'f:front_door', name: 'Front Door', door: true, zones: ['porch'] },
  { key: 'f:backyard', name: 'Back Yard' },
  { key: 'r:0', name: 'Driveway Cam', zones: ['street'] },
  { key: 'u:abc', name: 'Garage' },
];

const item = (id: string, cameraKey: string, start: number, objects: string[], extra: Record<string, unknown> = {}) => {
  const [systemId, cameraId] = cameraKey.split(':');
  return { id, systemId, cameraId, startTime: start, endTime: start + 30, severity: 'alert', objects, subLabels: [], zones: [], reviewed: false, ...extra } as never;
};

const items = [
  item('p1', 'f:front_door', at(10, 14, 12), ['person', 'package'], { zones: ['Porch'] }),
  item('k1', 'f:front_door', at(10, 15, 30), ['person'], { subLabels: ['Emma'] }),
  item('k2', 'f:front_door', at(9, 15, 45), ['person'], { subLabels: ['Emma', 'Zach'] }),
  item('y1', 'f:backyard', at(9, 23, 10), ['person']),
  item('y2', 'f:backyard', at(10, 2, 5), ['cat']),
  item('c1', 'r:0', at(8, 8), ['car']),
  item('c2', 'r:0', at(9, 18), ['car', 'person']),
  item('c3', 'r:0', at(10, 9), ['truck'], { subLabels: ['ups'] }),
  item('c4', 'r:0', at(1, 9), ['car']),
  item('d1', 'f:front_door', at(10, 11), ['doorbell', 'person']),
];

const index = buildIndex(items, cameras);
const ctx = contextFor(index, cameras, ['Zach', 'Grandma']);

test('index: names, flags, dedupe, newest first', () => {
  assert.equal(index.length, items.length);
  assert.equal(index[0].id, 'k1');
  assert.equal(index.find((e) => e.id === 'p1')?.package, true);
  assert.equal(index.find((e) => e.id === 'd1')?.doorbell, true);
  assert.equal(index.find((e) => e.id === 'p1')?.camera, 'Front Door');
  assert.deepEqual(index.find((e) => e.id === 'p1')?.zones, ['porch']);
  assert.equal(buildIndex([...items, ...items], cameras).length, items.length);
  // Carrier attributes aren't people.
  assert.deepEqual([...ctx.names].sort(), ['Emma', 'Grandma', 'Zach']);
  assert.ok(ctx.zones.includes('porch') && ctx.zones.includes('street'));
});

test('time words', () => {
  assert.deepEqual(resolveTime('today', NOW), { after: at(10, 0), before: NOW, label: 'today' });
  assert.deepEqual(resolveTime('last night', NOW), { after: at(9, 18), before: at(10, 7), label: 'last night' });
  assert.equal(resolveTime('yesterday', NOW).after, at(9, 0));
  assert.equal(resolveTime('this week', NOW).after, at(4, 0));
  assert.equal(resolveTime('this morning', NOW).before, at(10, 12));
  // Saturday afternoon: the weekend started this morning.
  assert.equal(resolveTime('this weekend', NOW).after, at(10, 0));
});

test('camera matching', () => {
  assert.deepEqual(matchCameras('anything in the backyard?', cameras), ['f:backyard']);
  assert.deepEqual(matchCameras('was anyone at the front door', cameras), ['f:front_door']);
  assert.deepEqual(matchCameras('who is at the door', cameras), ['f:front_door']);
  assert.deepEqual(matchCameras('cars in the driveway', cameras), ['r:0']);
  assert.deepEqual(matchCameras('the garage or the back yard', cameras).sort(), ['f:backyard', 'u:abc']);
  assert.deepEqual(matchCameras('did a package come', cameras), []);
  // "Front Door" beats a camera just called "Door".
  assert.deepEqual(matchCameras('front door', [...cameras, { key: 'x:d', name: 'Door' }]), ['f:front_door']);
});

test('parser: did a package come today?', () => {
  const q = parseQuestion('Did a package come today?', ctx, NOW);
  assert.equal(q.kind, 'yesno');
  assert.deepEqual(q.concepts, ['package']);
  assert.equal(q.timeLabel, 'today');
  const m = runQuery(index, q);
  assert.deepEqual(m.map((e) => e.id), ['p1']);
  assert.match(composeAnswer(q, m, ctx, NOW).text, /^Yes\. A package was seen on Front Door at 2:12/);
});

test('parser: was anyone in the backyard last night?', () => {
  const q = parseQuestion('Was anyone in the backyard last night?', ctx, NOW);
  assert.equal(q.kind, 'yesno');
  assert.deepEqual(q.cameraKeys, ['f:backyard']);
  assert.deepEqual(q.concepts, ['person']);
  assert.equal(q.timeLabel, 'last night');
  assert.deepEqual(runQuery(index, q).map((e) => e.id), ['y1']);
});

test('parser: how many cars came up the driveway this week?', () => {
  const q = parseQuestion('How many cars came up the driveway this week?', ctx, NOW);
  assert.equal(q.kind, 'count');
  assert.deepEqual(q.cameraKeys, ['r:0']);
  assert.deepEqual(q.concepts, ['vehicle']);
  const m = runQuery(index, q);
  // c4 is older than a week.
  assert.deepEqual(m.map((e) => e.id), ['c3', 'c2', 'c1']);
  assert.match(composeAnswer(q, m, ctx, NOW).text, /^I saw cars on Driveway Cam 3 times this week/);
});

test('parser: when did the kids get home? / when did Emma get home?', () => {
  const q = parseQuestion('When did the kids get home?', ctx, NOW);
  assert.equal(q.kind, 'when');
  assert.deepEqual(q.concepts, ['person']);
  const e = parseQuestion('When did Emma get home?', ctx, NOW);
  assert.deepEqual(e.names, ['Emma']);
  const m = runQuery(index, e);
  assert.deepEqual(m.map((x) => x.id), ['k1', 'k2']);
  const a = composeAnswer(e, m, ctx, NOW).text;
  assert.match(a, /^Emma was seen at 3:30 PM on Front Door\. Before that: yesterday at 3:45 PM\.$/);
});

test('parser: show me the delivery driver', () => {
  const q = parseQuestion('Show me the delivery driver', ctx, NOW);
  assert.equal(q.kind, 'list');
  assert.deepEqual(q.concepts, ['delivery']);
  assert.deepEqual(runQuery(index, q).map((e) => e.id), ['p1', 'c3']);
});

test('parser: who rang the doorbell / who is at the door', () => {
  const q = parseQuestion('Who rang the doorbell today?', ctx, NOW);
  assert.equal(q.kind, 'who');
  assert.ok(q.concepts.includes('doorbell'));
  const now = parseQuestion("Who's at the door?", ctx, NOW);
  assert.equal(now.timeLabel, 'in the last few minutes');
  assert.deepEqual(now.cameraKeys, ['f:front_door']);
  const a = composeAnswer(now, runQuery(index, now), ctx, NOW).text;
  assert.equal(a, 'Nobody was seen on Front Door in the last few minutes.');
  const today = parseQuestion('Who came to the front door today?', ctx, NOW);
  assert.match(composeAnswer(today, runQuery(index, today), ctx, NOW).text, /^Emma and someone I don't recognize were seen on Front Door today. The latest was Emma on Front Door at 3:30 PM.$/);
});

test('parser: zones, parts of day, weekdays, counts of hours', () => {
  const z = parseQuestion('anyone on the porch?', ctx, NOW);
  assert.deepEqual(z.zones, ['porch']);
  assert.deepEqual(runQuery(index, z).map((e) => e.id), ['p1']);
  const night = parseQuestion('any animals at night', ctx, NOW);
  assert.equal(night.partOfDay, 'night');
  assert.deepEqual(runQuery(index, night).map((e) => e.id), ['y2']);
  const thu = parseQuestion('what happened on thursday', ctx, NOW);
  assert.equal(thu.timeLabel, 'on Thursday');
  assert.deepEqual(runQuery(index, thu).map((e) => e.id), ['c1']);
  const hours = parseQuestion('anything in the last 3 hours?', ctx, NOW);
  assert.equal(hours.after, NOW - 3 * 3600);
  assert.equal(hours.timeLabel, 'in the last 3 hours');
});

test('no matches read plainly', () => {
  const q = parseQuestion('Did a dog come by the garage today?', ctx, NOW);
  assert.equal(composeAnswer(q, runQuery(index, q), ctx, NOW).text, "No, I didn't see an animal on Garage today.");
  const n = parseQuestion('How many bikes this week', ctx, NOW);
  assert.equal(composeAnswer(n, runQuery(index, n), ctx, NOW).text, "None. I didn't see a bike this week.");
});

test('model plan: values are checked and the parser fills gaps', () => {
  const parsed = parseQuestion('Was anyone in the backyard last night?', ctx, NOW);
  const q = planToQuery(
    { kind: 'yesno', cameras: ['back yard', 'Nonexistent'], things: ['person', 'spaceship'], people: ['Bob'], places: [], time: 'today', partOfDay: 'any' },
    ctx,
    NOW,
    parsed,
  );
  assert.deepEqual(q.cameraKeys, ['f:backyard']);
  assert.deepEqual(q.concepts, ['person']);
  assert.deepEqual(q.names, []);
  // The question said "last night", so the model's "today" doesn't override it.
  assert.equal(q.timeLabel, 'last night');

  const vague = parseQuestion('anything weird out back?', ctx, NOW);
  const q2 = planToQuery({ kind: 'nonsense', cameras: ['Back Yard'], things: ['anything'], time: 'yesterday' }, ctx, NOW, vague);
  assert.equal(q2.kind, vague.kind);
  assert.deepEqual(q2.cameraKeys, ['f:backyard']);
  assert.equal(q2.timeLabel, 'yesterday');
  assert.deepEqual(planToQuery(null, ctx, NOW, vague), { ...vague, timeGiven: false, partOfDay: undefined });

  const pc = planContext(ctx, NOW);
  assert.deepEqual(pc.cameras, ['Front Door', 'Back Yard', 'Driveway Cam', 'Garage']);
  assert.match(pc.now, /Saturday, October 10, 2026 at 4:00/);
});

test('model answers that invent details are rejected', () => {
  const q = parseQuestion('Did a package come today?', ctx, NOW);
  const a = composeAnswer(q, runQuery(index, q), ctx, NOW);
  assert.ok(acceptModelAnswer('Yes! A package arrived at your Front Door at 2:12 PM.', a.facts, ctx));
  assert.ok(!acceptModelAnswer('Yes, a package arrived at 3:15 PM.', a.facts, ctx));
  assert.ok(!acceptModelAnswer('Yes, Zach dropped off a package.', a.facts, ctx));
  assert.ok(!acceptModelAnswer('Yes, at the Garage.', a.facts, ctx));
  assert.ok(!acceptModelAnswer('No packages today.', a.facts, ctx));
  assert.ok(!acceptModelAnswer('x'.repeat(400), a.facts, ctx));
  const none = parseQuestion('Did a package come yesterday?', ctx, NOW);
  const b = composeAnswer(none, runQuery(index, none), ctx, NOW);
  assert.ok(!acceptModelAnswer('Yes, one came.', b.facts, ctx));
  assert.ok(acceptModelAnswer('No, no packages showed up yesterday.', b.facts, ctx));
});

test('Siri summary: recent events, one picture per camera, open packages', () => {
  const withThumbs = buildIndex(
    items.map((i) => ({ ...(i as object), thumbnailUrl: `http://nvr/thumb/${(i as { id: string }).id}.webp` })) as never[],
    cameras,
  );
  const { data, images } = assistantSnapshot(
    withThumbs,
    cameras,
    [{ cameraKey: 'f:front_door', since: at(10, 14, 12), thumbnailUrl: 'http://nvr/thumb/p1.webp' }],
    NOW,
  );
  // 48 hours: Thursday morning's car (c1) and older are left out.
  assert.ok(!data.events.some((e) => e.id === 'c1' || e.id === 'c4'));
  assert.equal(data.events[0].id, 'k1');
  // The newest event per camera carries that camera's picture; older ones don't.
  assert.equal(data.events.find((e) => e.id === 'k1')?.image, 'siri/img/f_front_door.img');
  assert.equal(data.events.find((e) => e.id === 'p1')?.image, null);
  assert.equal(data.events.find((e) => e.id === 'y2')?.image, 'siri/img/f_backyard.img');
  assert.deepEqual(
    images.map((j) => j.path).sort(),
    ['siri/img/f_backyard.img', 'siri/img/f_front_door.img', 'siri/img/pkg-f_front_door.img', 'siri/img/r_0.img'],
  );
  assert.deepEqual(data.packages, [{ key: 'f:front_door', camera: 'Front Door', since: at(10, 14, 12), image: 'siri/img/pkg-f_front_door.img' }]);
  assert.deepEqual(data.cameras[0], { key: 'f:front_door', name: 'Front Door', door: true });
  // Relative (proxy) thumbnails can't be downloaded by the extension: no picture.
  const rel = assistantSnapshot(buildIndex([item('z', 'u:abc', NOW - 60, ['person'], { thumbnailUrl: '/api/thumb.jpg' })], cameras), cameras, [], NOW);
  assert.equal(rel.data.events[0].image, null);
  assert.equal(rel.images.length, 0);
});

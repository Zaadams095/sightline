import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEMO_CAMERAS,
  DEMO_GROUPS,
  DEMO_RETENTION_DAYS,
  demoCameras,
  demoEventAt,
  demoEvents,
  demoMotion,
  demoPlayback,
  demoRecordingDays,
  demoSearch,
  demoSegments,
  unit,
} from '../src/systems/demo/data.ts';
import { clampView, stepView } from '../src/systems/demo/ptz.ts';

const NOW = Date.UTC(2026, 9, 11, 15, 30) / 1000;
const DAY = 86400;

test('five sample cameras covering doorbell, PTZ, outdoor and indoor', () => {
  const cams = demoCameras();
  assert.deepEqual(
    cams.map((c) => c.name),
    ['Front Door', 'Driveway', 'Backyard', 'Garage', 'Living Room'],
  );
  assert.ok(cams.every((c) => c.key === `demo:${c.id}` && c.systemId === 'demo' && c.enabled));
  assert.ok(cams.find((c) => c.id === 'front-door')!.objects.includes('doorbell'), 'front door is a video doorbell');
  assert.deepEqual(cams.filter((c) => c.ptz).map((c) => c.id), ['driveway']);
  const ids = new Set(cams.map((c) => c.id));
  for (const g of DEMO_GROUPS) for (const id of g.cameraIds) assert.ok(ids.has(id), `group camera ${id} exists`);
});

test('unit() is deterministic and in [0, 1)', () => {
  assert.equal(unit('front-door', 42), unit('front-door', 42));
  assert.notEqual(unit('front-door', 42), unit('front-door', 43));
  for (let i = 0; i < 500; i++) {
    const u = unit('x', i);
    assert.ok(u >= 0 && u < 1);
  }
});

test('events are recent, newest first, never in the future, and stable between calls', () => {
  const a = demoEvents(NOW);
  const b = demoEvents(NOW + 1);
  assert.ok(a.length > 20, `a day has plenty of activity (got ${a.length})`);
  for (let i = 1; i < a.length; i++) assert.ok(a[i - 1].startTime >= a[i].startTime);
  assert.ok(a.every((e) => e.startTime <= NOW && e.startTime >= NOW - DAY));
  // The newest event per camera is never more than a couple of slots old: it always looks live.
  const newest = Math.max(...a.map((e) => e.startTime));
  assert.ok(NOW - newest < 3 * 3600);
  // Same moment → same id and objects, however the window is asked for.
  const byId = new Map(b.map((e) => [e.id, e]));
  for (const e of a) {
    const same = byId.get(e.id);
    if (!same) continue;
    assert.equal(same.startTime, e.startTime);
    assert.deepEqual(same.objects, e.objects);
  }
});

test('the week has every kind of event the demo promises', () => {
  const week = demoEvents(NOW, { after: NOW - 7 * DAY });
  const has = (pred: (o: string[], s: string[]) => boolean) => week.some((e) => pred(e.objects, e.subLabels));
  assert.ok(has((o) => o.includes('doorbell')), 'doorbell ring');
  assert.ok(has((o) => o.includes('package')), 'package');
  assert.ok(has((o) => o.includes('car')), 'car');
  assert.ok(has((o) => o.includes('dog')), 'dog');
  assert.ok(has((o) => o.includes('person')), 'person');
  assert.ok(has((_, s) => s.includes('Sam')), 'known face');
  assert.ok(week.some((e) => e.severity === 'alert') && week.some((e) => e.severity === 'detection'));
  for (const cam of DEMO_CAMERAS) assert.ok(week.some((e) => e.cameraId === cam.id), `${cam.id} has events`);
});

test('filters: cameras, window, severity, limit, retention', () => {
  const doors = demoEvents(NOW, { cameras: ['front-door'], after: NOW - 2 * DAY });
  assert.ok(doors.length > 0 && doors.every((e) => e.cameraId === 'front-door'));
  const alerts = demoEvents(NOW, { severity: 'alert' });
  assert.ok(alerts.every((e) => e.severity === 'alert'));
  assert.equal(demoEvents(NOW, { limit: 3 }).length, 3);
  const old = demoEvents(NOW, { after: NOW - 30 * DAY });
  assert.ok(old.every((e) => e.startTime >= NOW - DEMO_RETENTION_DAYS * DAY));
  const window = demoEvents(NOW, { after: NOW - 6 * 3600, before: NOW - 3 * 3600 });
  assert.ok(window.every((e) => e.startTime >= NOW - 6 * 3600 && e.startTime <= NOW - 3 * 3600));
  assert.deepEqual(demoEvents(NOW, { after: NOW + 10 }), []);
});

test('an event still going on is reported in progress', () => {
  const ev = demoEvents(NOW, { after: NOW - 7 * DAY })[0];
  const during = demoEvents(ev.startTime + 2, { cameras: [ev.cameraId], after: ev.startTime - 1 });
  const same = during.find((e) => e.id === ev.id)!;
  assert.equal(same.endTime, null);
  assert.ok(ev.endTime! > ev.startTime);
});

test('playback lines the event clip up with the event; quiet times play the scene', () => {
  const ev = demoEvents(NOW, { cameras: ['backyard'], after: NOW - DAY })[0];
  // Openers ask for 5 s before the event.
  const pb = demoPlayback('backyard', ev.startTime - 5, NOW);
  assert.equal(pb.clip, ev.kind.clip);
  assert.equal(pb.fileStart, ev.startTime - ev.kind.lead);
  assert.equal(demoEventAt('backyard', ev.startTime - 5, NOW)?.id, ev.id);

  // Find a quiet moment (no event within a few minutes).
  let t = NOW - 3 * 3600;
  while (demoEventAt('backyard', t, NOW)) t -= 300;
  assert.deepEqual(demoPlayback('backyard', t, NOW), { clip: 'live', fileStart: t });
});

test('recordings: continuous within retention, nothing in the future', () => {
  assert.deepEqual(demoSegments(NOW - 3600, NOW + 3600, NOW), [{ start: NOW - 3600, end: NOW }]);
  assert.deepEqual(demoSegments(NOW - 30 * DAY, NOW - 29 * DAY, NOW), []);
  const days = demoRecordingDays(NOW);
  assert.equal(days.length, DEMO_RETENTION_DAYS);
  assert.ok(days.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)));
  assert.deepEqual([...days].sort().reverse(), days);
});

test('motion peaks during events and stays low otherwise', () => {
  const ev = demoEvents(NOW, { cameras: ['driveway'], after: NOW - DAY })[0];
  const pts = demoMotion('driveway', ev.startTime - 600, ev.startTime + 600, 30, NOW);
  assert.ok(pts.length > 0 && pts.every((p) => p.v >= 0 && p.v <= 100));
  const at = pts.find((p) => p.t <= ev.startTime && p.t + 30 > ev.startTime)!;
  assert.ok(at.v >= 55, 'peak during the event');
  assert.ok(pts.some((p) => p.v < 10), 'quiet otherwise');
  assert.deepEqual(demoMotion('driveway', NOW + 10, NOW + 100, 30, NOW), []);
});

test('search finds what people describe, best match first', () => {
  const pkgs = demoSearch(NOW, { query: 'person carrying a package' });
  assert.ok(pkgs.length > 0);
  assert.equal(pkgs[0].label, 'package');
  const dogs = demoSearch(NOW, { query: 'dog in the yard' });
  assert.ok(dogs.length > 0 && dogs.every((h) => h.label === 'dog'));
  const cars = demoSearch(NOW, { query: 'white pickup truck', cameras: ['driveway'] });
  assert.ok(cars.length > 0 && cars.every((h) => h.cameraId === 'driveway'));
  const sam = demoSearch(NOW, { query: 'Sam' });
  assert.ok(sam.length > 0 && sam.every((h) => h.subLabel === 'Sam'));
  assert.deepEqual(demoSearch(NOW, { query: 'giraffe' }), []);
  assert.equal(demoSearch(NOW, { query: 'person', limit: 4 }).length, 4);
  const thumbs = demoSearch(NOW, { query: 'dog' }, (s) => `file:///demo/${s}.jpg`);
  assert.match(thumbs[0].thumbnailUrl, /^file:\/\/\/demo\/backyard-event\.jpg$/);
});

test('PTZ view: held buttons move within bounds, presets glide to their target', () => {
  let v = { pan: 0, tilt: 0, zoom: 1 };
  for (let i = 0; i < 200; i++) v = stepView(v, { dp: 1, dt: 0, dz: -1 }, 0.033).view;
  assert.deepEqual(v, { pan: 1, tilt: 0, zoom: 1 });
  assert.deepEqual(clampView({ pan: -5, tilt: 5, zoom: 10 }), { pan: -1, tilt: 1, zoom: 3 });
  const target = { pan: -0.5, tilt: 0.4, zoom: 2 };
  let done = false;
  for (let i = 0; i < 200 && !done; i++) ({ view: v, done } = stepView(v, { dp: 0, dt: 0, dz: 0, target }, 0.033));
  assert.ok(done);
  assert.deepEqual(v, target);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  activeTakeover,
  addTakeover,
  clockCorner,
  clockText,
  dateLine,
  dimOpacity,
  gridShape,
  inDailyWindow,
  pixelShift,
  RING_HOLD_MS,
  rotateForBurnIn,
  statusLine,
  tourPages,
  type Takeover,
} from '../src/wall/schedule.ts';

const at = (h: number, m = 0) => new Date(2026, 9, 11, h, m);

test('night window crosses midnight', () => {
  assert.equal(inDailyWindow(at(23), '22:00', '06:30'), true);
  assert.equal(inDailyWindow(at(3), '22:00', '06:30'), true);
  assert.equal(inDailyWindow(at(6, 30), '22:00', '06:30'), false);
  assert.equal(inDailyWindow(at(12), '22:00', '06:30'), false);
  assert.equal(inDailyWindow(at(13), '12:00', '14:00'), true);
  assert.equal(inDailyWindow(at(13), '12:00', '12:00'), false);
});

test('dimming only at night and capped', () => {
  const night = { enabled: true, start: '22:00', end: '06:30', level: 0.6 };
  assert.equal(dimOpacity(night, at(23)), 0.6);
  assert.equal(dimOpacity(night, at(12)), 0);
  assert.equal(dimOpacity({ ...night, enabled: false }, at(23)), 0);
  assert.equal(dimOpacity({ ...night, level: 2 }, at(23)), 0.9);
});

test('tour pages: one camera each, or screenfuls', () => {
  const keys = ['a', 'b', 'c', 'd', 'e'];
  assert.deepEqual(tourPages(keys, 'single', 4), [['a'], ['b'], ['c'], ['d'], ['e']]);
  assert.deepEqual(tourPages(keys, 'grid', 4), [['a', 'b', 'c', 'd'], ['e']]);
  assert.deepEqual(tourPages([], 'grid', 4), []);
});

test('grid shape keeps tiles near 16:9', () => {
  assert.deepEqual(gridShape(4, 1366, 1024), { cols: 2, rows: 2 });
  assert.deepEqual(gridShape(1, 1366, 1024), { cols: 1, rows: 1 });
  const nine = gridShape(9, 1366, 1024);
  assert.equal(nine.cols * nine.rows >= 9, true);
  const two = gridShape(2, 1366, 1024);
  assert.equal(two.cols * two.rows >= 2, true);
});

test('burn-in: drift every minute, rotate tiles every 15 minutes, clock swaps corners', () => {
  const seen = new Set<string>();
  for (let m = 0; m < 9; m++) {
    const s = pixelShift(m * 60_000, 6);
    assert.ok(Math.abs(s.x) <= 6 && Math.abs(s.y) <= 6);
    seen.add(`${s.x},${s.y}`);
  }
  assert.equal(seen.size, 9);
  assert.deepEqual(pixelShift(30_000), pixelShift(0));
  assert.deepEqual(rotateForBurnIn(['a', 'b', 'c'], 0), ['a', 'b', 'c']);
  assert.deepEqual(rotateForBurnIn(['a', 'b', 'c'], 15 * 60_000), ['b', 'c', 'a']);
  assert.equal(clockCorner(0), 'left');
  assert.equal(clockCorner(31 * 60_000), 'right');
});

test('a ring takes over, beats alerts, then the tour comes back', () => {
  const t0 = 1_000_000;
  let list: Takeover[] = [];
  list = addTakeover(list, { kind: 'alert', cameraKey: 's:drive', at: t0, title: 'Person · Driveway' }, t0);
  assert.equal(activeTakeover(list, t0 + 1000)?.cameraKey, 's:drive');
  list = addTakeover(list, { kind: 'ring', cameraKey: 's:door', at: t0 + 2000, title: 'Someone’s at the door' }, t0 + 2000);
  list = addTakeover(list, { kind: 'alert', cameraKey: 's:back', at: t0 + 3000, title: 'Car · Back' }, t0 + 3000);
  // The ring wins even though the alert is newer.
  assert.equal(activeTakeover(list, t0 + 4000)?.kind, 'ring');
  // After the ring's hold time, nothing is left (the alerts were shorter).
  assert.equal(activeTakeover(list, t0 + 2000 + RING_HOLD_MS + 1), null);
  // A repeat ring for the same camera replaces the old one.
  list = addTakeover(list, { kind: 'ring', cameraKey: 's:door', at: t0 + 5000, title: 'again' }, t0 + 5000);
  assert.equal(list.filter((t) => t.kind === 'ring').length, 1);
});

test('clock, date and status line', () => {
  assert.equal(clockText(at(21, 5)), '9:05');
  assert.equal(clockText(at(0, 7)), '12:07');
  assert.equal(clockText(at(21, 5), true), '21:05');
  assert.equal(dateLine(at(9)), 'Sunday, October 11');
  assert.equal(statusLine(6, 0), '6 cameras · all connected');
  assert.equal(statusLine(1, 1), '1 camera · 1 not connected');
  assert.equal(statusLine(0, 0), 'No cameras');
});

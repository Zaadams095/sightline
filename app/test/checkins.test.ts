import assert from 'node:assert/strict';
import { test } from 'node:test';

import { atTimeOfDay, dayKey, whenText, zonedToUnix } from '../src/alerts/clock.ts';
import { DEFAULT_CHECKIN, dueCheckIn, markOk, newState, nextByTime, observe, type CheckIn, type CheckInState } from '../src/alerts/checkins.ts';

// Shared fixtures: bridge/checkins_test.go runs the same schedule against the Hub.
const TZ = 'America/Chicago';
const at = (y: number, m: number, d: number, h: number, mi = 0) => zonedToUnix(y, m, d, h, mi, TZ);
const mom: CheckIn = {
  ...DEFAULT_CHECKIN,
  id: 'mom',
  who: 'Mom',
  systemId: 'hub',
  cameras: ['kitchen', 'hall'],
  cameraNames: { kitchen: 'Kitchen', hall: 'Hallway' },
  timezone: TZ,
  byTime: '10:00',
  quietLimitHours: 6,
  summaryTime: '20:00',
};
const ev = (id: string, t: number, camera = 'kitchen', objects = ['person']) => ({ id, camera, start: t, end: t + 20, objects, zones: [] });

test('no activity by 10:00: one gentle notice naming the last activity', () => {
  let st: CheckInState = newState(at(2026, 10, 1, 8));
  st = observe(mom, st, ev('a', at(2026, 10, 1, 21, 15) - 20), at(2026, 10, 1, 21, 15));
  // Next morning, 9:59: nothing yet.
  assert.equal(dueCheckIn(mom, st, at(2026, 10, 2, 9, 59)).notices.length, 0);
  const r = dueCheckIn(mom, st, at(2026, 10, 2, 10, 0));
  assert.deepEqual(r.notices, [
    { kind: 'by-time', title: 'No activity at Mom’s yet today', body: 'It’s 10:00 AM. Kitchen was last active yesterday at 9:15 PM.' },
  ]);
  // Only once.
  assert.equal(dueCheckIn(mom, r.state, at(2026, 10, 2, 10, 1)).notices.length, 0);
});

test('activity before the deadline: no notice; summary counts the day', () => {
  let st = newState(at(2026, 10, 1, 8));
  st = observe(mom, st, ev('a', at(2026, 10, 2, 7, 42)), at(2026, 10, 2, 7, 43));
  st = observe(mom, st, ev('a', at(2026, 10, 2, 7, 42)), at(2026, 10, 2, 7, 44)); // update of the same event
  st = observe(mom, st, ev('b', at(2026, 10, 2, 9, 0), 'hall'), at(2026, 10, 2, 9, 1));
  st = observe(mom, st, ev('x', at(2026, 10, 2, 9, 5), 'garage'), at(2026, 10, 2, 9, 6)); // not a check-in camera
  assert.equal(dueCheckIn(mom, st, at(2026, 10, 2, 10)).notices.length, 0);
  st = observe(mom, st, ev('c', at(2026, 10, 2, 13, 0)), at(2026, 10, 2, 13, 1));
  // (Quiet since 1 PM would also speak at 8 PM; this test is about the summary.)
  const r = dueCheckIn({ ...mom, quietLimitHours: null }, st, at(2026, 10, 2, 20, 0));
  assert.deepEqual(r.notices, [{ kind: 'summary', title: 'All normal at Mom’s', body: 'First activity 7:42 AM · 3 moments today.' }]);
});

test('six quiet hours during the day; "Mom’s fine" restarts the clock', () => {
  let st = newState(at(2026, 10, 1, 8));
  st = observe(mom, st, ev('a', at(2026, 10, 2, 8, 30) - 20), at(2026, 10, 2, 8, 30));
  assert.equal(dueCheckIn(mom, st, at(2026, 10, 2, 14, 29)).notices.length, 0);
  const r = dueCheckIn(mom, st, at(2026, 10, 2, 14, 30));
  assert.deepEqual(r.notices.map((n) => [n.kind, n.title, n.body]), [
    ['quiet', 'No activity at Mom’s for 6 hours', 'Kitchen was last active today at 8:30 AM.'],
  ]);
  assert.equal(dueCheckIn(mom, r.state, at(2026, 10, 2, 15)).notices.length, 0);
  const ok = markOk(r.state, at(2026, 10, 2, 14, 35));
  assert.equal(dueCheckIn(mom, ok, at(2026, 10, 2, 20, 34)).notices.filter((n) => n.kind === 'quiet').length, 0);
  // Outside the day window (after 21:00) the quiet rule sleeps.
  assert.equal(dueCheckIn({ ...mom, summaryTime: null }, ok, at(2026, 10, 2, 22)).notices.length, 0);
});

test('a check-in set up mid-morning does not claim "nothing yet today"', () => {
  const st = newState(at(2026, 10, 2, 11));
  assert.equal(dueCheckIn(mom, st, at(2026, 10, 2, 11, 1)).notices.length, 0);
  // Tomorrow it's watched from midnight.
  assert.equal(dueCheckIn(mom, st, at(2026, 10, 3, 10)).notices[0]?.kind, 'by-time');
});

test('quiet hours: waits unless check-ins may come through', () => {
  const st = newState(at(2026, 10, 1, 8));
  assert.equal(dueCheckIn({ ...mom, duringQuietHours: false }, st, at(2026, 10, 2, 10), true).notices.length, 0);
  assert.equal(dueCheckIn(mom, st, at(2026, 10, 2, 10), true).notices.length, 1);
});

test('DST: 10:00 local on both change days, and the day boundary follows local midnight', () => {
  // US DST ends Nov 1 2026 (25-hour day) and starts Mar 8 2026 (23-hour day).
  assert.equal(atTimeOfDay(at(2026, 11, 1, 0, 30), '10:00', TZ), Date.UTC(2026, 10, 1, 16) / 1000); // CST −6
  assert.equal(atTimeOfDay(at(2026, 10, 31, 23), '10:00', TZ), Date.UTC(2026, 9, 31, 15) / 1000); // CDT −5
  assert.equal(atTimeOfDay(at(2026, 3, 8, 1), '10:00', TZ), Date.UTC(2026, 2, 8, 15) / 1000); // CDT −5
  assert.equal(dayKey(Date.UTC(2026, 10, 2, 5, 30) / 1000, TZ), '2026-11-01'); // 23:30 CST
  assert.equal(dayKey(Date.UTC(2026, 10, 2, 6, 0) / 1000, TZ), '2026-11-02');
  // A skipped time resolves like Go's time.Date (an hour earlier).
  assert.equal(zonedToUnix(2026, 3, 8, 2, 30, TZ), Date.UTC(2026, 2, 8, 7, 30) / 1000);
  // The schedule fires at 10:00 local on the fall-back day.
  const st = newState(at(2026, 10, 30, 8));
  assert.equal(dueCheckIn(mom, st, Date.UTC(2026, 10, 1, 15, 59) / 1000).notices.length, 0);
  assert.equal(dueCheckIn(mom, st, Date.UTC(2026, 10, 1, 16, 0) / 1000).notices[0]?.body.startsWith('It’s 10:00 AM.'), true);
  // Next pre-armed reminder: tomorrow 10:00 local across the change.
  assert.equal(nextByTime(mom, undefined, at(2026, 10, 31, 12)), Date.UTC(2026, 10, 1, 16) / 1000);
  assert.equal(nextByTime(mom, undefined, at(2026, 11, 1, 9)), Date.UTC(2026, 10, 1, 16) / 1000);
});

test('when text', () => {
  const now = at(2026, 10, 7, 12);
  assert.equal(whenText(at(2026, 10, 7, 9, 5), now, TZ), 'today at 9:05 AM');
  assert.equal(whenText(at(2026, 10, 5, 0, 0), now, TZ), 'on Monday at 12:00 AM');
  assert.equal(whenText(at(2026, 9, 20, 18, 0), now, TZ), 'on Sep 20 at 6:00 PM');
});

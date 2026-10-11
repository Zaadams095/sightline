import assert from 'node:assert/strict';
import { test } from 'node:test';

import { clearPackage, PICKUP_GRACE_SEC, reminderPlan, updatePackages } from '../src/alerts/packages.ts';

const ev = (id: string, start: number, end: number | null, objects: string[], cam = 'front') =>
  ({ id, systemId: 's', cameraId: cam, startTime: start, endTime: end, severity: 'alert', objects, subLabels: [], zones: [], reviewed: false }) as never;

test('delivery is reported once per camera', () => {
  const a = updatePackages({}, [ev('d1', 1000, 1030, ['person', 'package'])], 1100);
  assert.deepEqual(a.delivered.map((p) => p.reviewId), ['d1']);
  assert.ok(a.state['s:front']);
  const b = updatePackages(a.state, [ev('d2', 2000, 2010, ['package'])], 2100);
  assert.equal(b.delivered.length, 0);
  assert.equal(b.state['s:front'].lastSeen, 2010);
  // Other cameras are independent.
  const c = updatePackages(b.state, [ev('x', 2100, 2110, ['package'], 'porch')], 2200);
  assert.deepEqual(c.delivered.map((p) => p.cameraKey), ['s:porch']);
});

test('person after delivery, package not seen again: picked up after the grace period', () => {
  const a = updatePackages({}, [ev('d1', 1000, 1030, ['person', 'package'])], 1100);
  const b = updatePackages(a.state, [ev('p1', 5000, 5060, ['person'])], 5100);
  assert.equal(b.pickedUp.length, 0);
  assert.equal(b.state['s:front'].personAfter, 5060);
  const c = updatePackages(b.state, [], 5060 + PICKUP_GRACE_SEC);
  assert.deepEqual(c.pickedUp.map((p) => p.reviewId), ['d1']);
  assert.equal(c.state['s:front'], undefined);
});

test('package seen again after the person cancels the pickup', () => {
  const a = updatePackages({}, [ev('d1', 1000, 1030, ['package'])], 1100);
  const b = updatePackages(a.state, [ev('p1', 5000, 5060, ['person']), ev('k', 5200, 5210, ['package'])], 5300);
  assert.equal(b.state['s:front'].personAfter, undefined);
  const c = updatePackages(b.state, [], 5300 + PICKUP_GRACE_SEC * 3);
  assert.equal(c.pickedUp.length, 0);
});

test('in-progress person events and the delivery event itself are not pickups', () => {
  const a = updatePackages({}, [ev('d1', 1000, null, ['person', 'package'])], 1010);
  const b = updatePackages(a.state, [ev('d1', 1000, 1040, ['person', 'package']), ev('p', 1100, null, ['person'])], 1200);
  assert.equal(b.state['s:front'].personAfter, undefined);
  assert.equal(b.state['s:front'].lastSeen, 1040);
});

test('delivered and picked up in one late batch stays quiet', () => {
  const out = updatePackages({}, [ev('d1', 1000, 1030, ['package']), ev('p1', 2000, 2050, ['person'])], 2050 + PICKUP_GRACE_SEC + 1);
  assert.equal(out.delivered.length, 0);
  assert.equal(out.pickedUp.length, 0);
  assert.deepEqual(out.state, {});
});

test('evening reminder plan', () => {
  const { state } = updatePackages({}, [ev('d1', 1000, 1030, ['package'])], 1100);
  const morning = new Date(2026, 4, 1, 9, 0);
  const plan = reminderPlan(state, '19:30', { 's:front': 'Front Door' }, morning)!;
  assert.equal(plan.title, 'A package is still at Front Door');
  const at = new Date(plan.at * 1000);
  assert.equal(at.getDate(), 1);
  assert.equal(at.getHours(), 19);
  assert.equal(at.getMinutes(), 30);
  // After the reminder time it moves to tomorrow.
  const late = reminderPlan(state, '19:30', {}, new Date(2026, 4, 1, 21, 0))!;
  assert.equal(new Date(late.at * 1000).getDate(), 2);
  // Seen in the app, or cleared: no reminder.
  assert.equal(reminderPlan({ 's:front': { ...state['s:front'], noReminder: true } }, '19:30', {}, morning), null);
  assert.equal(reminderPlan(clearPackage(state, 's:front'), '19:30', {}, morning), null);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { namedAlert, selectNotifications } from '../src/alerts/rules.ts';

const settings = (over: Record<string, unknown> = {}) =>
  ({
    mode: 'built-in',
    cooldownSec: 0,
    rules: {},
    quietFor: ['Dad'],
    alwaysFor: ['Dog walker'],
    snoozed: {},
    health: { enabled: true, storagePct: 90 },
    presence: { enabled: false, atHome: false, alertWhenHome: [] },
    quietHours: { enabled: false, start: '23:00', end: '06:30' },
    // Only cars alert on this camera, and only "alert" severity.
    defaultRule: { enabled: true, objects: ['car'], zones: [], severities: ['alert'] },
    ...over,
  }) as never;

const item = (id: string, subLabels: string[], severity = 'detection') =>
  ({ id, systemId: 's', cameraId: 'front', startTime: 100, endTime: null, severity, objects: ['person'], subLabels, zones: [], reviewed: false }) as never;

test('on-device names behave like system names: quiet list and always-alert list', () => {
  assert.equal(namedAlert(item('a', ['Dog walker']), ['Dog walker']), true);
  assert.equal(namedAlert(item('a', []), ['Dog walker']), false);
  assert.equal(namedAlert(item('a', ['Dad']), undefined), false);
  const out = selectNotifications([item('walker', ['Dog walker']), item('dad', ['Dad']), item('nobody', [])], settings(), {});
  // The walker alerts despite the car-only filter; Dad and the unmatched person don't.
  assert.deepEqual(out.map((i: { id: string }) => i.id), ['walker']);
});

test('always-alert still respects a camera turned off and snoozes', () => {
  const off = settings({ defaultRule: { enabled: false, objects: [], zones: [], severities: [] } });
  assert.equal(selectNotifications([item('walker', ['Dog walker'])], off, {}).length, 0);
  const snoozed = settings({ snoozed: { 's:front': 9e12 } });
  assert.equal(selectNotifications([item('walker', ['Dog walker'])], snoozed, {}).length, 0);
});

test('settings without alwaysFor (older versions) still work', () => {
  const s = settings({ alwaysFor: undefined });
  assert.equal(selectNotifications([item('walker', ['Dog walker'], 'alert')], s, {}).length, 0);
});

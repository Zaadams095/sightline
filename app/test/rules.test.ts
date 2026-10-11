import assert from 'node:assert/strict';
import { test } from 'node:test';

import { inQuietHours, nextTimeOfDay, onlyKnown, selectNotifications } from '../src/alerts/rules.ts';

const settings = (over: Record<string, unknown> = {}) =>
  ({
    mode: 'built-in',
    cooldownSec: 0,
    rules: {},
    quietFor: ['Zach'],
    snoozed: {},
    health: { enabled: true, storagePct: 90 },
    presence: { enabled: false, atHome: false, alertWhenHome: [] },
    quietHours: { enabled: false, start: '23:00', end: '06:30' },
    defaultRule: { enabled: true, objects: [], zones: [], severities: [] },
    ...over,
  }) as never;

const item = (id: string, cam: string, subLabels: string[] = []) =>
  ({ id, systemId: 's', cameraId: cam, startTime: 100, endTime: null, severity: 'alert', objects: ['person'], subLabels, zones: [], reviewed: false }) as never;

test('known people stay quiet, strangers alert', () => {
  assert.equal(onlyKnown(item('a', 'f', ['Zach']), ['Zach']), true);
  assert.equal(onlyKnown(item('b', 'f', ['Zach', 'Bob']), ['Zach']), false);
  const out = selectNotifications([item('known', 'front', ['Zach']), item('stranger', 'front')], settings(), {});
  assert.deepEqual(out.map((i: { id: string }) => i.id), ['stranger']);
});

test('snooze and home mode', () => {
  const at = new Date(1000 * 1000);
  const s = settings({ snoozed: { 's:back': 2000 }, presence: { enabled: true, atHome: true, alertWhenHome: ['s:door'] } });
  const out = selectNotifications([item('1', 'back'), item('2', 'yard'), item('3', 'door')], s, {}, at);
  assert.deepEqual(out.map((i: { id: string }) => i.id), ['3']);
});

test('quiet hours across midnight; next 7am', () => {
  const q = { enabled: true, start: '23:00', end: '06:30' };
  assert.equal(inQuietHours(q, new Date(2026, 0, 1, 23, 30)), true);
  assert.equal(inQuietHours(q, new Date(2026, 0, 1, 12, 0)), false);
  const from = new Date(2026, 0, 1, 22, 0);
  assert.equal(new Date(nextTimeOfDay(7, 0, from) * 1000).getHours(), 7);
});

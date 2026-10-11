import assert from 'node:assert/strict';
import { test } from 'node:test';

import { allowsSpecial, isFreshRing, notificationTitle, selectNotifications } from '../src/alerts/rules.ts';

const settings = (over: Record<string, unknown> = {}) =>
  ({
    mode: 'built-in',
    cooldownSec: 600,
    rules: {},
    quietFor: ['Zach'],
    snoozed: {},
    health: { enabled: true, storagePct: 90 },
    presence: { enabled: false, atHome: false, alertWhenHome: [] },
    quietHours: { enabled: false, start: '23:00', end: '06:30' },
    defaultRule: { enabled: true, objects: ['person'], zones: ['porch'], severities: ['alert'] },
    ...over,
  }) as never;

const ring = (id: string, start: number, subLabels: string[] = []) =>
  ({ id, systemId: 's', cameraId: 'door', startTime: start, endTime: null, severity: 'detection', objects: ['doorbell'], subLabels, zones: [], reviewed: false }) as never;

test('doorbell rings skip object/zone/cooldown/known filters but honor snooze and off', () => {
  const out = selectNotifications([ring('a', 100, ['Zach']), ring('b', 110)], settings(), {});
  assert.deepEqual(out.map((i: { id: string }) => i.id), ['a', 'b']);
  assert.equal(selectNotifications([ring('a', 100)], settings({ snoozed: { 's:door': 9e12 } }), {}).length, 0);
  const off = { 's:door': { enabled: false, objects: [], zones: [], severities: [] } };
  assert.equal(selectNotifications([ring('a', 100)], settings({ rules: off }), {}).length, 0);
});

test('fresh rings and titles', () => {
  assert.equal(isFreshRing(ring('a', 1000), 1060), true);
  assert.equal(isFreshRing(ring('a', 1000), 1000 + 600), false);
  assert.equal(isFreshRing({ objects: ['person'], startTime: 1000 }, 1001), false);
  assert.equal(notificationTitle({ objects: ['doorbell'] }, 'Front Door', 'Doorbell'), "Someone's at the door · Front Door");
  assert.equal(notificationTitle({ objects: ['person'] }, 'Yard', 'Person'), 'Person · Yard');
});

test('special notifications honor quiet hours and home mode', () => {
  assert.equal(allowsSpecial(settings(), 's:door', new Date(2026, 0, 1, 12)), true);
  const quiet = settings({ quietHours: { enabled: true, start: '23:00', end: '06:30' } });
  assert.equal(allowsSpecial(quiet, 's:door', new Date(2026, 0, 1, 23, 30)), false);
  assert.equal(allowsSpecial(settings({ presence: { enabled: true, atHome: true, alertWhenHome: [] } }), 's:door'), false);
});

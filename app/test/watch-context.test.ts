import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildWatchContext, MAX_WATCH_ALERTS, parseWatchRequest } from '../src/watch/context.ts';

const cam = (systemId: string, id: string, name: string, extra: Record<string, unknown> = {}) =>
  ({ key: `${systemId}:${id}`, systemId, id, name, enabled: true, zones: [], objects: [], ptz: false, aspect: 16 / 9, ...extra }) as never;

const item = (systemId: string, cameraId: string, id: string, startTime: number, objects = ['person']) =>
  ({ item: { id, systemId, cameraId, startTime, endTime: null, severity: 'alert', objects, subLabels: [], zones: [], reviewed: false }, title: 'Person', cameraName: cameraId }) as never;

const systems = [
  { id: 'hub-1', kind: 'hub', name: 'Home', endpoint: { lanUrl: 'http://192.168.1.20:8086/', useTunnel: false }, extra: { remoteUrl: 'https://home.ts.net/', hubName: 'Home Hub' } },
  { id: 'nvr', kind: 'reolink', name: 'NVR', endpoint: { lanUrl: 'http://192.168.1.30', useTunnel: true } },
] as never;

test('cameras: enabled only, doorbells marked, Hub cameras point at their Hub', () => {
  const ctx = buildWatchContext({
    cameras: [cam('hub-1', 'front', 'Front Doorbell'), cam('nvr', '1', 'Garage'), cam('nvr', '2', 'Off', { enabled: false })],
    alerts: [],
    systems,
    now: 1000,
  });
  assert.deepEqual(ctx.cameras, [
    { key: 'hub-1:front', id: 'front', name: 'Front Doorbell', doorbell: true, hub: 'hub-1' },
    { key: 'nvr:1', id: '1', name: 'Garage', doorbell: false },
  ]);
  assert.deepEqual(ctx.hubs, [{ id: 'hub-1', name: 'Home Hub', lanUrl: 'http://192.168.1.20:8086', remoteUrl: 'https://home.ts.net' }]);
  // No secrets in the context: tokens travel separately.
  assert.ok(!JSON.stringify(ctx).includes('token'));
});

test('alerts: newest first, de-duplicated, capped; a fresh ring is surfaced', () => {
  const alerts = [item('nvr', '1', 'a', 100), item('nvr', '1', 'a', 100), item('hub-1', 'front', 'r', 950, ['doorbell'])];
  for (let i = 0; i < 30; i++) alerts.push(item('nvr', '1', `x${i}`, 10 + i));
  const ctx = buildWatchContext({ cameras: [], alerts, systems, now: 1000 });
  assert.equal(ctx.alerts.length, MAX_WATCH_ALERTS);
  assert.equal(ctx.alerts[0].id, 'r');
  assert.equal(ctx.alerts.filter((a) => a.id === 'a').length, 1);
  assert.equal(ctx.ring?.id, 'r');
  assert.equal(ctx.ring?.doorbell, true);

  // Three minutes later it's history, not a ring.
  assert.equal(buildWatchContext({ cameras: [], alerts, systems, now: 950 + 181 }).ring, null);
  // A ring the phone just saw wins even before the recorder lists it.
  const live = { id: 'now', key: 'nvr:1', title: 'Doorbell', camera: 'Garage', time: 1190, doorbell: true };
  assert.equal(buildWatchContext({ cameras: [], alerts, systems, now: 1200, ring: live }).ring?.id, 'now');
});

test('parseWatchRequest', () => {
  assert.deepEqual(parseWatchRequest('{"type":"snapshot","key":"nvr:1","size":480}'), { type: 'snapshot', key: 'nvr:1', size: 480 });
  assert.deepEqual(parseWatchRequest('{"type":"snapshot","key":"nvr:1","size":99999}'), { type: 'snapshot', key: 'nvr:1', size: 300 });
  assert.deepEqual(parseWatchRequest('{"type":"refresh"}'), { type: 'refresh' });
  assert.equal(parseWatchRequest('{"type":"snapshot","key":"nokey"}'), null);
  assert.equal(parseWatchRequest('not json'), null);
});

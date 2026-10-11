import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  failReason,
  loginChallenge,
  memoLabels,
  parseAlerts,
  parseCamList,
  parseClips,
  parseDisks,
  parseDuration,
  zoneNames,
} from '../src/systems/blue-iris-parse.ts';

test('login challenge string', () => {
  assert.equal(loginChallenge('zach', 'abc123', 'pw'), 'zach:abc123:pw');
  assert.match(failReason({ result: 'fail', data: { reason: 'Invalid username or password' } }), /username or password/);
  assert.equal(failReason({ result: 'fail', data: { reason: 'Invalid session' } }), 'session');
});

test('camlist keeps real cameras, drops groups, cycles and hidden', () => {
  const data = [
    { optionDisplay: 'All cameras', optionValue: 'index', group: ['Front', 'Drive'], xsize: 2, ysize: 1 },
    { optionDisplay: '+All cameras cycle', optionValue: '@index', group: ['Front', 'Drive'] },
    { optionDisplay: 'Front Door', optionValue: 'Front', isEnabled: true, isOnline: true, ptz: false, width: 2560, height: 1440 },
    { optionDisplay: 'Driveway', optionValue: 'Drive', isEnabled: true, isOnline: false, ptz: true, width: 1920, height: 1080 },
    { optionDisplay: 'Spare', optionValue: 'Spare', isEnabled: true, isOnline: true, isNoSignal: true },
    { optionDisplay: 'Hidden', optionValue: 'Hid', hidden: true },
  ];
  const cams = parseCamList(data);
  assert.deepEqual(cams.map((c) => c.id), ['Front', 'Drive', 'Spare']);
  assert.equal(cams[0].name, 'Front Door');
  assert.equal(cams[0].aspect, 16 / 9);
  assert.equal(cams[1].ptz, true);
  assert.deepEqual(cams.filter((c) => c.offline).map((c) => c.id), ['Drive', 'Spare']);
});

test('alert memo, flags and zones', () => {
  assert.deepEqual(memoLabels('person:87%,car:65%'), ['person', 'car']);
  assert.deepEqual(memoLabels('nothing found'), []);
  assert.deepEqual(memoLabels('dog:91%'), ['dog']);
  assert.deepEqual(zoneNames(5), ['Zone A', 'Zone C']);
  assert.equal(parseDuration('0:15 (1.2MB)'), 15);
  assert.equal(parseDuration('1:02:03'), 3723);

  const alerts = parseAlerts([
    {
      camera: 'Front',
      path: '@123456789.bvr',
      clip: '@123450000.bvr',
      offset: 30500,
      flags: (1 << 16) | (1 << 28),
      zones: 1,
      date: 1717000000,
      memo: 'person:87%',
      filesize: '0:12 (2.0MB)',
    },
    { camera: 'Drive', path: '@99.jpg', clip: '@-1.bvr', flags: 1 << 27, date: 1717000100, memo: '' },
    { camera: 'Drive', path: '@100.jpg', flags: 1 << 23, date: 1717000200, memo: 'nothing found' },
  ]);
  assert.equal(alerts[0].id, '@123456789');
  assert.equal(alerts[0].end, 1717000012);
  assert.equal(alerts[0].offsetMs, 30500);
  assert.equal(alerts[0].confirmed, true);
  assert.deepEqual(alerts[0].zones, ['Zone A']);
  assert.deepEqual(alerts[1].objects, ['car']);
  assert.equal(alerts[1].clip, undefined);
  assert.equal(alerts[2].cancelled, true);
});

test('clip list → spans; snapshots skipped', () => {
  const clips = parseClips([
    { camera: 'Front', path: '@1.bvr', date: 1000, msec: 3600000, filesize: '1:00:00 (2GB)' },
    { camera: 'Front', path: '@2.bvr', date: 5000, filesize: '0:30 (5MB)' },
    { camera: 'Front', path: '@3.jpg', date: 6000, filesize: 'Snapshot' },
  ]);
  assert.deepEqual(
    clips.map((c) => [c.path, c.start, c.end]),
    [
      ['@1.bvr', 1000, 4600],
      ['@2.bvr', 5000, 5030],
    ],
  );
});

test('status disks (MiB) → percent and GB', () => {
  assert.deepEqual(parseDisks({ disks: [{ disk: 'V:', allocated: 1841152, used: 1563676, free: 343444, total: 1907599 }] }), [
    { path: 'V:', usedPct: 82, freeGb: 335.4 },
  ]);
  assert.deepEqual(parseDisks({ discs: [{ disk: 'C:', free: 512, total: 1024 }] }), [{ path: 'C:', usedPct: 50, freeGb: 0.5 }]);
});

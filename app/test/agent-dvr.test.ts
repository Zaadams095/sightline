import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseEvents, parseObjects, parseStorage, sizeToGb, thumbName, ticksToUnix } from '../src/systems/agent-dvr-parse.ts';

test('getObjects → cameras only, PTZ from ptzid', () => {
  const body = {
    objectList: [
      { id: 1, typeID: 2, name: 'Front Door', data: { online: true, connected: true, ptzid: -1, width: 1920, height: 1080 } },
      { id: 2, typeID: 2, name: 'Garage PTZ', data: { online: true, connected: false, ptzid: 7, mjpegStreamWidth: 640, mjpegStreamHeight: 480 } },
      { id: 1, typeID: 1, name: 'Mic', data: { online: true } },
      { id: 3, typeID: 2, name: ' ', data: { online: false } },
    ],
    locations: [{ name: 'Home' }],
  };
  const cams = parseObjects(body);
  assert.deepEqual(cams.map((c) => c.id), ['1', '2', '3']);
  assert.equal(cams[0].ptz, false);
  assert.equal(cams[1].ptz, true);
  assert.equal(cams[1].aspect, 4 / 3);
  assert.equal(cams[1].connected, false);
  assert.equal(cams[2].name, 'Camera 3');
  assert.equal(cams[2].enabled, false);
});

test('events: .NET ticks, durations, tags, thumbnails', () => {
  // 2021-01-21T16:34:42Z in ticks.
  const ticks = 621355968000000000 + 1611246882 * 1e7;
  assert.equal(ticksToUnix(ticks), 1611246882);
  const recs = parseEvents('3', {
    events: [
      { fn: '3_2021-01-21_16-34-42_977.mp4', tg: 'person,car', c: ticks, d: 25, sb: 1234567 },
      { fn: '3_2021-01-21_16-30-00_001.mp4', tg: '', c: String(ticks - 282 * 1e7), d: '10' },
      { fn: 'broken.mp4' },
    ],
  });
  assert.equal(recs.length, 2);
  assert.deepEqual(recs[0].labels, ['person', 'car']);
  assert.equal(recs[0].end - recs[0].start, 25);
  assert.equal(recs[1].start, 1611246600);
  assert.equal(thumbName('3_2021-01-21_16-34-42_977.mp4'), '3_2021-01-21_16-34-42_977_large.jpg');
});

test('system stats disks', () => {
  assert.equal(sizeToGb('1.5 TB'), 1536);
  assert.equal(sizeToGb('512 MB'), 0.5);
  assert.deepEqual(parseStorage({ disks: [{ n: 'C:\\', d: '120.5 GB', u: '379.5 GB', p: 76 }] }), [
    { path: 'C:\\', usedPct: 76, freeGb: 120.5 },
  ]);
});

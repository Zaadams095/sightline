import assert from 'node:assert/strict';
import { test } from 'node:test';

import { authFailure, groupEvents, livePath, parseMonitors, parseVideos } from '../src/systems/shinobi-parse.ts';

const parse = (s: string) => Date.parse(s) / 1000;

test('auth failure is a 200 with ok:false', () => {
  assert.equal(authFailure({ ok: false, msg: 'Not Authorized' }), 'Not Authorized');
  assert.equal(authFailure([]), null);
});

test('monitors: details as object or string, PTZ, status', () => {
  const cams = parseMonitors([
    { mid: 'frontdoor', ke: 'grp', name: 'Front Door', mode: 'record', status: 'Recording', width: 1920, height: 1080, details: { stream_type: 'hls', control: '1' } },
    { mid: 'yard', name: 'Yard', mode: 'start', status: 'Died', width: '1280', height: '960', details: '{"stream_type":"mjpeg","control":"0"}' },
    { mid: 'old', name: 'Old', mode: 'stop', status: 'Stopped', details: '{"stream_type":"flv"}' },
  ]);
  assert.equal(cams[0].ptz, true);
  assert.equal(cams[0].online, true);
  assert.equal(cams[1].aspect, 4 / 3);
  assert.equal(cams[1].streamType, 'mjpeg');
  assert.equal(cams[1].failed, true);
  assert.equal(cams[2].enabled, false);
  assert.equal(cams[2].failed, false);
  assert.deepEqual(livePath('KEY', 'grp', 'frontdoor', 'hls'), { kind: 'hls', path: '/KEY/hls/grp/frontdoor/s.m3u8' });
  assert.deepEqual(livePath('KEY', 'grp', 'yard', 'mjpeg'), { kind: 'mjpeg', path: '/KEY/mjpeg/grp/yard' });
  assert.equal(livePath('KEY', 'grp', 'old', 'flv'), null);
});

test('videos keep the server offset and href', () => {
  const v = parseVideos(
    {
      videos: [
        {
          mid: 'frontdoor',
          time: '2024-05-01T13:05:00-04:00',
          end: '2024-05-01T13:20:00-04:00',
          ext: 'mp4',
          filename: '2024-05-01T13-05-00.mp4',
          href: '/KEY/videos/grp/frontdoor/2024-05-01T13-05-00.mp4',
        },
        { mid: 'frontdoor', time: '2024-05-01T13:20:00-04:00', ext: 'mp4', href: '/KEY/videos/grp/frontdoor/b.mp4' },
      ],
    },
    parse,
  );
  assert.equal(v[0].start, Date.UTC(2024, 4, 1, 17, 5) / 1000);
  assert.equal(v[0].end - v[0].start, 900);
  assert.equal(v[1].end - v[1].start, 60);
});

test('event rows merge into review items', () => {
  const rows = [
    { mid: 'frontdoor', time: '2024-05-01T17:05:00Z', details: { reason: 'motion' } },
    { mid: 'frontdoor', time: '2024-05-01T17:05:04Z', details: '{"reason":"object","matrices":[{"tag":"person","confidence":0.9}]}' },
    { mid: 'frontdoor', time: '2024-05-01T17:09:00Z', details: { reason: 'motion' } },
    { mid: 'yard', time: '2024-05-01T17:05:02Z', details: { reason: 'object', matrices: [{ tag: 'Dog' }] } },
  ];
  const g = groupEvents(rows, parse);
  assert.equal(g.length, 3);
  const first = g.find((x) => x.cameraId === 'frontdoor' && x.objects.length)!;
  assert.deepEqual(first.objects, ['person']);
  assert.equal(first.end - first.start, 5);
  assert.equal(g.find((x) => x.cameraId === 'yard')!.objects[0], 'dog');
  assert.equal(g[0].motionOnly, true); // newest first: the 17:09 motion-only item
});

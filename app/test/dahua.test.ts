import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  classifyEvents,
  deviceOffset,
  filesToDays,
  filesToReview,
  filesToSegments,
  findFileQuery,
  fromDeviceTime,
  isErrorBody,
  livePath,
  parseChannels,
  parseEventChannels,
  parseFindNext,
  parseFinderId,
  parseKv,
  parsePresets,
  parsePtzCaps,
  parseStorage,
  playbackPath,
  ptzCode,
  rtspUrl,
  toDeviceTime,
  toPlaybackTime,
} from '../src/systems/dahua-format.ts';

const CRLF = (lines: string[]) => lines.join('\r\n') + '\r\n';

test('key=value bodies, including padded keys from older firmware', () => {
  const kv = parseKv(CRLF(['table.ChannelTitle[0].Name=Front Door', 'items[0]. Channel =1', 'junk', 'result=OK=yes']));
  assert.equal(kv['table.ChannelTitle[0].Name'], 'Front Door');
  assert.equal(kv['items[0].Channel'], '1');
  assert.equal(kv.result, 'OK=yes');
  assert.equal(isErrorBody('Error\r\nBad Request!\r\n'), true);
  assert.equal(isErrorBody('OK\r\n'), false);
});

test('channel titles become 1-based cameras; empty NVR slots are disabled', () => {
  const titles = parseKv(
    CRLF(['table.ChannelTitle[0].Name=Driveway', 'table.ChannelTitle[1].Name=', 'table.ChannelTitle[2].Name=Back Yard']),
  );
  const remote = parseKv(
    CRLF([
      'table.RemoteDevice.uuid:System_CONFIG_NETCAMERA_INFO_0.Enable=true',
      'table.RemoteDevice.uuid:System_CONFIG_NETCAMERA_INFO_0.Address=192.168.1.108',
      'table.RemoteDevice.uuid:System_CONFIG_NETCAMERA_INFO_1.Enable=false',
    ]),
  );
  assert.deepEqual(parseChannels(titles, remote), [
    { channel: 1, name: 'Driveway', enabled: true },
    { channel: 2, name: 'Camera 2', enabled: false },
    { channel: 3, name: 'Back Yard', enabled: true },
  ]);
  // A single camera has no RemoteDevice table.
  assert.deepEqual(parseChannels(parseKv('table.ChannelTitle[0].Name=IPC\r\n')), [{ channel: 1, name: 'IPC', enabled: true }]);
});

test('device-local time round-trips through the measured offset', () => {
  // Device shows 21:02:32 when the phone's UTC clock reads 03:02:30 the next day → UTC−6 (MDT), 2 s fast.
  const phone = Date.UTC(2026, 9, 11, 3, 2, 30);
  const off = deviceOffset('result=2026-10-10 21:02:32\r\n', phone);
  assert.equal(off, -6 * 3600 + 2);
  const t = fromDeviceTime('2026-10-10 20:00:00', off)!;
  assert.equal(t, Date.UTC(2026, 9, 11, 2, 0, 0) / 1000 - 2);
  assert.equal(toDeviceTime(t, off), '2026-10-10 20:00:00');
  assert.equal(toPlaybackTime(t, off), '2026_10_10_20_00_00');
  // Non-padded dates from the docs ("2011-7-3 9:02:32") parse too.
  assert.equal(fromDeviceTime('2011-7-3 9:02:32', 0), Date.UTC(2011, 6, 3, 9, 2, 32) / 1000);
  assert.throws(() => deviceOffset('Error\r\n', phone));
});

test('findFile query uses 1-based channel and encoded device times', () => {
  const q = findFileQuery({
    objectId: '2086170840',
    channel: 2,
    start: '2026-10-10 00:00:00',
    end: '2026-10-10 23:59:59',
    types: ['dav'],
    events: ['VideoMotion'],
  });
  assert.equal(
    q,
    'action=findFile&object=2086170840&condition.Channel=2&condition.StartTime=2026-10-10%2000%3A00%3A00&condition.EndTime=2026-10-10%2023%3A59%3A59&condition.Types[0]=dav&condition.Events[0]=VideoMotion',
  );
  assert.equal(parseFinderId('result=2086170840\r\n'), '2086170840');
  assert.equal(parseFinderId('Error\r\n'), null);
});

const FIND_NEXT = CRLF([
  'found=4',
  'items[0].Channel=1',
  'items[0].Cluster=0',
  'items[0].Disk=0',
  'items[0].Duration=1800',
  'items[0].EndTime=2026-10-10 12:30:00',
  'items[0].Events[0]=VideoMotion',
  'items[0].Events[1]=SmartMotionHuman',
  'items[0].FilePath=/mnt/dvr/mmc0p2_0/2026-10-10/1/dav/12/12.00.00-12.30.00[M][0@0][0].dav',
  'items[0].Flags[0]=Event',
  'items[0].Length=104857600',
  'items[0].StartTime=2026-10-10 12:00:00',
  'items[0].Type=dav',
  'items[0].VideoStream=Main',
  'items[1].Channel=1',
  'items[1].EndTime=2026-10-10 13:00:00',
  'items[1].FilePath=/mnt/dvr/mmc0p2_0/2026-10-10/1/dav/12/12.30.01-13.00.00[R][0@0][0].dav',
  'items[1].Flags[0]=Timing',
  'items[1].StartTime=2026-10-10 12:30:01',
  'items[1].Type=dav',
  'items[2].Channel=1',
  'items[2].EndTime=2026-10-10 12:10:05',
  'items[2].Events[0]=SmartMotionHuman',
  'items[2].FilePath=/mnt/dvr/mmc0p2_0/2026-10-10/1/jpg/12/10/04[M][0@0][0].jpg',
  'items[2].StartTime=2026-10-10 12:10:04',
  'items[2].Type=jpg',
  'items[3].Channel=1',
  'items[3].EndTime=2026-10-11 00:20:00',
  'items[3].Events[0]=VideoMotion',
  'items[3].FilePath=/mnt/dvr/x.dav',
  'items[3].StartTime=2026-10-10 23:50:00',
  'items[3].Type=dav',
]);

test('findNextFile replies parse into files (reply Channel is 0-based)', () => {
  const { found, files } = parseFindNext(FIND_NEXT);
  assert.equal(found, 4);
  assert.equal(files.length, 4);
  assert.equal(files[0].channel, 2);
  assert.deepEqual(files[0].events, ['VideoMotion', 'SmartMotionHuman']);
  assert.deepEqual(files[0].flags, ['Event']);
  assert.equal(files[2].type, 'jpg');
  assert.deepEqual(parseFindNext('found=0\r\n'), { found: 0, files: [] });
});

test('recordings merge into spans; days are device-local, newest first', () => {
  const { files } = parseFindNext(FIND_NEXT);
  const segs = filesToSegments(files, 0);
  const at = (s: string) => Date.UTC(2026, 9, Number(s.slice(0, 2)), Number(s.slice(3, 5)), Number(s.slice(6, 8))) / 1000;
  assert.deepEqual(segs, [
    { start: at('10 12:00'), end: at('10 13:00') },
    { start: at('10 23:50'), end: at('11 00:20') },
  ]);
  assert.deepEqual(filesToDays(files), ['2026-10-11', '2026-10-10']);
});

test('event recordings become review items with picture thumbnails', () => {
  const { files } = parseFindNext(FIND_NEXT);
  const items = filesToReview(files, { systemId: 'sys', offsetSec: 0, thumbUrl: (p) => `http://gw/cgi-bin/RPC_Loadfile${p}` });
  assert.equal(items.length, 2);
  const [late, person] = items; // newest first
  assert.deepEqual(late.objects, ['motion']);
  assert.equal(late.severity, 'detection');
  assert.equal(late.thumbnailUrl, undefined);
  assert.deepEqual(person.objects, ['person']);
  assert.equal(person.severity, 'alert');
  assert.equal(person.cameraId, '2');
  assert.equal(person.id, `2@${Date.UTC(2026, 9, 10, 12) / 1000}`);
  assert.equal(person.thumbnailUrl, 'http://gw/cgi-bin/RPC_Loadfile/mnt/dvr/mmc0p2_0/2026-10-10/1/jpg/12/10/04[M][0@0][0].jpg');
});

test('event code classification', () => {
  assert.deepEqual(classifyEvents(['SmartMotionVehicle']), { objects: ['vehicle'], severity: 'alert' });
  assert.deepEqual(classifyEvents(['CrossLineDetection']), { objects: ['motion'], severity: 'alert' });
  assert.deepEqual(classifyEvents(['VideoMotion', 'SmartMotionHuman', 'SmartMotionVehicle']), {
    objects: ['person', 'vehicle'],
    severity: 'alert',
  });
  assert.equal(classifyEvents(['Timing']), null);
  assert.equal(classifyEvents([]), null);
});

test('PTZ codes, presets and capabilities', () => {
  assert.equal(ptzCode('MOVE_UP'), 'Up');
  assert.equal(ptzCode('ZOOM_IN'), 'ZoomTele');
  assert.equal(ptzCode('ZOOM_OUT'), 'ZoomWide');
  assert.equal(ptzCode('STOP'), null);
  const presets = parsePresets(
    parseKv(CRLF(['presets[0].Index=1', 'presets[0].Name=Gate', 'presets[1].Index=2', 'presets[1].Name=Gate', 'presets[2].Index=5', 'presets[2].Name='])),
  );
  assert.deepEqual(presets, [
    { index: 1, name: 'Gate' },
    { index: 2, name: 'Gate (2)' },
    { index: 5, name: 'Preset 5' },
  ]);
  assert.deepEqual(parsePtzCaps(parseKv(CRLF(['caps.Pan=true', 'caps.Tile=true', 'caps.Zoom=false']))), { canMove: true, canZoom: false });
  assert.deepEqual(parsePtzCaps({}), { canMove: false, canZoom: false });
});

test('health: video loss channels and disk usage', () => {
  assert.deepEqual(parseEventChannels('channels[0]=0\r\nchannels[1]=3\r\n'), [1, 4]);
  assert.deepEqual(parseEventChannels('Error\r\n'), []);
  const disks = parseStorage(
    parseKv(
      CRLF([
        'list.info[0].Detail[0].IsError=false',
        'list.info[0].Detail[0].Path=/dev/sda1',
        'list.info[0].Detail[0].TotalBytes=2000000000000.000000',
        'list.info[0].Detail[0].UsedBytes=1500000000000.000000',
        'list.info[0].Name=/dev/sda',
        'list.info[0].State=Success',
      ]),
    ),
  );
  assert.deepEqual(disks, [{ path: '/dev/sda1', usedPct: 75, freeGb: 500 }]);
});

test('RTSP live and playback URLs', () => {
  const live = rtspUrl({ host: '192.168.1.108', port: 554, user: 'admin', pass: 'p@ss#1', path: livePath(3, 'sub') });
  assert.equal(live, 'rtsp://admin:p%40ss%231@192.168.1.108:554/cam/realmonitor?channel=3&subtype=1');
  const start = Date.UTC(2026, 9, 10, 18, 30, 5) / 1000;
  assert.equal(
    playbackPath(1, start, start + 600, -6 * 3600),
    '/cam/playback?channel=1&starttime=2026_10_10_12_30_05&endtime=2026_10_10_12_40_05',
  );
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildRtspUrl,
  canReuseAfterRejection,
  clockFromDeviceNow,
  fileCacheCovers,
  snapUrl,
  dayChunks,
  defaultRtspPath,
  enableRtspBody,
  errorMessage,
  fileAt,
  filesToReview,
  isLoginExpired,
  mergeSegments,
  parseChannels,
  parseDevInfo,
  parseEnc,
  parseLogin,
  parseNetPort,
  parseNvrDownload,
  parsePresets,
  parseResponse,
  parseRtspUrls,
  parseSearchFiles,
  parseSearchStatus,
  parseVodName,
  ptzBody,
  ptzSupport,
  unixToWall,
  vodFileUrl,
  wallToUnix,
  type DeviceClock,
} from '../src/systems/reolink-parse.ts';

// Fixed UTC+2 device so results don't depend on the machine running the tests.
const CEST: DeviceClock = { offsetMin: 120, phoneZone: false };

test('playback reuses cached files only when they answer the seek', () => {
  const w = { year: 2024, mon: 5, day: 1, hour: 0, min: 0, sec: 0 };
  const file = (start: number, end: number) => ({ start, end, startWall: w, endWall: w, triggers: null });
  const t = (h: number, m: number) => Date.UTC(2024, 4, 1, h, m) / 1000;
  // Searched 09:45–10:30 earlier: it knows a 09:58 file but nothing about 09:30.
  const cache = { after: t(9, 45), before: t(10, 30), at: t(10, 30), files: [file(t(9, 58), t(10, 3))] };
  assert.equal(fileCacheCovers(cache, t(9, 30), t(10, 30)), false);
  assert.equal(fileCacheCovers(cache, t(10, 0), t(11, 0)), true); // a cached file contains the start
  assert.equal(fileCacheCovers(cache, t(9, 50), t(10, 20)), true); // window fully searched (a gap)
  // A window reaching past when the search ran can have newer files.
  assert.equal(fileCacheCovers({ ...cache, before: t(11, 0), at: t(10, 30) }, t(10, 10), t(10, 50)), false);
  assert.equal(fileCacheCovers(undefined, t(10, 0), t(10, 5)), false);
});

test('snapshot URL works before the first sign-in', () => {
  assert.equal(
    snapUrl({ base: 'http://127.0.0.1:5000', channel: 0, token: 'abc' }),
    'http://127.0.0.1:5000/cgi-bin/api.cgi?cmd=Snap&channel=0&rs=sightline&token=abc',
  );
  assert.equal(
    snapUrl({ base: 'http://gw', channel: 2, user: 'admin', password: 'p&w d', sub: { width: 640, height: 360 } }),
    'http://gw/cgi-bin/api.cgi?cmd=Snap&channel=2&rs=sightline&snapType=sub&width=640&height=360&user=admin&password=p%26w%20d',
  );
});

test('a rejected token triggers one sign-in, not one per request', () => {
  const now = 1_000_000;
  // Another request already replaced the rejected token: reuse it.
  assert.equal(canReuseAfterRejection({ token: 'new', expires: now + 60_000 }, 'old', now), true);
  // The rejected token is still current: sign in again.
  assert.equal(canReuseAfterRejection({ token: 'old', expires: now + 60_000 }, 'old', now), false);
  assert.equal(canReuseAfterRejection({ token: 'new', expires: now - 1 }, 'old', now), false);
});

test('login: token and lease; wrong password and lockout are plain language', () => {
  const ok = parseResponse('[{"cmd":"Login","code":0,"value":{"Token":{"leaseTime":3600,"name":"e1d5b8a2c3f4a1b"}}}]');
  assert.deepEqual(parseLogin(ok), { token: 'e1d5b8a2c3f4a1b', leaseSec: 3600 });

  const bad = parseResponse('[ { "cmd" : "Login", "code" : 1, "error" : { "detail" : "login failed", "rspCode" : -7 } } ]');
  assert.throws(() => parseLogin(bad), /rejected the username or password/);

  const locked = [{ cmd: 'Login', code: 1, error: { detail: 'Login has been locked', rspCode: -31 } }];
  assert.throws(() => parseLogin(locked), /locked this account/);

  assert.throws(() => parseResponse('<html>404 Not Found</html>'), /doesn’t seem to be a Reolink device/);
});

test('rspCode -6 means sign in again', () => {
  const [item] = parseResponse('[{"cmd":"GetDevInfo","code":1,"error":{"detail":"please login first","rspCode":-6}}]');
  assert.equal(isLoginExpired(item), true);
  assert.equal(isLoginExpired({ cmd: 'GetDevInfo', code: 0, value: {} }), false);
  assert.match(errorMessage({ cmd: 'Login', code: 1, error: { detail: 'max session', rspCode: -5 } }), /Too many apps/);
});

test('device info and channels: NVR lists online channels, a camera is channel 0', () => {
  const nvr = parseDevInfo({
    DevInfo: { B485: 0, IOInputNum: 0, buildDay: 'build 23061923', cfgVer: 'v3.1.0.0', channelNum: 8, detail: 'NVR', exactType: 'NVR', model: 'RLN8-410', name: 'Home NVR', type: 'NVR' },
  });
  assert.equal(nvr.isNvr, true);
  assert.equal(nvr.channelNum, 8);
  const status = {
    count: 8,
    status: [
      { channel: 0, name: 'Front Door', online: 1, typeInfo: 'Reolink Video Doorbell PoE' },
      { channel: 1, name: 'Driveway', online: 1, typeInfo: 'RLC-810A' },
      { channel: 2, name: '', online: 0, typeInfo: '' },
      { channel: 3, online: 1 },
    ],
  };
  assert.deepEqual(
    parseChannels(nvr, status).map((c) => [c.channel, c.name]),
    [
      [0, 'Front Door'],
      [1, 'Driveway'],
      [3, 'Camera 4'],
    ],
  );

  const cam = parseDevInfo({ DevInfo: { channelNum: 1, exactType: 'IPC', model: 'RLC-520A', name: 'Garden', type: 'IPC' } });
  assert.equal(cam.isNvr, false);
  assert.deepEqual(parseChannels(cam, undefined), [{ channel: 0, name: 'Garden', online: true }]);

  const hub = parseDevInfo({ DevInfo: { channelNum: 8, exactType: 'HOMEHUB', model: 'Reolink Home Hub', name: 'Hub', type: 'HOMEHUB' } });
  assert.equal(hub.isHub && hub.isNvr, true);
});

test('PTZ support follows ptzType versions', () => {
  const ability = { Ability: { abilityChn: [{ ptzType: { permit: 0, ver: 0 } }, { ptzType: { permit: 6, ver: 2 }, ptzPreset: { permit: 7, ver: 1 } }, { ptzType: { ver: 1 } }] } };
  assert.deepEqual(ptzSupport(ability, 0), { canMove: false, canZoom: false });
  assert.deepEqual(ptzSupport(ability, 1), { canMove: true, canZoom: true });
  assert.deepEqual(ptzSupport(ability, 2), { canMove: false, canZoom: true });
  assert.deepEqual(ptzBody(1, 'Left', { speed: 32 }), [{ cmd: 'PtzCtrl', action: 0, param: { channel: 1, op: 'Left', speed: 32 } }]);
  assert.deepEqual(ptzBody(1, 'Stop', { speed: 32 }), [{ cmd: 'PtzCtrl', action: 0, param: { channel: 1, op: 'Stop' } }]);
  assert.deepEqual(ptzBody(1, 'ToPos', { id: 3 }), [{ cmd: 'PtzCtrl', action: 0, param: { channel: 1, op: 'ToPos', id: 3 } }]);
  const presets = parsePresets({
    PtzPreset: [
      { channel: 1, enable: 1, id: 0, name: 'Gate' },
      { channel: 1, enable: 0, id: 1, name: 'pos1' },
      { channel: 1, enable: 1, id: 2, name: 'Garage' },
    ],
  });
  assert.deepEqual([...presets], [['Gate', 0], ['Garage', 2]]);
});

test('RTSP: classic path, GetRtspUrl path, encoded credentials, enabling the port', () => {
  assert.equal(defaultRtspPath(0, 'main'), '/h264Preview_01_main');
  assert.equal(defaultRtspPath(11, 'sub', 'h265'), '/h265Preview_12_sub');
  const urls = parseRtspUrls({ rtspUrl: { channel: 0, mainStream: 'rtsp://192.168.1.20:554/Preview_01_main', subStream: 'rtsp://192.168.1.20:554/Preview_01_sub' } });
  assert.equal(urls.main, '/Preview_01_main');
  assert.equal(
    buildRtspUrl({ host: '192.168.1.20', port: 554, user: 'admin', password: 'p@ss:w/rd#1', path: '/h264Preview_01_main' }),
    'rtsp://admin:p%40ss%3Aw%2Frd%231@192.168.1.20:554/h264Preview_01_main',
  );
  const enc = parseEnc({ Enc: { audio: 0, channel: 0, mainStream: { bitRate: 6144, frameRate: 25, height: 2160, size: '3840*2160', vType: 'h265', width: 3840 }, subStream: { height: 360, vType: 'h264', width: 640 } } });
  assert.deepEqual(enc.main, { vType: 'h265', width: 3840, height: 2160 });
  assert.equal(enc.sub.vType, 'h264');

  const net = parseNetPort({ NetPort: { httpEnable: 1, httpPort: 80, httpsEnable: 1, httpsPort: 443, mediaPort: 9000, onvifEnable: 0, onvifPort: 8000, rtmpEnable: 0, rtmpPort: 1935, rtspEnable: 0, rtspPort: 554 } });
  assert.equal(net.rtspEnabled, false);
  const body = enableRtspBody(net);
  assert.equal(body[0].param.NetPort.rtspEnable, 1);
  assert.equal(body[0].param.NetPort.httpsPort, 443);
  assert.equal(body[0].param.NetPort.onvifEnable, 0);
});

test('device clock: offset from the device’s current wall time', () => {
  const now = Date.UTC(2024, 6, 1, 10, 0, 0);
  const clock = clockFromDeviceNow({ year: 2024, mon: 7, day: 1, hour: 12, min: 0, sec: 7 }, now, -300);
  assert.deepEqual(clock, { offsetMin: 120, phoneZone: false });
  assert.equal(clockFromDeviceNow({ year: 2024, mon: 7, day: 1, hour: 12, min: 0, sec: 0 }, now, 120).phoneZone, true);
  const w = { year: 2024, mon: 7, day: 1, hour: 12, min: 0, sec: 0 };
  assert.equal(wallToUnix(w, CEST), now / 1000);
  assert.deepEqual(unixToWall(now / 1000, CEST), w);
});

test('day chunks cover the range newest first in device days', () => {
  const after = wallToUnix({ year: 2024, mon: 7, day: 1, hour: 22, min: 0, sec: 0 }, CEST);
  const before = wallToUnix({ year: 2024, mon: 7, day: 3, hour: 1, min: 30, sec: 0 }, CEST);
  const chunks = dayChunks(after, before, CEST);
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks[0][0], { year: 2024, mon: 7, day: 3, hour: 0, min: 0, sec: 0 });
  assert.deepEqual(chunks[0][1], { year: 2024, mon: 7, day: 3, hour: 1, min: 30, sec: 0 });
  assert.deepEqual(chunks[2][0], { year: 2024, mon: 7, day: 1, hour: 22, min: 0, sec: 0 });
  assert.deepEqual(chunks[2][1], { year: 2024, mon: 7, day: 1, hour: 23, min: 59, sec: 59 });
});

test('file names: trigger flags as decoded by reolink_aio', () => {
  // Motion recording, older camera firmware.
  assert.deepEqual(parseVodName('Mp4Record/2020-12-22/RecM01_20201222_075939_080140_6D28808_1A468F9.mp4'), {
    person: false, vehicle: false, animal: false, timer: false, motion: true, doorbell: false, package: false,
  });
  // Person + motion, newer 7-part name.
  const p = parseVodName('Mp4Record/2025-02-19/RecS07_20250219_111146_111238_0_A714C0A000_21E67C.mp4')!;
  assert.equal(p.person, true);
  assert.equal(p.motion, true);
  assert.equal(p.vehicle, false);
  // Home Hub 9-part name parses (flags layout v2).
  assert.ok(parseVodName('/mnt/sda/123-Cam/Mp4Record/2024-08-27/RecM02_DST20240827_090302_090334_0_800_800_033C820000_61B6F0.mp4'));
  assert.equal(parseVodName('2023-04-17 01-59-57.mp4'), null);
  assert.equal(parseVodName('no-extension'), null);
});

const SEARCH_VALUE = {
  SearchResult: {
    channel: 0,
    File: [
      {
        EndTime: { year: 2025, mon: 2, day: 19, hour: 11, min: 12, sec: 38 },
        StartTime: { year: 2025, mon: 2, day: 19, hour: 11, min: 11, sec: 46 },
        frameRate: 0,
        height: 0,
        name: 'Mp4Record/2025-02-19/RecS07_20250219_111146_111238_0_A714C0A000_21E67C.mp4',
        size: 2221692,
        type: 'main',
        width: 0,
      },
      {
        EndTime: { year: 2025, mon: 2, day: 19, hour: 10, min: 5, sec: 0 },
        StartTime: { year: 2025, mon: 2, day: 19, hour: 10, min: 0, sec: 0 },
        name: 'Mp4Record/2025-02-19/RecM01_20250219_100000_100500_6D28808_1A468F9.mp4',
        size: '113246208',
        type: 'main',
      },
      {
        EndTime: { year: 2025, mon: 2, day: 19, hour: 10, min: 10, sec: 0 },
        StartTime: { year: 2025, mon: 2, day: 19, hour: 10, min: 5, sec: 1 },
        PlaybackTime: { year: 2025, mon: 2, day: 19, hour: 9, min: 5, sec: 1 },
        size: '113246208',
        type: 'main',
      },
    ],
    Status: [{ mon: 2, table: '0000000000000000001100000000', year: 2025 }],
  },
};

test('search results: files, segments, days, events', () => {
  const files = parseSearchFiles(SEARCH_VALUE, CEST);
  assert.equal(files.length, 3);
  assert.equal(files[0].start, Date.UTC(2025, 1, 19, 8, 0, 0) / 1000);
  assert.equal(files[2].name, 'Mp4Record/2025-02-19/RecS07_20250219_111146_111238_0_A714C0A000_21E67C.mp4');
  assert.equal(files[1].triggers, null);

  const segs = mergeSegments(files);
  assert.equal(segs.length, 2);
  assert.equal(segs[0].end - segs[0].start, 600);

  assert.deepEqual(parseSearchStatus(SEARCH_VALUE), ['2025-02-19', '2025-02-20']);

  const review = filesToReview(files, 'sys', '0');
  assert.equal(review.length, 2);
  const person = review.find((r) => r.objects.includes('person'))!;
  assert.equal(person.severity, 'alert');
  assert.equal(person.id, `0:${files[2].start}`);
  const motion = review.find((r) => !r.objects.length)!;
  assert.equal(motion.severity, 'detection');

  const t = files[0].start + 30;
  assert.equal(fileAt(files, t), files[0]);
  assert.equal(fileAt(files, files[0].start - 100, files[0].start + 10), files[0]);
  assert.equal(fileAt(files, files[2].end + 5), undefined);
});

test('recording URLs: Playback on cameras, Download on recorders, token included', () => {
  const startWall = { year: 2025, mon: 2, day: 19, hour: 11, min: 11, sec: 46 };
  const name = 'Mp4Record/2025-02-19/RecS07_20250219_111146_111238_0_A714C0A000_21E67C.mp4';
  assert.equal(
    vodFileUrl({ base: 'http://127.0.0.1:5123', fileName: name, startWall, nvr: false, token: 'abc' }),
    `http://127.0.0.1:5123/cgi-bin/api.cgi?cmd=Playback&source=${name}&output=sightline_20250219111146.mp4&start=20250219111146&token=abc`,
  );
  assert.match(vodFileUrl({ base: 'http://x', fileName: name, startWall, nvr: true, token: 't' }), /cmd=Download&/);
  assert.equal(
    parseNvrDownload({ fileList: [{ fileName: '01_20250219100501.mp4', fileSize: '1000' }, { fileName: '01_big.mp4', fileSize: '5000' }] }),
    '01_big.mp4',
  );
});

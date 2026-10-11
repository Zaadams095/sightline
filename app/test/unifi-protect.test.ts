import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  eventToReview,
  eventsQuery,
  exportPath,
  mapCameras,
  nextOpticalZoom,
  nextZoom,
  offlineCameras,
  pickChannel,
  presetNames,
  protectLoginMessage,
  protectRtspUrl,
  relativeMove,
  storageOf,
  withRtspEnabled,
  type ProtectBootstrap,
  type ProtectEvent,
} from '../src/systems/unifi-protect-format.ts';

const channels = (rtsp: boolean) => [
  { id: 0, name: 'High', enabled: true, isRtspEnabled: rtsp, rtspAlias: rtsp ? 'AbCdHigh' : null, width: 2688, height: 1512 },
  { id: 1, name: 'Medium', enabled: true, isRtspEnabled: false, rtspAlias: null, width: 1280, height: 720 },
  { id: 2, name: 'Low', enabled: true, isRtspEnabled: rtsp, rtspAlias: rtsp ? 'AbCdLow' : null, width: 640, height: 360 },
];

// Trimmed from a real /proxy/protect/api/bootstrap reply.
const BOOT: ProtectBootstrap = {
  nvr: {
    name: 'UDM Pro',
    ports: { rtsp: 7447, rtsps: 7441 },
    systemInfo: { storage: { size: 4_000_000_000_000, used: 3_000_000_000_000, available: 1_000_000_000_000 } },
  },
  cameras: [
    {
      id: '64b2a1f0',
      name: 'Front Door',
      marketName: 'G4 Doorbell Pro',
      state: 'CONNECTED',
      isConnected: true,
      isAdopted: true,
      channels: [...channels(true), { id: 3, name: 'Package Camera', enabled: true, isRtspEnabled: true, rtspAlias: 'Pkg', width: 1600, height: 1200 }],
      featureFlags: { isDoorbell: true, hasSmartDetect: true, smartDetectTypes: ['person', 'vehicle', 'package'], canOpticalZoom: false, isPtz: false },
    },
    {
      id: '64b2a1f1',
      name: 'Garage',
      state: 'DISCONNECTED',
      isConnected: false,
      isAdopted: true,
      channels: channels(false),
      featureFlags: { hasSmartDetect: true, smartDetectTypes: ['person'], smartDetectAudioTypes: ['alrmSmoke'], canOpticalZoom: true, isPtz: false },
    },
    {
      id: '64b2a1f2',
      name: 'Yard PTZ',
      isConnected: true,
      isAdopted: true,
      channels: channels(true),
      featureFlags: { hasSmartDetect: true, smartDetectTypes: [], isPtz: true, zoom: { steps: { min: 0, max: 2010, step: 1 } } },
    },
    { id: 'pending', name: 'New camera', isAdopted: false, channels: [] },
  ],
};

test('bootstrap maps to cameras: doorbell, smart labels, PTZ/zoom, adopted only', () => {
  const cams = mapCameras(BOOT, 'sys');
  assert.deepEqual(
    cams.map((c) => c.id),
    ['64b2a1f0', '64b2a1f1', '64b2a1f2'],
  );
  const [door, garage, ptz] = cams;
  assert.equal(door.key, 'sys:64b2a1f0');
  assert.deepEqual(door.objects, ['motion', 'person', 'vehicle', 'package', 'doorbell']);
  assert.equal(door.ptz, false);
  assert.equal(door.aspect, 2688 / 1512);
  assert.deepEqual(garage.objects, ['motion', 'person', 'smoke alarm']);
  assert.equal(garage.ptz, true); // optical zoom
  assert.equal(ptz.ptz, true);
});

test('health: disconnected cameras and recording drive', () => {
  assert.deepEqual(offlineCameras(BOOT), ['64b2a1f1']);
  assert.deepEqual(storageOf(BOOT), [{ path: 'Recording drive', usedPct: 75, freeGb: 1000 }]);
  assert.deepEqual(storageOf({}), []);
});

test('channel choice and RTSP URL; package lens never chosen', () => {
  const door = BOOT.cameras![0];
  assert.equal(pickChannel(door, 'main')?.rtspAlias, 'AbCdHigh');
  assert.equal(pickChannel(door, 'sub')?.rtspAlias, 'AbCdLow');
  const garage = BOOT.cameras![1];
  assert.equal(pickChannel(garage, 'main')?.rtspAlias, null);
  assert.deepEqual(
    withRtspEnabled(garage).map((c) => c.isRtspEnabled),
    [true, true, true],
  );
  assert.equal(protectRtspUrl('192.168.1.1', 'AbCdHigh'), 'rtsp://192.168.1.1:7447/AbCdHigh');
  assert.equal(protectRtspUrl('fd00::1', 'x', 7447), 'rtsp://[fd00::1]:7447/x');
});

test('events query: ms times and repeated types', () => {
  assert.equal(
    eventsQuery({ after: 1000, before: 2000.5, limit: 50 }),
    'start=1000000&end=2000500&limit=50&orderDirection=DESC&types=motion&types=smartDetectZone&types=smartDetectLine&types=smartAudioDetect&types=ring',
  );
});

const thumb = (id: string) => `http://gw/proxy/protect/api/events/${id}/thumbnail`;
const opts = { systemId: 'sys', thumbUrl: thumb };

test('doorbell ring → doorbell alert', () => {
  const ring: ProtectEvent = { id: 'ev1', type: 'ring', start: 1_760_000_000_000, end: 1_760_000_001_000, camera: '64b2a1f0', smartDetectTypes: [] };
  const item = eventToReview(ring, opts)!;
  assert.deepEqual(item.objects, ['doorbell']);
  assert.equal(item.severity, 'alert');
  assert.equal(item.startTime, 1_760_000_000);
  assert.equal(item.endTime, 1_760_000_001);
  assert.equal(item.cameraId, '64b2a1f0');
  assert.equal(item.thumbnailUrl, thumb('ev1'));
});

test('smart detections, plates/faces, motion, and ignored types', () => {
  const smart: ProtectEvent = {
    id: 'ev2',
    type: 'smartDetectZone',
    start: 1_760_000_100_000,
    end: null,
    camera: '64b2a1f2',
    smartDetectTypes: ['vehicle', 'licensePlate'],
    metadata: { detectedThumbnails: [{ type: 'vehicle', name: 'ABC123', group: { name: 'ABC123', matchedName: 'Mom’s car' } }] },
  };
  const item = eventToReview(smart, opts)!;
  assert.deepEqual(item.objects, ['vehicle']);
  assert.deepEqual(item.subLabels, ['Mom’s car']);
  assert.equal(item.endTime, null);

  const audio = eventToReview({ id: 'a', type: 'smartAudioDetect', start: 1, cameraId: 'c', smartDetectTypes: ['alrmSmoke'] }, opts)!;
  assert.deepEqual(audio.objects, ['smoke alarm']);

  const motion = eventToReview({ id: 'm', type: 'motion', start: 5000, end: 9000, camera: 'c' }, opts)!;
  assert.deepEqual(motion.objects, ['motion']);
  assert.equal(motion.severity, 'detection');

  assert.equal(eventToReview({ id: 'x', type: 'cameraDisconnected', start: 1, camera: 'c' }, opts), null);
  assert.equal(eventToReview({ id: 'y', type: 'motion', start: 1 }, opts), null);
});

test('video export path (ms)', () => {
  assert.equal(exportPath('cam 1', 100.2, 160.7), '/proxy/protect/api/video/export?camera=cam%201&start=100200&end=160700&channel=0');
});

test('PTZ helpers', () => {
  assert.deepEqual(
    presetNames([
      { id: 'b', name: 'Gate', slot: 1 },
      { id: 'a', name: '', slot: 0 },
      { id: 'c', name: 'Gate', slot: 2 },
    ]).map((p) => `${p.slot}:${p.name}`),
    ['-1:Home', '0:Preset 1', '1:Gate', '2:Gate (3)'],
  );
  assert.deepEqual(relativeMove('MOVE_LEFT'), { panPos: -1000, tiltPos: 0 });
  assert.deepEqual(relativeMove('MOVE_UP'), { panPos: 0, tiltPos: 1000 });
  assert.equal(relativeMove('STOP'), null);
  assert.equal(nextZoom(0, 1, { steps: { min: 0, max: 2010 } }), 201);
  assert.equal(nextZoom(2000, 1, { steps: { min: 0, max: 2010 } }), 2010);
  assert.equal(nextZoom(50, -1), 0);
  assert.equal(nextOpticalZoom(95, 1), 100);
  assert.equal(nextOpticalZoom(5, -1), 0);
});

test('plain-language sign-in errors', () => {
  assert.match(protectLoginMessage(401), /local UniFi account/);
  assert.match(protectLoginMessage(499, '{"code":"MFA_AUTH_REQUIRED"}'), /HTTP 499/);
  assert.match(protectLoginMessage(401, '{"code":"MFA_AUTH_REQUIRED"}'), /two-step/);
  assert.match(protectLoginMessage(429), /Too many/);
  assert.match(protectLoginMessage(404), /UniFi OS console/);
});

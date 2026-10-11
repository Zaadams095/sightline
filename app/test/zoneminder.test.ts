import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  authQuery,
  eventsPath,
  frameAt,
  notesObjects,
  parseEvents,
  parseLogin,
  parseMonitors,
  ptzCaps,
  ptzCommand,
  zmsPath,
} from '../src/systems/zoneminder-parse.ts';

test('login: token, legacy and auth-off', () => {
  const t = parseLogin(
    { access_token: 'eyJ.a.b', access_token_expires: 7200, refresh_token: 'r', version: '1.36.33', apiversion: '2.0' } as never,
    'pw',
    1000,
  );
  assert.deepEqual(t, { kind: 'token', token: 'eyJ.a.b', expiresAt: 8200 });
  assert.equal(authQuery(t), 'token=eyJ.a.b');
  assert.equal(authQuery(parseLogin({ credentials: 'auth=abc123', append_password: 0 }, 'pw', 0)), 'auth=abc123');
  assert.equal(authQuery(parseLogin({ credentials: 'user=zm&pass=', append_password: '1' }, 'p w', 0)), 'user=zm&pass=p%20w');
  assert.deepEqual(parseLogin({ version: '1.36.33' }, '', 0), { kind: 'none' });
});

test('zms path relative to the saved address', () => {
  assert.equal(zmsPath('/zm/cgi-bin/nph-zms', '/', '/zm'), '/zm/cgi-bin/nph-zms');
  assert.equal(zmsPath('/zm/cgi-bin/nph-zms', '/zm', '/api'.replace(/\/api$/, '')), '/cgi-bin/nph-zms');
  assert.equal(zmsPath(undefined, '/', ''), '/cgi-bin/nph-zms');
});

test('monitors (1.36 Function and 1.37 Capturing)', () => {
  const mons = parseMonitors([
    { Monitor: { Id: '2', Name: 'Driveway', Type: 'Ffmpeg', Function: 'Modect', Enabled: '1', Width: '1920', Height: '1080', Controllable: '1', ControlId: '3', Sequence: '2' }, Monitor_Status: { Status: 'Connected' } },
    { Monitor: { Id: '1', Name: 'Porch', Type: 'Ffmpeg', Function: 'None', Capturing: 'Always', Enabled: '1', Width: '1280', Height: '720', Controllable: '0', Sequence: '1' }, Monitor_Status: { Status: 'NotRunning' } },
    { Monitor: { Id: '3', Name: 'Old', Type: 'Ffmpeg', Capturing: 'None', Enabled: '1', Sequence: '3' } },
    { Monitor: { Id: '4', Name: 'Link', Type: 'WebSite' } },
    { Monitor: { Id: '5', Name: 'Gone', Type: 'Ffmpeg', Deleted: true } },
  ]);
  assert.deepEqual(mons.map((m) => m.id), ['1', '2', '3']);
  assert.equal(mons[0].enabled, true); // 1.37: Capturing wins over the legacy Function
  assert.equal(mons[0].offline, true);
  assert.equal(mons[1].ptz, true);
  assert.equal(mons[2].enabled, false);
});

test('events path, notes and times', () => {
  assert.equal(
    eventsPath('/zm/api', { monitorId: '2', after: '2024-05-01 00:00:00', before: '2024-05-01 23:59:59' }),
    '/zm/api/events/index/MonitorId:2/EndTime%20%3E%3D:2024-05-01%2000:00:00/StartTime%20%3C%3D:2024-05-01%2023:59:59.json',
  );
  assert.deepEqual(notesObjects('[a] detected:person:97% car:61%  Motion: Driveway'), ['person', 'car']);
  assert.deepEqual(notesObjects('Motion: All'), []);
  const evs = parseEvents(
    [
      { Event: { Id: '101', MonitorId: '2', Cause: 'Motion', Notes: 'detected:person:90% Motion: All', StartDateTime: '2024-07-01 12:00:00', EndDateTime: '2024-07-01 12:00:30', Length: '30.00', Frames: '300', DefaultVideo: '101-video.mp4' } },
      { Event: { Id: '102', MonitorId: '2', Cause: 'Motion', Notes: 'Motion: All', StartTime: '2024-07-01 12:05:00', EndTime: null, Length: '0', Frames: '0', DefaultVideo: '' } },
    ],
    (s) => Date.parse(`${s.replace(' ', 'T')}Z`) / 1000,
  );
  assert.equal(evs[0].start, Date.UTC(2024, 6, 1, 12) / 1000);
  assert.equal(evs[0].video, true);
  assert.deepEqual(evs[0].objects, ['person']);
  assert.equal(evs[1].end, null);
  assert.equal(frameAt(evs[0], 15), 150);
  assert.equal(frameAt(evs[1], 15), 1);
});

test('ptz commands follow control capabilities', () => {
  const con = ptzCaps({ CanMoveCon: '1', CanZoom: '1', CanZoomCon: '1', HasPresets: '1', NumPresets: '2', HasHomePreset: '1' });
  assert.deepEqual(con.presets, ['Home', 'Preset 1', 'Preset 2']);
  assert.equal(ptzCommand(con, 'MOVE_LEFT'), 'moveConLeft');
  assert.equal(ptzCommand(con, 'ZOOM_IN'), 'zoomConTele');
  assert.equal(ptzCommand(con, 'STOP'), 'moveStop');
  assert.equal(ptzCommand(con, 'preset_Home'), 'presetHome');
  assert.equal(ptzCommand(con, 'preset_Preset 2'), 'presetGoto2');
  const rel = ptzCaps({ CanMoveRel: '1' });
  assert.equal(ptzCommand(rel, 'MOVE_UP'), 'moveRelUp');
  assert.equal(rel.canZoom, false);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { coaxControlPath, coaxStatusPath, parseCoaxStatus, talkPath } from '../src/systems/dahua-format.ts';
import { isapiTalkUrl } from '../src/systems/hikvision-parse.ts';
import { hubSystemCapabilities } from '../src/systems/hub-links.ts';
import { deterSupport, sirenBody, whiteLedBody } from '../src/systems/reolink-parse.ts';
import {
  deterButtons,
  mayOfferTalk,
  pressIn,
  pressOut,
  sirenConfirmText,
  talkErrorText,
  talkHostPort,
  talkLabel,
  TALK_TAP_MS,
} from '../src/talk/talk-core.ts';
import type { SystemCapabilities } from '../src/systems/types.ts';

const caps = (over: Partial<SystemCapabilities> = {}): SystemCapabilities => ({
  live: true,
  snapshots: true,
  review: false,
  events: false,
  ptz: false,
  twoWayAudio: false,
  deter: false,
  ...over,
});

// ---- request shapes ----

test('Reolink spotlight and siren requests', () => {
  assert.deepEqual(whiteLedBody(0, true), [{ cmd: 'SetWhiteLed', action: 0, param: { WhiteLed: { channel: 0, state: 1 } } }]);
  assert.deepEqual(whiteLedBody(3, false), [{ cmd: 'SetWhiteLed', action: 0, param: { WhiteLed: { channel: 3, state: 0 } } }]);
  // Once: the siren stops by itself.
  assert.deepEqual(sirenBody(2), [{ cmd: 'AudioAlarmPlay', action: 0, param: { alarm_mode: 'times', times: 1, channel: 2 } }]);
});

test('Reolink deterrence comes from the device abilities', () => {
  const ability = {
    Ability: {
      abilityChn: [
        { floodLight: { ver: 1 }, supportAudioAlarm: { ver: 1 } },
        { supportFLswitch: { ver: 1 } },
        { alarmAudio: { ver: 1 } },
        { ptzType: { ver: 2 } },
      ],
    },
  };
  assert.deepEqual(deterSupport(ability, 0), { light: true, siren: true });
  assert.deepEqual(deterSupport(ability, 1), { light: true, siren: false });
  assert.deepEqual(deterSupport(ability, 2), { light: false, siren: true });
  assert.deepEqual(deterSupport(ability, 3), { light: false, siren: false });
  assert.deepEqual(deterSupport(null, 0), { light: false, siren: false });
});

test('Dahua talk stream and deterrence requests', () => {
  assert.equal(talkPath(2), '/cam/realmonitor?channel=2&subtype=1&unicast=true&proto=Onvif');
  assert.equal(coaxStatusPath(1), 'coaxialControlIO.cgi?action=getStatus&channel=1');
  assert.equal(coaxControlPath(1, 'light-on'), 'coaxialControlIO.cgi?action=control&channel=1&info[0].Type=1&info[0].IO=1');
  assert.equal(coaxControlPath(1, 'light-off'), 'coaxialControlIO.cgi?action=control&channel=1&info[0].Type=1&info[0].IO=2');
  assert.equal(coaxControlPath(3, 'siren'), 'coaxialControlIO.cgi?action=control&channel=3&info[0].Type=2&info[0].IO=1');

  assert.deepEqual(parseCoaxStatus('status.status.Speaker=Off\r\nstatus.status.WhiteLight=On\r\n'), { light: true, siren: true, sirenSec: 10 });
  assert.deepEqual(parseCoaxStatus('status.status.WhiteLight=Off\r\n'), { light: true, siren: false });
  // Cameras without deterrence: nothing.
  assert.deepEqual(parseCoaxStatus('Error\r\nBad Request!\r\n'), { light: false, siren: false });
  assert.deepEqual(parseCoaxStatus(''), { light: false, siren: false });
});

test('Hikvision talks over ISAPI only as a lone camera on http', () => {
  const cam = [{ proxied: false }];
  assert.equal(isapiTalkUrl({ lanUrl: 'http://192.168.1.64', user: 'admin', password: 'p@ss:1', channels: cam }), 'http://admin:p%40ss%3A1@192.168.1.64');
  assert.equal(isapiTalkUrl({ lanUrl: '192.168.1.64:8080', user: 'admin', password: 'x', channels: cam }), 'http://admin:x@192.168.1.64:8080');
  assert.equal(isapiTalkUrl({ lanUrl: 'https://192.168.1.64', user: 'admin', password: 'x', channels: cam }), null);
  assert.equal(isapiTalkUrl({ lanUrl: 'http://nvr', user: 'admin', password: 'x', channels: [{ proxied: true }] }), null);
  assert.equal(isapiTalkUrl({ lanUrl: 'http://nvr', user: 'admin', password: 'x', channels: [{ proxied: false }, { proxied: false }] }), null);
});

// ---- capability gating ----

test('Talk is offered only when the system, the adapter and this build can', () => {
  assert.equal(mayOfferTalk(caps({ twoWayAudio: true }), true, true), true);
  assert.equal(mayOfferTalk(caps({ twoWayAudio: false }), true, true), false);
  assert.equal(mayOfferTalk(caps({ twoWayAudio: true }), false, true), false);
  // An older app binary running newer JS has no native talk endpoint: hidden, not broken.
  assert.equal(mayOfferTalk(caps({ twoWayAudio: true }), true, false), false);
  // A Hub guest without talk (the Hub reports talk: false) never sees it.
  const guest = hubSystemCapabilities({ live: true, snapshots: true, events: false, recordings: false, clips: false, ptz: false, push: false, sharing: false, talk: false });
  assert.equal(mayOfferTalk(guest, true, true), false);
});

test('Deterrence buttons show only what the camera has', () => {
  assert.deepEqual(deterButtons(caps({ deter: true }), { light: true, siren: false }), { light: true, siren: false });
  assert.deepEqual(deterButtons(caps({ deter: true }), { light: false, siren: true }), { light: false, siren: true });
  assert.deepEqual(deterButtons(caps({ deter: true }), undefined), { light: false, siren: false });
  // The system can't (or the guest may not): nothing, whatever the camera says.
  assert.deepEqual(deterButtons(caps({ deter: false }), { light: true, siren: true }), { light: false, siren: false });
  assert.match(sirenConfirmText({ light: false, siren: true, sirenSec: 10 }), /about 10 seconds/);
  assert.doesNotMatch(sirenConfirmText({ light: false, siren: true }), /undefined/);
});

test('Talk endpoints: which host the phone must reach', () => {
  assert.equal(talkHostPort({ kind: 'rtsp', url: 'rtsp://u:p@10.0.0.5/cam/realmonitor?channel=1' }), '10.0.0.5:554');
  assert.equal(talkHostPort({ kind: 'rtsp', url: 'rtsp://10.0.0.5:8554/front' }), '10.0.0.5:8554');
  assert.equal(talkHostPort({ kind: 'rtsp', url: 'rtsps://10.0.0.5/x' }), '10.0.0.5:322');
  assert.equal(talkHostPort({ kind: 'isapi', url: 'http://admin:x@10.0.0.9' }), '10.0.0.9:80');
  assert.equal(talkHostPort({ kind: 'ws', url: 'wss://hub.ts.net/v1/cameras/a/talk?token=t' }), null);
});

// ---- push-to-talk ----

test('Hold to talk, or tap to keep talking', () => {
  // Hold: down starts, up stops.
  let s = pressIn('idle');
  assert.deepEqual(s, { mode: 'holding', action: 'start' });
  assert.deepEqual(pressOut(s.mode, TALK_TAP_MS + 500), { mode: 'idle', action: 'stop' });
  // Tap: keeps talking; the next tap stops it, and lifting that finger does nothing more.
  s = pressIn('idle');
  const latched = pressOut(s.mode, 120);
  assert.deepEqual(latched, { mode: 'latched', action: 'none' });
  const second = pressIn(latched.mode);
  assert.deepEqual(second, { mode: 'idle', action: 'stop' });
  assert.deepEqual(pressOut(second.mode, 80), { mode: 'idle', action: 'none' });
});

test('Talk wording is plain', () => {
  assert.deepEqual(talkLabel('idle', 'idle'), { title: 'Talk', hint: 'Hold to talk, or tap' });
  assert.equal(talkLabel('talking', 'holding').title, 'Talking…');
  assert.equal(talkLabel('talking', 'holding').hint, 'Let go to stop');
  assert.equal(talkLabel('talking', 'latched').hint, 'Tap to stop');
  assert.match(talkErrorText('mic-denied'), /Settings/);
  assert.equal(talkErrorText('This camera doesn\'t have a speaker Sightline can use.'), 'This camera doesn\'t have a speaker Sightline can use.');
});

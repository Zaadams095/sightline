import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildStreamUrl,
  COME_BACK_STEP,
  GUIDES,
  guideById,
  isStreamLink,
  matchesScan,
  parseAddress,
  redactStreamUrl,
  searchGuides,
  stepsFor,
  type StreamTarget,
} from '../src/systems/guides.ts';

function stream(guide: string, option?: string): StreamTarget {
  const g = guideById(guide)!;
  const o = option ? g.options.find((x) => x.id === option)! : g.options[0]!;
  assert.equal(o.target.type, 'stream', `${guide} should build a stream link`);
  return o.target as StreamTarget;
}

test('Tapo: address plus camera account becomes the stream1 link on 554', () => {
  assert.equal(
    buildStreamUrl(stream('tapo', 'plugin'), { address: '192.168.1.50', username: 'grandma', password: 'secret123' }),
    'rtsp://grandma:secret123@192.168.1.50:554/stream1',
  );
});

test('Wyze v3 and eufy use their own paths', () => {
  assert.equal(buildStreamUrl(stream('wyze', 'v3'), { address: '10.0.0.8', username: 'cam', password: 'pw' }), 'rtsp://cam:pw@10.0.0.8:554/stream0');
  assert.equal(buildStreamUrl(stream('eufy', 'rtsp'), { address: '10.0.0.9', username: 'u', password: 'p' }), 'rtsp://u:p@10.0.0.9:554/live0');
});

test('Imou and EZVIZ use admin with the sticker code', () => {
  const imou = stream('imou');
  assert.equal(imou.username, 'admin');
  assert.equal(
    buildStreamUrl(imou, { address: '192.168.0.20', username: imou.username, password: 'AbC123' }),
    'rtsp://admin:AbC123@192.168.0.20:554/cam/realmonitor?channel=1&subtype=0',
  );
  assert.equal(
    buildStreamUrl(stream('ezviz'), { address: '192.168.0.21', username: 'admin', password: 'QWERTY' }),
    'rtsp://admin:QWERTY@192.168.0.21:554/h264/ch1/main/av_stream',
  );
});

test('special characters in the account are encoded so the link stays valid', () => {
  assert.equal(
    buildStreamUrl(stream('tapo'), { address: '192.168.1.50', username: 'me@home', password: 'p@ss:w/rd#1 ' }),
    'rtsp://me%40home:p%40ss%3Aw%2Frd%231%20@192.168.1.50:554/stream1',
  );
});

test('a typed port wins over the default; stray schemes and slashes are ignored', () => {
  const t = stream('tapo');
  assert.equal(buildStreamUrl(t, { address: '192.168.1.50:8554', username: 'a', password: 'b' }), 'rtsp://a:b@192.168.1.50:8554/stream1');
  assert.equal(buildStreamUrl(t, { address: ' http://192.168.1.50/ ', username: 'a', password: 'b' }), 'rtsp://a:b@192.168.1.50:554/stream1');
  assert.equal(buildStreamUrl(t, { address: 'porch-cam.local', username: '', password: '' }), 'rtsp://porch-cam.local:554/stream1');
});

test('IPv6 addresses are bracketed', () => {
  assert.equal(buildStreamUrl(stream('tapo'), { address: 'fe80::1', username: 'a', password: 'b' }), 'rtsp://a:b@[fe80::1]:554/stream1');
  assert.equal(buildStreamUrl(stream('tapo'), { address: '[fe80::1]:8554', username: 'a', password: 'b' }), 'rtsp://a:b@[fe80::1]:8554/stream1');
});

test('a link pasted from the brand app is kept, gaining the account only if it has none', () => {
  const w = stream('wyze', 'v3');
  assert.ok(isStreamLink(' rtsp://x/live'));
  assert.equal(buildStreamUrl(w, { address: 'rtsp://cam:pw@10.0.0.8/live', username: 'other', password: 'x' }), 'rtsp://cam:pw@10.0.0.8/live');
  assert.equal(buildStreamUrl(w, { address: 'rtsp://10.0.0.8:554/live', username: 'cam', password: 'pw' }), 'rtsp://cam:pw@10.0.0.8:554/live');
  assert.equal(buildStreamUrl(w, { address: 'rtsps://10.0.0.8:322/stream0', username: '', password: '' }), 'rtsps://10.0.0.8:322/stream0');
});

test('bad addresses are refused with a plain message', () => {
  assert.throws(() => buildStreamUrl(stream('tapo'), { address: '', username: 'a', password: 'b' }), /camera address/);
  assert.throws(() => buildStreamUrl(stream('tapo'), { address: 'my camera', username: 'a', password: 'b' }), /camera address/);
  assert.equal(parseAddress('192.168.1.5:99999'), null);
  assert.deepEqual(parseAddress('admin@192.168.1.5:80/onvif'), { host: '192.168.1.5', port: 80 });
});

test('redactStreamUrl hides only the password', () => {
  assert.equal(redactStreamUrl('rtsp://cam:pw@10.0.0.8:554/live'), 'rtsp://cam:•••@10.0.0.8:554/live');
  assert.equal(redactStreamUrl('rtsp://10.0.0.8/live'), 'rtsp://10.0.0.8/live');
});

test('scan matching: Tapo needs both 554 and its ONVIF port; others any', () => {
  const tapo = stream('tapo').scan;
  assert.equal(matchesScan(new Set([554]), tapo), false);
  assert.equal(matchesScan(new Set([80, 554, 2020]), tapo), true);
  assert.equal(matchesScan(new Set([554]), stream('wyze', 'v3').scan), true);
});

test('search finds brands by name, app name and model', () => {
  assert.equal(searchGuides('tap')[0]!.id, 'tapo');
  assert.equal(searchGuides('Google Home')[0]!.id, 'nest');
  assert.equal(searchGuides('unifi')[0]!.id, 'ubiquiti');
  assert.ok(searchGuides('c200').some((g) => g.id === 'tapo'));
  assert.ok(searchGuides('EUFY')[0]!.id === 'eufy');
  assert.equal(searchGuides('zzzz').length, 0);
  assert.equal(searchGuides('  ').length, GUIDES.length);
});

test('every guide is well formed and never a dead end', () => {
  const ids = new Set<string>();
  for (const g of GUIDES) {
    assert.ok(!ids.has(g.id), `duplicate guide ${g.id}`);
    ids.add(g.id);
    assert.ok(g.options.length > 0, g.id);
    for (const o of g.options) {
      const t = o.target;
      if (t.type === 'unsupported') {
        assert.ok(t.why.length > 20, `${g.id}/${o.id} needs a kind explanation`);
        assert.ok(t.alternatives.length > 0, `${g.id}/${o.id} must offer a way on`);
        for (const a of t.alternatives) if (a.action === 'guide') assert.ok(guideById(a.guide), `${g.id} points at missing ${a.guide}`);
        assert.deepEqual(stepsFor(o), []);
      } else {
        assert.ok(o.steps.length > 0 && o.steps.length <= 4, `${g.id}/${o.id} should have 1–4 short steps`);
        assert.equal(stepsFor(o).at(-1), COME_BACK_STEP);
      }
      if (t.type === 'stream') {
        assert.ok(t.template.startsWith('rtsp://{auth}{host}:{port}/'), `${g.id} template shape`);
        assert.doesNotThrow(() => buildStreamUrl(t, { address: '192.168.1.2', username: 'u', password: 'p' }));
      }
    }
  }
});

test('the cloud-only brands are honest about it', () => {
  for (const id of ['ring', 'nest', 'arlo', 'blink', 'simplisafe', 'kasa']) {
    const g = guideById(id)!;
    assert.ok(g.options.every((o) => o.target.type === 'unsupported'), id);
  }
});

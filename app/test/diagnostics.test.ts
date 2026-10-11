import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DIAG_FOLD_MS,
  endpointName,
  errorCategory,
  formatReport,
  mailtoUrl,
  parseEvents,
  pushEvent,
  scrubDetail,
  scrubText,
  summarizeMetricKit,
  type DiagEvent,
} from '../src/diagnostics/core.ts';

test('scrubbing removes addresses, credentials, tokens, emails and names', () => {
  const cases: [string, string, string][] = [
    // [input, must not contain, must contain]
    ['GET http://admin:hunter2@192.168.1.20/ISAPI/System failed', 'hunter2', 'http://<redacted>'],
    ['open rtsp://user:pass@10.0.0.5:554/Streaming/Channels/101', 'user:pass', 'rtsp://<redacted>'],
    ['https://nvr.example.com:8443/api?token=abc123', 'example.com', 'https://<redacted>'],
    ['admin:secret@cam.local refused', 'secret', '<credentials>@<host>'],
    ['dial tcp 192.168.1.64:443: connect: connection refused', '192.168', '<ip>'],
    ['dial tcp [fe80::1%en0]:80: no route', 'fe80', '<ip>'],
    ['host 2001:db8:85a3::8a2e:370:7334 is down', '2001:db8', '<ip>'],
    ['peer aa:bb:cc:dd:ee:ff and 00-1A-2B-3C-4D-5E', 'aa:bb', '<'],
    ['write to grandma@example.com', 'grandma', '<email>'],
    ['no such host frigate.duckdns.org', 'duckdns', '<host>'],
    ['tailnet box.tail1234.ts.net', 'tail1234', '<host>'],
    ['login failed: password=hunter2&user=admin', 'hunter2', 'password=<redacted>'],
    ['{"token": "s3cr3t"}', 's3cr3t', '<redacted>'],
    ['Authorization: Bearer abcdef123', 'abcdef123', '<redacted>'],
    ['cookie eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl expired', 'eyJhbGci', '<token>'],
    ['PrivateKey = aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY2zA4bC6dE8f=', 'aB3dE5', '<redacted>'],
    ['key aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY2z rejected', 'aB3dE5', '<token>'],
    ['Front Door Cam is offline', 'Front Door', '<name>'],
  ];
  for (const [input, bad, good] of cases) {
    const out = scrubText(input, ['front door cam', 'Front Door', 'ab', undefined]);
    assert.ok(!out.includes(bad), `${input} → ${out} still has ${bad}`);
    assert.ok(out.includes(good), `${input} → ${out} lacks ${good}`);
  }
  // Plain language, clock times, versions and crash-report binary UUIDs survive.
  for (const keep of [
    'Reolink didn’t answer at 12:30:45',
    'Sightline 0.2.0 (HTTP 500)',
    'Couldn’t connect to the recorder.',
    '"binaryUUID":"70B89F27-1634-3580-A695-57CDB41D7743"',
  ]) {
    assert.equal(scrubText(keep), keep);
  }
});

test('scrubDetail caps length and collapses whitespace', () => {
  const d = scrubDetail(`a\n\n b ${'x'.repeat(500)}`, [], 50);
  assert.equal(d.length, 50);
  assert.ok(d.startsWith('a b '));
  assert.ok(d.endsWith('…'));
});

test('errors become stable categories', () => {
  assert.equal(errorCategory(new Error('dial tcp 1.2.3.4:80: connect: connection refused')), 'refused');
  assert.equal(errorCategory('context deadline exceeded'), 'timeout');
  assert.equal(errorCategory('Reolink didn’t accept the username or password. Check them and try again.'), 'auth');
  assert.equal(errorCategory('x509: certificate signed by unknown authority'), 'tls');
  assert.equal(errorCategory('dial tcp: lookup nvr.lan: no such host'), 'name-not-found');
  assert.equal(errorCategory('No VPN configuration. Add one in Settings → VPN.'), 'no-vpn');
  assert.equal(errorCategory('Hikvision had a problem (error 503). Try again in a moment.'), 'http-5xx');
  assert.equal(errorCategory('Frigate sent an unexpected reply.'), 'bad-reply');
  assert.equal(errorCategory('This phone can’t play this codec'), 'codec');
  assert.equal(errorCategory('weird'), 'other');
});

test('endpoint names keep the API shape, never names, IDs or query secrets', () => {
  assert.equal(endpointName('/api/front_door/latest.jpg?h=300'), '/api/*/latest.jpg');
  assert.equal(endpointName('http://127.0.0.1:5123/api/events/1699999999.123-abc/clip.mp4'), '/api/events/*/clip.mp4');
  assert.equal(endpointName('/cgi-bin/api.cgi?cmd=Snap&channel=0&token=SECRET'), '/cgi-bin/api.cgi?cmd=Snap');
  assert.equal(endpointName('/ISAPI/Streaming/channels/101/picture'), '/ISAPI/Streaming/channels/*');
  assert.equal(endpointName('/cgi-bin/magicBox.cgi?action=getSystemInfo'), '/cgi-bin/magicBox.cgi?action=getSystemInfo');
  assert.equal(endpointName('/v1/cameras/Garage%20Door/snapshot.jpg?token=abc'), '/v1/cameras/*/snapshot.jpg');
  assert.equal(endpointName('/zm/index.php?view=image&user=admin&pass=x'), '/zm/index.php');
  assert.ok(!endpointName('/my-house-name/thing').includes('house'));
});

const ev = (over: Partial<DiagEvent> = {}): Omit<DiagEvent, 'count'> => ({ t: 1000, area: 'connect', brand: 'reolink', feature: 'lan', category: 'timeout', ...over });

test('ring buffer folds repeats and drops the oldest past its limit', () => {
  let list: DiagEvent[] = [];
  list = pushEvent(list, ev());
  list = pushEvent(list, ev({ t: 2000 }));
  assert.equal(list.length, 1);
  assert.equal(list[0].count, 2);
  assert.equal(list[0].t, 2000);
  // A repeat long after is a new entry; a different category is a new entry.
  list = pushEvent(list, ev({ t: 2000 + DIAG_FOLD_MS + 1 }));
  list = pushEvent(list, ev({ t: 2000 + DIAG_FOLD_MS + 2, category: 'auth' }));
  assert.equal(list.length, 3);

  const before = list;
  for (let i = 0; i < 20; i++) list = pushEvent(list, ev({ t: 10_000_000 + i, detail: `e${i}` }), 5);
  assert.equal(list.length, 5);
  assert.equal(list[0].detail, 'e15');
  assert.equal(list[4].detail, 'e19');
  assert.equal(before.length, 3, 'input not mutated');

  // Long fields are capped.
  const long = pushEvent([], ev({ detail: 'x'.repeat(5000), feature: 'y'.repeat(500) }));
  assert.ok(long[0].detail!.length <= 400 && long[0].feature!.length <= 80);
});

test('stored events round-trip and junk is ignored', () => {
  const list = [pushEvent([], ev())[0], pushEvent([], ev({ t: 99_000_000, area: 'js', category: 'fatal', detail: 'boom' }))[0]];
  assert.deepEqual(parseEvents(JSON.stringify(list)), list);
  assert.deepEqual(parseEvents('not json'), []);
  assert.deepEqual(parseEvents('{"a":1}'), []);
  assert.equal(parseEvents(JSON.stringify([{ t: 'x' }, null, list[0]])).length, 1);
});

const crashPayload = JSON.stringify({
  timeStampBegin: '2026-10-10 00:00:00',
  timeStampEnd: '2026-10-10 23:59:00',
  crashDiagnostics: [
    {
      callStackTree: { callStacks: [] },
      diagnosticMetaData: { appVersion: '0.2.0', appBuildVersion: '14', osVersion: 'iPhone OS 18.1 (22B83)', exceptionType: 1, signal: 11 },
    },
  ],
  hangDiagnostics: [{ diagnosticMetaData: { hangDuration: '2.5 sec' } }],
});

test('MetricKit payloads summarize to one line per diagnostic', () => {
  const lines = summarizeMetricKit(crashPayload);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /crash EXC_BAD_ACCESS \(SIGSEGV\).*app 0\.2\.0 \(14\)/);
  assert.match(lines[1], /hang 2\.5 sec/);
  assert.deepEqual(summarizeMetricKit('{'), ['(unreadable crash report)']);
});

test('report shows what will be sent, scrubbed, and respects the diagnostics toggle', () => {
  const base = {
    generatedAt: Date.UTC(2026, 9, 11, 10, 0),
    app: { version: '0.2.0', build: '14' },
    device: { model: 'iPhone16,1', os: 'iOS 18.1' },
    note: 'Front Door stopped working, my wifi is 192.168.1.1, email me at me@example.com',
    names: ['Front Door', 'Home NVR'],
  };
  const full = formatReport({
    ...base,
    includeDiagnostics: true,
    brands: ['reolink', 'reolink', 'frigate'],
    events: [
      { t: Date.UTC(2026, 9, 11, 9, 0), area: 'connect', brand: 'reolink', feature: 'lan', category: 'timeout', count: 3 },
      { t: Date.UTC(2026, 9, 11, 9, 5), area: 'js', category: 'error', detail: 'Home NVR failed at http://10.0.0.2/x', count: 1 },
    ],
    metricKit: [crashPayload],
    hubs: [
      { version: '0.3.0', uptime: 7200, systems: [{ brand: 'hikvision', connected: false }], errors: [{ time: 1_790_000_000, brand: 'hikvision', area: 'snapshot', category: 'refused', detail: 'at 10.0.0.9', count: 2 }] },
      'Hub returned HTTP 403',
    ],
    error: { message: 'Cannot read property x of undefined', stack: 'at render (Front Door.js:1)\nat foo' },
  });
  for (const leak of ['192.168', 'me@example.com', 'Front Door', 'Home NVR', '10.0.0']) {
    assert.ok(!full.text.includes(leak) && !full.file.includes(leak), `leaked ${leak}`);
  }
  assert.match(full.text, /App: Sightline 0\.2\.0 \(build 14\)/);
  assert.match(full.text, /brands only\): reolink ×2, frigate/);
  // Newest first, with repeat counts.
  assert.ok(full.text.indexOf('js  error') < full.text.indexOf('connect  reolink  lan  timeout ×3'));
  assert.match(full.text, /crash EXC_BAD_ACCESS/);
  assert.match(full.text, /hikvision: not connected/);
  assert.match(full.text, /hikvision  snapshot  refused ×2/);
  assert.match(full.text, /couldn’t get its diagnostics/);
  assert.match(full.text, /Error on screen:\nCannot read property x of undefined/);
  assert.ok(full.file.includes('--- iOS diagnostic report 1 ---'));
  assert.ok(!full.text.includes('callStackTree'), 'raw crash JSON only in the file');

  const minimal = formatReport({ ...base, includeDiagnostics: false, events: [ev() as DiagEvent], metricKit: [crashPayload] });
  assert.match(minimal.text, /Diagnostics not included/);
  assert.ok(!minimal.text.includes('reolink') && !minimal.text.includes('EXC_BAD_ACCESS'));
  assert.equal(minimal.file, minimal.text);
});

test('mailto links are encoded and shortened', () => {
  const url = mailtoUrl('help@example.com', 'Sightline report', `line 1\n${'z'.repeat(100)} & more`, 20);
  assert.ok(url.startsWith('mailto:help@example.com?subject=Sightline%20report&body='));
  assert.ok(!url.includes('\n') && !url.includes(' &'));
  assert.match(decodeURIComponent(url.split('body=')[1]), /Shortened/);
});

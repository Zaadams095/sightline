import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isPrivateHostPort, parseTvLink, tvPairBody } from '../src/tv/link.ts';

const KEY = '0123456789abcdef0123456789abcdef';

test('parseTvLink reads the QR code on the TV', () => {
  assert.deepEqual(parseTvLink(`sightline://tv?h=192.168.1.40:49152&k=${KEY}&n=Living%20Room`), {
    host: '192.168.1.40:49152',
    key: KEY,
    name: 'Living Room',
  });
  assert.equal(parseTvLink({ h: '10.0.0.5:8080', k: KEY })?.name, 'Apple TV');
});

test('parseTvLink refuses anything but a private address and a real key', () => {
  assert.equal(parseTvLink(`sightline://tv?h=8.8.8.8:80&k=${KEY}`), null);
  assert.equal(parseTvLink(`sightline://tv?h=evil.example.com:80&k=${KEY}`), null);
  assert.equal(parseTvLink('sightline://tv?h=192.168.1.40:49152&k=short'), null);
  assert.equal(parseTvLink(`sightline://hub?h=192.168.1.40:1&k=${KEY}`), null);
});

test('isPrivateHostPort', () => {
  assert.ok(isPrivateHostPort('172.16.0.1:1'));
  assert.ok(!isPrivateHostPort('172.32.0.1:1'));
  assert.ok(!isPrivateHostPort('192.168.1.300:1'));
  assert.ok(!isPrivateHostPort('192.168.1.3:70000'));
});

test('tvPairBody', () => {
  const body = JSON.parse(tvPairBody({ host: 'x', key: KEY, name: 'TV' }, { name: 'Home', lanUrl: 'http://h', remoteUrl: '' }, 'ABCDE-FGHJK'));
  assert.deepEqual(body, { key: KEY, code: 'ABCDE-FGHJK', hub: { name: 'Home', lanUrl: 'http://h', remoteUrl: '' } });
});

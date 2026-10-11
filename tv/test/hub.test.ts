import assert from 'node:assert/strict';
import { test } from 'node:test';

import { liveUrl, parsePairBody, snapshotUrl } from '../src/hub.ts';

test('parsePairBody accepts what the iPhone app sends', () => {
  const body = JSON.stringify({ key: 'k1', code: 'ABCDE-FGHJK', hub: { name: 'Home', lanUrl: 'http://192.168.1.20:8086/', remoteUrl: 'https://home.ts.net/' } });
  assert.deepEqual(parsePairBody(body), {
    key: 'k1',
    code: 'ABCDE-FGHJK',
    hub: { name: 'Home', lanUrl: 'http://192.168.1.20:8086', remoteUrl: 'https://home.ts.net' },
  });
});

test('parsePairBody rejects junk and non-HTTPS public links', () => {
  assert.equal(parsePairBody('nope'), null);
  assert.equal(parsePairBody(JSON.stringify({ key: 'k', code: 'c' })), null);
  assert.equal(parsePairBody(JSON.stringify({ key: 'k', code: 'c', hub: { lanUrl: 'ftp://x' } })), null);
  assert.equal(parsePairBody(JSON.stringify({ key: 'k', code: 'c', hub: { lanUrl: 'http://x', remoteUrl: 'http://public' } })), null);
});

test('media URLs carry the token and escape camera ids', () => {
  assert.equal(liveUrl('https://h', 't/k', 'front door'), 'https://h/v1/cameras/front%20door/live.m3u8?token=t%2Fk');
  assert.equal(snapshotUrl('https://h', 't', 'a', 360, 5), 'https://h/v1/cameras/a/snapshot.jpg?height=360&token=t&t=5');
});

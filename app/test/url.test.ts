import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizeUrl, resolveScheme } from '../src/util/url.ts';

test('normalizeUrl adds a scheme without assuming a brand', () => {
  assert.equal(normalizeUrl('192.168.1.5'), 'http://192.168.1.5');
  assert.equal(normalizeUrl('nvr.lan:8080/'), 'http://nvr.lan:8080');
  assert.equal(normalizeUrl('10.0.0.2:443'), 'https://10.0.0.2:443');
  assert.equal(normalizeUrl('https://x:8971'), 'https://x:8971');
});

test('resolveScheme downgrades only when the server answers HTTPS with plain HTTP', async () => {
  const plain = async () => 'Get "https://10.0.0.130:8971/": http: server gave HTTP response to HTTPS client';
  assert.equal(await resolveScheme('https://10.0.0.130:8971', plain), 'http://10.0.0.130:8971');
  assert.equal(await resolveScheme('https://x:443', async () => 'HTTP 401'), 'https://x:443');
  assert.equal(await resolveScheme('https://x:443', async () => 'dial tcp: i/o timeout'), 'https://x:443');
  assert.equal(await resolveScheme('http://x:80', async () => { throw new Error('not called'); }), 'http://x:80');
});

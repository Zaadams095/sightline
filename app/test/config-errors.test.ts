import assert from 'node:assert/strict';
import { test } from 'node:test';

import { configVersion, sameConfig } from '../src/util/config.ts';
import { userMessage } from '../src/util/errors.ts';

const sys = (over: Record<string, unknown> = {}) =>
  ({ id: 'a', kind: 'frigate', name: 'Home', endpoint: { lanUrl: 'http://10.0.0.2:5000', useTunnel: true }, ...over }) as never;

test('configs compare by value, ignoring key order', () => {
  const a = sys();
  const b = { endpoint: { useTunnel: true, lanUrl: 'http://10.0.0.2:5000' }, name: 'Home', kind: 'frigate', id: 'a' } as never;
  assert.equal(sameConfig(a, b), true);
  assert.equal(configVersion(a), configVersion(b));
  assert.equal(sameConfig(a, sys({ name: 'Cabin' })), false);
  assert.notEqual(configVersion(a), configVersion(sys({ endpoint: { lanUrl: 'http://10.0.0.3:5000', useTunnel: true } })));
});

test('raw network errors become plain sentences; adapter messages pass through', () => {
  assert.match(userMessage(new Error('dial tcp 192.168.1.9:80: connect: connection refused'), 'Frigate'), /didn’t accept the connection/);
  assert.match(userMessage(new Error('Get "http://x": context deadline exceeded (Client.Timeout exceeded)'), 'NVR'), /Couldn’t find NVR/);
  assert.equal(userMessage(new Error('Bridge returned HTTP 500: oops'), 'Bridge'), 'Couldn’t connect to Bridge.');
  const friendly = 'Reolink didn’t accept the username or password. Check them and try again.';
  assert.equal(userMessage(new Error(friendly), 'Reolink'), friendly);
});

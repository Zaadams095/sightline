import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loginError, parseLinks } from '../src/systems/scrypted-parse.ts';

test('pasted rebroadcast links: localhost replaced, names optional', () => {
  const { links, bad } = parseLinks(
    'Front door=rtsp://localhost:34567/a1b2c3d4e5f6a7b8 rtsp://127.0.0.1:34568/0011223344556677\nGarage = rtsp://192.168.1.9:40000/ffeeddccbbaa9988',
    '192.168.1.40',
  );
  assert.deepEqual(bad, []);
  assert.deepEqual(links, [
    { id: 'a1b2c3d4e5f6a7b8', name: 'Front door', url: 'rtsp://192.168.1.40:34567/a1b2c3d4e5f6a7b8' },
    { id: '0011223344556677', name: 'Camera 2', url: 'rtsp://192.168.1.40:34568/0011223344556677' },
    { id: 'ffeeddccbbaa9988', name: 'Garage', url: 'rtsp://192.168.1.9:40000/ffeeddccbbaa9988' },
  ]);
});

test('junk is reported, duplicates get distinct ids', () => {
  const { links, bad } = parseLinks('http://example.com rtsp://localhost:1/abc, rtsp://localhost:2/abc', 'nvr.local');
  assert.deepEqual(bad, ['http://example.com']);
  assert.equal(links.length, 2);
  assert.notEqual(links[0].id, links[1].id);
  assert.equal(links[1].url, 'rtsp://nvr.local:2/abc');
});

test('login errors arrive as 200 with {error}', () => {
  assert.match(loginError({ error: 'Incorrect password.' })!, /username or password/);
  assert.equal(loginError({ authorization: 'Bearer x' }), null);
});

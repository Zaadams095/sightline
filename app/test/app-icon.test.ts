import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// The App Store rejects icons with transparency, and a mangled export once shipped as noise.
test('app icon is a 1024×1024 opaque PNG', () => {
  const png = readFileSync(new URL('../assets/images/icon.png', import.meta.url));
  assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG');
  assert.equal(png.subarray(12, 16).toString('ascii'), 'IHDR');
  assert.equal(png.readUInt32BE(16), 1024);
  assert.equal(png.readUInt32BE(20), 1024);
  assert.equal(png[24], 8, 'bit depth');
  assert.equal(png[25], 2, 'color type must be RGB (no alpha channel)');
});

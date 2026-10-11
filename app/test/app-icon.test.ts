import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

function header(name: string) {
  const png = readFileSync(new URL(`../assets/images/${name}`, import.meta.url));
  assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG', name);
  assert.equal(png.subarray(12, 16).toString('ascii'), 'IHDR', name);
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20), depth: png[24], colorType: png[25] };
}

// The App Store rejects icons with transparency, and a mangled export once shipped as noise.
test('app icon is a 1024×1024 opaque PNG', () => {
  const h = header('icon.png');
  assert.equal(h.width, 1024);
  assert.equal(h.height, 1024);
  assert.equal(h.depth, 8, 'bit depth');
  assert.equal(h.colorType, 2, 'color type must be RGB (no alpha channel)');
});

// iOS 18 home screen appearances: dark keeps transparency (iOS draws its own dark backdrop),
// tinted is a grayscale image iOS colors in.
test('dark and tinted icon variants are 1024×1024 PNGs', () => {
  const dark = header('icon-dark.png');
  assert.deepEqual([dark.width, dark.height, dark.depth], [1024, 1024, 8]);
  assert.equal(dark.colorType, 6, 'dark icon is RGBA');
  const tinted = header('icon-tinted.png');
  assert.deepEqual([tinted.width, tinted.height, tinted.depth], [1024, 1024, 8]);
  assert.ok(tinted.colorType === 0 || tinted.colorType === 2, 'tinted icon is opaque');
});

test('app.json wires the icon variants for iOS', () => {
  const app = JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8'));
  assert.deepEqual(app.expo.ios.icon, {
    light: './assets/images/icon.png',
    dark: './assets/images/icon-dark.png',
    tinted: './assets/images/icon-tinted.png',
  });
});

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const app = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(join(app, rel), 'utf8');

function png(rel: string) {
  const b = readFileSync(join(app, rel));
  assert.equal(b.subarray(1, 4).toString('ascii'), 'PNG', rel);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), colorType: b[25] };
}

test('Android adaptive icon layers are 1024×1024, with transparency where Android needs it', () => {
  const cfg = JSON.parse(read('app.json')).expo.android.adaptiveIcon;
  assert.equal(cfg.backgroundColor, '#080A14');
  for (const [key, alpha] of [['foregroundImage', true], ['monochromeImage', true], ['backgroundImage', false]] as const) {
    const h = png(cfg[key]);
    assert.deepEqual([h.width, h.height], [1024, 1024], key);
    if (alpha) assert.equal(h.colorType, 6, `${key} must be RGBA`);
  }
  const icon = png('assets/images/notification-icon.png');
  assert.deepEqual([icon.width, icon.height, icon.colorType], [96, 96, 6]);
});

// The Hub names the channel a push goes to; a name the phone never created means Android
// falls back to its default channel (or, for a titled push, drops it).
test('notification channel IDs match between the app and the Hub', () => {
  const app = /type AlertChannel = ([^;]+);/.exec(read('src/alerts/channels.ts'))![1].match(/'([a-z]+)'/g)!.map((s) => s.slice(1, -1));
  const hub = [...read('../bridge/push.go').matchAll(/channel\w+\s*=\s*"([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...hub].sort(), [...app].sort());
});

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? sources(p) : /\.tsx?$/.test(f) ? [p] : [];
  });
}

// expo-symbols draws nothing on Android for an SF name without a Material twin.
test('every SF Symbol the app names has a Material Symbol for Android', () => {
  const map = read('src/components/ui/symbol.tsx');
  const mapped = new Set([...map.matchAll(/^\s+'?([a-z0-9.]+)'?: '[a-z0-9_]+',$/gm)].map((m) => m[1]));
  const missing = new Set<string>();
  for (const file of sources(join(app, 'src'))) {
    const src = readFileSync(file, 'utf8');
    if (!src.includes('@/components/ui/symbol')) continue;
    for (const m of src.matchAll(/\b(?:name|icon)=(?:\{)?["']([a-z0-9]+(?:\.[a-z0-9]+)*)["']/g)) {
      if (!mapped.has(m[1])) missing.add(`${m[1]} (${file.slice(app.length)})`);
    }
  }
  assert.deepEqual([...missing], []);
});

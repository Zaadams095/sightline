import assert from 'node:assert/strict';
import { pbkdf2Sync, webcrypto } from 'node:crypto';
import { test } from 'node:test';

import {
  AAD_FILE,
  AAD_MOVE,
  encodeMoveCode,
  fromBase64,
  makeBackupFile,
  makeBundle,
  openBackupFile,
  openBundle,
  parseBundle,
  parseMoveCode,
  sealBundle,
  toBase64,
  utf8Decode,
  utf8Encode,
  type Aead,
  type DeriveKey,
} from '../src/backup/bundle.ts';
import { migrateMasks } from '../src/alerts/zones.ts';
import {
  applySections,
  chunkText,
  countCameras,
  decodeSection,
  encodeSection,
  extractSections,
  fitToBudget,
  hashSection,
  mergeSections,
  newer,
  planUpload,
  secretRefs,
  SECTIONS,
  restoreUrlCredentials,
  stableStringify,
  streamSecretName,
  stripUrlCredentials,
  staleParts,
  summaryText,
  type BackupSource,
  type SectionName,
} from '../src/backup/sections.ts';

// --- fixtures -------------------------------------------------------------

function state(over: Partial<BackupSource> = {}): BackupSource {
  return {
    systems: [
      { id: 'nvr', kind: 'reolink', name: 'Garage NVR', endpoint: { lanUrl: 'http://192.168.1.10', useTunnel: true }, username: 'admin' },
      {
        id: 'hub1',
        kind: 'hub',
        name: 'Home Hub',
        endpoint: { lanUrl: 'http://192.168.1.20:8086', useTunnel: false },
        extra: { push: '1', role: 'owner', hubName: 'Home' },
      },
      {
        id: 'cam',
        kind: 'rtsp',
        name: 'Shed',
        endpoint: { lanUrl: '', useTunnel: true },
        manualCameras: [
          { id: 'shed', name: 'Shed', rtspUrl: 'rtsp://192.168.1.30/main' },
          {
            id: 'gate',
            name: 'Gate',
            rtspUrl: 'rtsp://admin:S3cr%40t-gate@192.168.1.31:554/Streaming/Channels/101',
            snapshotUrl: 'http://admin:snapPa55@192.168.1.31/ISAPI/Streaming/channels/101/picture',
          },
          { id: 'yard', name: 'Yard', rtspUrl: 'rtsp://192.168.1.32:554/h264Preview_01_main?user=admin&password=Qu3ryPw' },
          { id: 'odd', name: 'Odd', rtspUrl: 'rtsps://viewer:p@ss/w@rd@cam.local:322/live@ch1' },
        ],
      },
    ],
    appearance: { mode: 'dark', accent: 'violet', radius: 14, density: 'comfortable', labelStyle: 'overlay', phoneColumns: 2, showTimestamps: true },
    phoneOrder: ['nvr:0', 'nvr:1', 'hub1:front'],
    hidden: ['nvr:2'],
    gridViews: [{ id: 'g', name: 'Wall', tiles: [{ cameraKey: 'hub1:back', x: 0, y: 0, w: 6, h: 6 }] }],
    cameraGroups: [{ id: 'grp', name: 'Front', cameraKeys: ['nvr:0', 'hub1:front'] }],
    alerts: {
      mode: 'built-in',
      rules: { 'nvr:0': { enabled: true, objects: ['person'], zones: [], severities: ['alert'] } },
      defaultRule: { enabled: true, objects: ['person'], zones: [], severities: ['alert'] },
      quietHours: { enabled: true, start: '23:00', end: '06:30' },
      cooldownSec: 60,
      quietFor: ['Zach'],
      snoozed: { 'nvr:0': 1_900_000_000 },
      health: { enabled: true, storagePct: 90 },
      presence: { enabled: true, atHome: true, alertWhenHome: ['hub1:door'], home: { latitude: 1, longitude: 2, radius: 150 } },
      bridge: { url: 'http://192.168.1.20:8086', pairedAt: 1 },
      doorbell: { fullScreen: true },
      lockScreen: true,
      packages: { enabled: true, reminder: false, reminderTime: '19:00' },
    },
    cameraMap: { background: 'file:///var/mobile/plan.jpg', aspect: 1.5, placements: { 'nvr:3': { x: 0.5, y: 0.5, heading: 0, fov: 90 } }, links: [] },
    alertZones: { 'nvr:1': [{ id: 'z1', name: 'Driveway', mode: 'include', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], objects: ['person'] }] },
    savedClips: [
      {
        id: 'c1',
        systemId: 'nvr',
        cameraId: '0',
        cameraName: 'Drive',
        title: 'Delivery',
        start: 1,
        end: 2,
        savedAt: 10,
        retainedEvents: [],
        localUri: 'file:///var/mobile/Documents/library/c1.mp4',
      },
    ],
    ...over,
  };
}

const allText = (v: unknown) => JSON.stringify(v);

// --- serialization --------------------------------------------------------

test('backup includes settings but no video files or per-device state', () => {
  const s = extractSections(state());
  assert.deepEqual(Object.keys(s).sort(), [...SECTIONS].sort());
  const text = allText(s);

  // Video files / local media never travel.
  assert.ok(!text.includes('.mp4'));
  assert.ok(!text.includes('localUri'));
  assert.ok(!text.includes('plan.jpg'));
  // Per-device: Hub push registration mark, snoozes, "at home" right now.
  assert.ok(!text.includes('"push"'));
  assert.ok(!text.includes('snoozed'));
  assert.ok(!text.includes('atHome'));
  // Passwords never appear in the settings part.
  assert.ok(!text.toLowerCase().includes('password'));

  // What should be there is there.
  const systems = s.systems as BackupSource['systems'];
  assert.equal(systems.length, 3);
  assert.deepEqual(systems[1].extra, { role: 'owner', hubName: 'Home' });
  assert.equal((s.clips as { title: string }[])[0].title, 'Delivery');
  assert.deepEqual((s.alerts as BackupSource['alerts']).presence.home, { latitude: 1, longitude: 2, radius: 150 });
  assert.deepEqual((s.layout as { cameraGroups: unknown }).cameraGroups, state().cameraGroups);
  assert.equal((s.zones as Record<string, { name: string }[]>)['nvr:1'][0].name, 'Driveway');
});

test('backup does not mutate the live state', () => {
  const st = state();
  const before = JSON.stringify(st);
  extractSections(st);
  assert.equal(JSON.stringify(st), before);
});

test('restoring keeps this phone’s per-device values', () => {
  const backup = extractSections(state());
  const fresh = state({
    systems: [],
    savedClips: [{ ...state().savedClips[0], localUri: 'file:///new/c1.mp4' }],
    cameraMap: { aspect: 1, placements: {}, links: [], background: 'file:///new/map.png' },
  });
  fresh.alerts = { ...fresh.alerts, snoozed: { x: 5 }, presence: { ...fresh.alerts.presence, atHome: false } };
  const patch = applySections(backup, fresh, migrateMasks);
  assert.equal(patch.systems?.length, 3);
  assert.deepEqual(patch.alerts?.snoozed, { x: 5 });
  assert.equal(patch.alerts?.presence.atHome, false);
  assert.equal(patch.alerts?.presence.enabled, true);
  assert.equal(patch.cameraMap?.background, 'file:///new/map.png');
  assert.equal(patch.cameraMap?.aspect, 1.5);
  assert.equal(patch.savedClips?.[0].localUri, 'file:///new/c1.mp4');
  assert.equal(patch.appearance?.phoneColumns, 2);
  assert.equal(patch.activeGridViewId, undefined); // selection state stays per phone
  assert.equal(patch.alertZones?.['nvr:1'][0].mode, 'include');
});

test('restoring skips malformed sections', () => {
  const patch = applySections({ systems: 'nope', alerts: [1], zones: null, layout: { phoneOrder: 'x' } } as never, state(), migrateMasks);
  assert.deepEqual(patch, {});
  const p2 = applySections({ systems: [{ id: 'a', kind: 'onvif', name: 'A', endpoint: { lanUrl: '', useTunnel: false } }, { bad: true }] }, state(), migrateMasks);
  assert.equal(p2.systems?.length, 1);
});

test('secrets: every system password/token, VPN key and bridge secret — never the app-lock PIN', () => {
  const refs = secretRefs(state().systems);
  const names = refs.map((r) => `${r.scope}.${r.name}`);
  assert.ok(names.includes('nvr.password'));
  assert.ok(names.includes('hub1.token'));
  assert.ok(names.includes('tunnel.wg.conf'));
  assert.ok(names.includes('bridge.secret'));
  assert.ok(!names.some((n) => n.startsWith('applock')));
  assert.ok(!secretRefs([{ id: 'applock' }]).some((r) => r.scope === 'applock'));
});

test('summary counts systems and the cameras it knows about', () => {
  const s = extractSections(state());
  // nvr:0, nvr:1, nvr:2, nvr:3, hub1:front, hub1:back, hub1:door, cam:shed/gate/yard/odd
  assert.equal(countCameras(s), 11);
  assert.equal(summaryText(s), '3 systems, 11 cameras');
  assert.equal(summaryText({ systems: [{ id: 'x' }] }), '1 system');
});

// --- change detection & conflicts ----------------------------------------

test('hash ignores key order and undefined fields', () => {
  assert.equal(stableStringify({ b: 1, a: [1, { d: 2, c: undefined }] }), '{"a":[1,{"d":2}],"b":1}');
  assert.equal(hashSection({ a: 1, b: 2 }), hashSection({ b: 2, a: 1 }));
  assert.notEqual(hashSection({ a: 1 }), hashSection({ a: 2 }));
});

const hashes = (st: BackupSource) => {
  const s = extractSections(st);
  return Object.fromEntries(SECTIONS.map((k) => [k, hashSection(s[k])])) as Record<SectionName, string>;
};

test('first upload writes everything when iCloud is empty', () => {
  const plan = planUpload(hashes(state()), {}, {}, 1000, 'A');
  assert.deepEqual(Object.keys(plan.write).sort(), [...SECTIONS].sort());
  assert.equal(plan.write.systems?.updatedAt, 1000);
  assert.equal(plan.meta.alerts?.updatedAt, 1000);
});

test('a phone with no history never overwrites an existing backup just by starting', () => {
  const remoteHashes = hashes(state());
  const remote = Object.fromEntries(SECTIONS.map((k) => [k, { updatedAt: 500, device: 'OLD', hash: remoteHashes[k] }]));
  const fresh = hashes(state({ systems: [], appearance: { ...state().appearance, mode: 'light' } }));
  const plan = planUpload(fresh, {}, remote, 1000, 'NEW');
  assert.deepEqual(plan.write, {});
  // Once the user really changes a section, that section (only) is written.
  const edited = { ...fresh, appearance: 'changed' };
  const next = planUpload(edited, plan.meta, remote, 2000, 'NEW');
  assert.deepEqual(Object.keys(next.write), ['appearance']);
});

test('only changed sections are uploaded', () => {
  const h = hashes(state());
  const first = planUpload(h, {}, {}, 1000, 'A');
  const remote = { ...first.write };
  const h2 = hashes(state({ hidden: [] }));
  const plan = planUpload(h2, first.meta, remote, 2000, 'A');
  assert.deepEqual(Object.keys(plan.write), ['layout']);
  assert.equal(plan.write.layout?.updatedAt, 2000);
});

test('two phones: last writer wins per section', () => {
  const h = hashes(state());
  const a = planUpload(h, {}, {}, 1000, 'A');
  let cloud: Record<string, { updatedAt: number; device: string; hash: string }> = { ...a.write } as never;

  // Phone B restored from the backup, then changed alerts at t=3000.
  const bMeta = Object.fromEntries(SECTIONS.map((k) => [k, { hash: h[k], updatedAt: 1000 }]));
  const bPlan = planUpload({ ...h, alerts: 'B-alerts' }, bMeta, cloud, 3000, 'B');
  assert.deepEqual(Object.keys(bPlan.write), ['alerts']);
  cloud = { ...cloud, ...bPlan.write } as never;

  // Phone A edited layout at t=2000 and alerts at t=2000 but syncs later: layout goes up, alerts
  // doesn't (B's edit is newer).
  const aPlan = planUpload({ ...h, layout: 'A-layout', alerts: 'A-alerts' }, a.meta, cloud, 2000, 'A');
  assert.deepEqual(Object.keys(aPlan.write), ['layout']);
  // A keeps trying its alerts edit later only if it's still the newest; it isn't, so the cloud
  // keeps B's alerts and A's layout.
  cloud = { ...cloud, ...aPlan.write } as never;
  assert.equal(cloud.alerts.device, 'B');
  assert.equal(cloud.layout.device, 'A');
});

test('mergeSections / newer: newest wins, ties are deterministic', () => {
  const x = { updatedAt: 5, device: 'A', hash: 'x' };
  const y = { updatedAt: 7, device: 'B', hash: 'y' };
  const z = { updatedAt: 7, device: 'C', hash: 'z' };
  assert.equal(newer(x, y), y);
  assert.equal(newer(y, x), y);
  assert.equal(newer(y, z), z);
  assert.equal(newer(z, y), z);
  assert.equal(newer(null, x), x);
  const m = mergeSections({ systems: x, alerts: y }, { systems: y, zones: x });
  assert.deepEqual(m, { systems: y, alerts: y, zones: x });
});

// --- iCloud key-value encoding -------------------------------------------

test('sections round-trip through chunked key-value storage', () => {
  const data = { big: 'é😀x'.repeat(40_000), n: 1 };
  const stamp = { updatedAt: 9, device: 'A', hash: hashSection(data) };
  const pairs = encodeSection('clips', stamp, data, 10_000);
  assert.ok(pairs.length > 2);
  assert.equal(pairs[pairs.length - 1][0], 'sl1.clips'); // header written last
  const kv = new Map(pairs);
  const back = decodeSection('clips', (k) => kv.get(k));
  assert.deepEqual(back?.data, data);
  assert.deepEqual(back?.stamp, stamp);

  // A part that hasn't synced yet → treated as missing, not as corrupt data.
  kv.delete('sl1.clips.1');
  assert.equal(decodeSection('clips', (k) => kv.get(k)), null);

  // Small sections stay inline; stale parts from a bigger copy get cleaned up.
  const small = encodeSection('clips', { ...stamp, hash: hashSection({ n: 2 }) }, { n: 2 });
  assert.equal(small.length, 1);
  assert.ok(staleParts('clips', pairs.length - 1, small).includes('sl1.clips.0'));
});

test('chunking never splits an emoji', () => {
  const text = 'a😀'.repeat(1000);
  for (const c of chunkText(text, 7)) {
    const last = c.charCodeAt(c.length - 1);
    assert.ok(!(last >= 0xd800 && last <= 0xdbff));
  }
  assert.equal(chunkText(text, 7).join(''), text);
});

test('oversized backups drop the oldest saved clips first', () => {
  const clips = Array.from({ length: 4000 }, (_, i) => ({ ...state().savedClips[0], id: `c${i}`, savedAt: i, title: 'x'.repeat(200) }));
  const s = extractSections(state({ savedClips: clips }));
  const fit = fitToBudget(s, 300_000);
  assert.ok(fit.fits);
  assert.ok(fit.trimmedClips > 0);
  const kept = fit.sections.clips as { savedAt: number }[];
  assert.ok(kept.every((c) => c.savedAt >= 4000 - kept.length));
  assert.equal(fitToBudget(extractSections(state())).trimmedClips, 0);
});

// --- encryption -----------------------------------------------------------

const subtle = webcrypto.subtle;
const aead: Aead = {
  async seal(key, plaintext, aad) {
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const k = await subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, k, plaintext));
    const out = new Uint8Array(12 + ct.length);
    out.set(iv);
    out.set(ct, 12);
    return out;
  },
  async open(key, sealed, aad) {
    const k = await subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt']);
    return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: sealed.slice(0, 12), additionalData: aad }, k, sealed.slice(12)));
  },
};
const derive: DeriveKey = async (pass, salt, it) => new Uint8Array(pbkdf2Sync(pass, salt, it, 32, 'sha256'));

const bundle = () =>
  makeBundle(
    extractSections(state()),
    [
      { scope: 'nvr', name: 'password', value: 'hunter2 ünïcødé 😀' },
      { scope: 'tunnel', name: 'wg.conf', value: '[Interface]\nPrivateKey = abc=' },
      { scope: 'hub1', name: 'token', value: '' },
    ],
    'Zach’s iPhone',
    1234,
  );

test('utf8 and base64 helpers round-trip', () => {
  const s = 'héllo 😀 “quotes” \u0000 end';
  assert.equal(utf8Decode(utf8Encode(s)), s);
  assert.deepEqual(utf8Encode(s), new Uint8Array(Buffer.from(s, 'utf8')));
  const bytes = webcrypto.getRandomValues(new Uint8Array(257));
  assert.equal(toBase64(bytes), Buffer.from(bytes).toString('base64'));
  assert.deepEqual(fromBase64(toBase64(bytes)), bytes);
  assert.deepEqual(fromBase64(Buffer.from(bytes).toString('base64url')), bytes);
});

test('transfer bundle: encryption round trip, includes secrets, wrong key fails', async () => {
  const key = webcrypto.getRandomValues(new Uint8Array(32));
  const sealed = await sealBundle(aead, key, bundle(), AAD_MOVE);
  assert.ok(!sealed.includes('hunter2'));
  const back = await openBundle(aead, key, sealed, AAD_MOVE);
  assert.equal(back.from, 'Zach’s iPhone');
  assert.deepEqual(back.sections, bundle().sections);
  // Empty secrets are dropped; real ones arrive intact.
  assert.deepEqual(
    back.secrets.map((s) => `${s.scope}.${s.name}=${s.value}`),
    ['nvr.password=hunter2 ünïcødé 😀', 'tunnel.wg.conf=[Interface]\nPrivateKey = abc='],
  );

  const other = webcrypto.getRandomValues(new Uint8Array(32));
  await assert.rejects(openBundle(aead, other, sealed, AAD_MOVE), /didn’t work/);
  // A transfer bundle can't be opened as a backup file (different associated data).
  await assert.rejects(openBundle(aead, key, sealed, AAD_FILE));
  // Tampering is detected.
  const raw = fromBase64(sealed);
  raw[20] ^= 1;
  await assert.rejects(openBundle(aead, key, toBase64(raw), AAD_MOVE));
});

test('expo-crypto compatible layout: iv || ciphertext || tag', async () => {
  const key = webcrypto.getRandomValues(new Uint8Array(32));
  const sealed = fromBase64(await sealBundle(aead, key, bundle(), AAD_MOVE));
  const plainLen = utf8Encode(JSON.stringify(bundle())).length;
  assert.equal(sealed.length, 12 + plainLen + 16);
});

test('backup file: passcode round trip and wrong passcode', async () => {
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const file = await makeBackupFile(aead, derive, 'correct horse', bundle(), salt, 1000);
  assert.ok(!file.includes('hunter2'));
  assert.equal(JSON.parse(file).kdf.iterations, 1000);
  const back = await openBackupFile(aead, derive, 'correct horse', file);
  assert.equal(back.secrets.length, 2);
  await assert.rejects(openBackupFile(aead, derive, 'wrong horse', file), /passcode doesn’t match/);
  await assert.rejects(openBackupFile(aead, derive, 'x', '{"hello":1}'), /isn’t a Sightline backup/);
  await assert.rejects(makeBackupFile(aead, derive, 'short', bundle(), salt, 1000), /at least 8/);
});

test('PBKDF2 matches the Go side (tunnel/wgtunnel/transfer_test.go)', async () => {
  const key = await derive('password', new TextEncoder().encode('saltsalt'), 1000);
  assert.equal(Buffer.from(key).toString('hex'), '135f7a66144fcf0fb003ce048f31f024ed5cbff30525d3ba0bfb3199479362a6');
});

test('bundle parsing rejects other data and newer versions', () => {
  assert.throws(() => parseBundle('nope'), /isn’t a Sightline backup/);
  assert.throws(() => parseBundle('{"format":"other"}'), /isn’t a Sightline backup/);
  assert.throws(() => parseBundle(JSON.stringify({ ...bundle(), v: 2 })), /newer version/);
});

test('QR transfer code round trip and validation', () => {
  const key = webcrypto.getRandomValues(new Uint8Array(32));
  const code = { hosts: ['192.168.1.23', '10.0.0.4'], port: 51234, token: 'a'.repeat(32), key };
  const text = encodeMoveCode(code);
  assert.ok(text.length < 200);
  assert.deepEqual(parseMoveCode(text), code);
  assert.equal(parseMoveCode('sightline://hub?url=x'), null);
  assert.equal(parseMoveCode(text.replace('p=51234', 'p=0')), null);
  assert.equal(parseMoveCode(text.replace(/k=[^&]+/, 'k=abc')), null);
  assert.equal(parseMoveCode(text.replace('192.168.1.23,10.0.0.4', 'evil.com')), null);
});

test('old backups with "ignored areas" (masks) restore as activity zones', () => {
  const legacy = { masks: { 'nvr:1': [[{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }]] } };
  const patch = applySections(legacy, state({ alertZones: {} }), migrateMasks);
  const z = patch.alertZones?.['nvr:1'];
  assert.equal(z?.length, 1);
  assert.equal(z?.[0].mode, 'exclude');
  // A zone in the same backup wins over the old mask for that camera.
  const both = applySections({ ...legacy, zones: state().alertZones }, state({ alertZones: {} }), migrateMasks);
  assert.equal(both.alertZones?.['nvr:1'][0].mode, 'include');
});

test('demo systems are never backed up', () => {
  const demo = { id: 'demo', kind: 'demo' as never, name: 'Demo', endpoint: { lanUrl: '', useTunnel: false } };
  const s = extractSections(state({ systems: [...state().systems, demo] }));
  assert.equal((s.systems as { id: string }[]).some((x) => x.id === 'demo'), false);
});

// --- passwords inside camera links -----------------------------------------

const LINK_PASSWORDS = ['S3cr%40t-gate', 'S3cr@t-gate', 'snapPa55', 'Qu3ryPw', 'p@ss/w@rd'];

test('no password from a camera link ever appears in the settings backup', () => {
  const st = state();
  const sections = extractSections(st);
  const serialized = [
    JSON.stringify(sections),
    // Exactly what goes into iCloud key-value storage.
    ...SECTIONS.flatMap((s) => encodeSection(s, { updatedAt: 1, device: 'A', hash: hashSection(sections[s]) }, sections[s], 500).map(([, v]) => v)),
  ].join('\n');
  for (const pw of LINK_PASSWORDS) assert.ok(!serialized.includes(pw), `leaked ${pw}`);
  assert.ok(!serialized.includes('admin:'));
  assert.ok(!serialized.includes('viewer:'));

  const cams = (sections.systems as BackupSource['systems'])[2].manualCameras!;
  assert.equal(cams[1].rtspUrl, 'rtsp://192.168.1.31:554/Streaming/Channels/101');
  assert.equal(cams[1].snapshotUrl, 'http://192.168.1.31/ISAPI/Streaming/channels/101/picture');
  assert.equal(cams[2].rtspUrl, 'rtsp://192.168.1.32:554/h264Preview_01_main?user=admin');
  assert.equal(cams[3].rtspUrl, 'rtsps://cam.local:322/live@ch1');
  // The live state still has them (snapshot links stay usable on this phone).
  assert.ok(st.systems[2].manualCameras![1].snapshotUrl!.includes('snapPa55'));
});

test('camera-link passwords travel as secrets instead', () => {
  const names = secretRefs(state().systems).map((r) => `${r.scope}.${r.name}`);
  assert.ok(names.includes(`cam.${streamSecretName('gate', 'rtsp')}`));
  assert.ok(names.includes(`cam.${streamSecretName('gate', 'snap')}`));
});

test('stripping and restoring link credentials', () => {
  const cases: [string, string, boolean][] = [
    ['rtsp://admin:pw@192.168.1.5:554/s0', 'rtsp://192.168.1.5:554/s0', true],
    ['rtsp://192.168.1.5/live@ch1', 'rtsp://192.168.1.5/live@ch1', false],
    ['rtsp://user@cam.local/stream', 'rtsp://cam.local/stream', true],
    ['rtsp://a:b@[fe80::1]:554/x', 'rtsp://[fe80::1]:554/x', true],
    ['http://cam/snap.jpg?usr=a&pwd=b&ch=1#f', 'http://cam/snap.jpg?usr=a&ch=1#f', true],
    ['rtsp://cam.local/x?password=1', 'rtsp://cam.local/x', true],
    ['rtsp://192.168.1.9/x', 'rtsp://192.168.1.9/x', false],
    ['not a url', 'not a url', false],
  ];
  for (const [input, clean, had] of cases) assert.deepEqual(stripUrlCredentials(input), { clean, hadCredentials: had }, input);

  const full = 'rtsp://admin:pw@192.168.1.5:554/s0';
  assert.equal(restoreUrlCredentials('rtsp://192.168.1.5:554/s0', full), full);
  // The link was edited since: don't graft old credentials onto a different link.
  assert.equal(restoreUrlCredentials('rtsp://192.168.1.6:554/s0', full), 'rtsp://192.168.1.6:554/s0');
  assert.equal(restoreUrlCredentials('rtsp://x/', null), 'rtsp://x/');
});

test('restore leaves camera links clean (passwords come back from the keychain)', () => {
  const patch = applySections(extractSections(state()), state({ systems: [] }), migrateMasks);
  const text = JSON.stringify(patch);
  for (const pw of LINK_PASSWORDS) assert.ok(!text.includes(pw));
});

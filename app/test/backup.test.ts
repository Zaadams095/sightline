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
import type { CheckIn } from '../src/alerts/checkins.ts';
import type { Feedback } from '../src/alerts/learning.ts';
import { migrateMasks } from '../src/alerts/zones.ts';
import {
  applySections,
  applySmart,
  localNewerSections,
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
    smart: smartState(),
    ...over,
  };
}

function fb(id: string, at: number, verdict: Feedback['verdict'] = 'not-important', camera = 'nvr:0'): Feedback {
  return { id, at, verdict, camera, objects: ['car'], zones: [], subLabels: [], severity: 'detection', hour: 'day', light: 'day', duration: 'short' } as Feedback;
}

function checkin(id: string, over: Partial<CheckIn> = {}): CheckIn {
  return {
    id,
    enabled: true,
    who: 'Mom',
    systemId: 'hub1',
    cameras: ['kitchen'],
    zones: {},
    peopleOnly: false,
    byTime: '10:00',
    quietLimitHours: null,
    dayStart: '07:00',
    dayEnd: '22:00',
    summaryTime: null,
    phone: '+1 555 0100',
    timezone: 'America/Chicago',
    duringQuietHours: true,
    ...over,
  };
}

/** The smart-alerts store, including per-device check-in progress that must never travel. */
function smartState(): BackupSource['smart'] {
  return {
    learning: { feedback: [fb('e1', 100), fb('e2', 200), fb('e3', 300)], confirmed: ['nvr:0|person|any'] },
    conditions: false,
    checkins: [checkin('ci1'), { ...checkin('ci2', { who: 'Dad' }), phone: '' }],
    checkinStates: { ci1: { watchingSince: 1, momentsToday: 4, okAt: 77, summarySent: '2026-10-10' } },
  } as BackupSource['smart'];
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
  assert.equal(summaryText(s), '3 systems, 11 cameras, 2 check-ins');
  assert.equal(summaryText({ systems: [{ id: 'x' }] }), '1 system');
  assert.equal(summaryText({ systems: [{ id: 'x' }], smart: { checkins: [checkin('a')] } }), '1 system, 1 check-in');
  // Older backups (no smart section) read as before.
  assert.equal(summaryText({ ...s, smart: undefined }), '3 systems, 11 cameras');
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

// --- smart alerts (learned feedback, rain/wind setting, check-ins) ---------

test('smart section: feedback, setting and check-in definitions, never check-in progress', () => {
  const s = extractSections(state());
  const smart = s.smart as BackupSource['smart'];
  assert.deepEqual(Object.keys(smart).sort(), ['checkins', 'conditions', 'learning']);
  assert.equal(smart.learning.feedback.length, 3);
  assert.deepEqual(smart.learning.confirmed, ['nvr:0|person|any']);
  assert.equal(smart.conditions, false);
  assert.deepEqual(smart.checkins.map((c) => c.id), ['ci1', 'ci2']);
  // The "Call Mom" number is user-entered contact info and does travel.
  assert.equal(smart.checkins[0].phone, '+1 555 0100');
  const text = allText(s.smart);
  assert.ok(!text.includes('checkinStates'));
  assert.ok(!text.includes('momentsToday'));
  assert.ok(!text.includes('okAt'));
  // Round-trips through chunked key-value storage with a valid hash.
  const kv = new Map(encodeSection('smart', { updatedAt: 1, device: 'A', hash: hashSection(s.smart) }, s.smart, 300));
  assert.deepEqual(decodeSection('smart', (k) => kv.get(k))?.data, s.smart);
});

test('restoring smart alerts onto a new phone', () => {
  const empty = { learning: { feedback: [], confirmed: [] }, conditions: true, checkins: [] };
  const patch = applySections(extractSections(state()), state({ smart: empty }), migrateMasks);
  assert.equal(patch.smart?.learning.feedback.length, 3);
  assert.equal(patch.smart?.conditions, false);
  assert.deepEqual(patch.smart?.checkins.map((c) => c.id), ['ci1', 'ci2']);
  // Progress is not part of the patch: this phone's own (none) stays.
  assert.ok(!('checkinStates' in (patch.smart ?? {})));
  // Old backups without the section leave smart alerts alone.
  const { smart: _omit, ...old } = extractSections(state());
  assert.equal(applySections(old, state(), migrateMasks).smart, undefined);
});

test('restoring smart alerts never loses what this phone has', () => {
  const backup = extractSections(state()).smart;
  const local = {
    // Newer opinion on e2, one only given here, a confirmed rule only here.
    learning: { feedback: [fb('e2', 250, 'important'), fb('e9', 900)], confirmed: ['hub1:door|person|night'] },
    conditions: true,
    checkins: [checkin('ci1', { who: 'Mother' }), checkin('local', { who: 'Grandpa' })],
  };
  const m = applySmart(backup, local)!;
  const byId = Object.fromEntries(m.learning.feedback.map((f) => [f.id, f]));
  assert.deepEqual(Object.keys(byId).sort(), ['e1', 'e2', 'e3', 'e9']);
  assert.equal(byId.e2.verdict, 'important'); // most recent opinion wins
  assert.deepEqual(m.learning.feedback.map((f) => f.at), [100, 250, 300, 900]); // oldest first, as stored
  assert.deepEqual(m.learning.confirmed.sort(), ['hub1:door|person|night', 'nvr:0|person|any']);
  // Same check-in: the backup's version; one made only here is kept.
  assert.equal(m.checkins.find((c) => c.id === 'ci1')?.who, 'Mom');
  assert.ok(m.checkins.some((c) => c.id === 'local'));
  assert.equal(m.conditions, false);
  // Malformed pieces are skipped, not trusted.
  const bad = applySmart({ learning: { feedback: [{ id: 1 }, null], confirmed: 'x' }, checkins: [{ who: 'x' }], conditions: 'yes' }, local)!;
  assert.equal(bad.learning.feedback.length, 2);
  assert.equal(bad.checkins.length, 2);
  assert.equal(bad.conditions, true);
  assert.equal(applySmart('nope', local), null);
});

test('cloud restore keeps this phone’s smart alerts when they are newer (last writer wins)', () => {
  const stamps = { smart: { updatedAt: 1000, device: 'OLD', hash: 'cloud' } };
  // A new phone (no history) takes the backup.
  assert.deepEqual(localNewerSections({ smart: 'mine' }, {}, stamps), []);
  // Same copy: nothing to keep.
  assert.deepEqual(localNewerSections({ smart: 'cloud' }, { smart: { hash: 'cloud', updatedAt: 1000 } }, stamps), []);
  // Changed here since the last upload (not backed up yet): this phone's edit is newer.
  assert.deepEqual(localNewerSections({ smart: 'mine2' }, { smart: { hash: 'mine', updatedAt: 500 } }, stamps), ['smart']);
  // Uploaded after the backup's copy was made.
  assert.deepEqual(localNewerSections({ smart: 'mine' }, { smart: { hash: 'mine', updatedAt: 2000 } }, stamps), ['smart']);
  // Older upload, unchanged since: the backup is newer.
  assert.deepEqual(localNewerSections({ smart: 'mine' }, { smart: { hash: 'mine', updatedAt: 500 } }, stamps), []);
});

test('smart alerts change detection uploads only that section', () => {
  const h = hashes(state());
  const first = planUpload(h, {}, {}, 1000, 'A');
  assert.ok('smart' in first.write);
  const st = state();
  const h2 = hashes({ ...st, smart: { ...st.smart, conditions: true } });
  assert.deepEqual(Object.keys(planUpload(h2, first.meta, { ...first.write }, 2000, 'A').write), ['smart']);
  // Check-in progress changing on this phone never causes an upload.
  const h3 = hashes({ ...st, smart: { ...st.smart, checkinStates: { ci1: { watchingSince: 9, momentsToday: 99 } } } as BackupSource['smart'] });
  assert.deepEqual(Object.keys(planUpload(h3, first.meta, { ...first.write }, 3000, 'A').write), []);
});

test('oversized backups trim clips first, then the oldest feedback; check-ins always stay', () => {
  const st = state();
  const feedback = Array.from({ length: 300 }, (_, i) => ({ ...fb(`e${i}`, i), zones: ['z'.repeat(300)] }));
  const big = state({ smart: { ...st.smart, learning: { ...st.smart.learning, feedback } } });
  const s = extractSections(big);
  // Clips alone are enough: feedback is untouched.
  const clips = Array.from({ length: 2000 }, (_, i) => ({ ...st.savedClips[0], id: `c${i}`, savedAt: i, title: 'x'.repeat(200) }));
  const a = fitToBudget({ ...s, clips: extractSections(state({ savedClips: clips })).clips }, 400_000);
  assert.ok(a.fits && a.trimmedClips > 0);
  assert.equal(a.trimmedFeedback, 0);
  // Still too big without any clips: the oldest feedback goes.
  const b = fitToBudget(s, 60_000);
  assert.ok(b.fits);
  assert.ok(b.trimmedFeedback > 0);
  const kept = (b.sections.smart as BackupSource['smart']).learning.feedback;
  assert.equal(kept.length, 300 - b.trimmedFeedback);
  assert.ok(kept.every((f) => f.at >= 300 - kept.length));
  assert.deepEqual(kept.map((f) => f.at), [...kept.map((f) => f.at)].sort((x, y) => x - y));
  assert.equal((b.sections.smart as BackupSource['smart']).checkins.length, 2);
  assert.deepEqual((b.sections.smart as BackupSource['smart']).learning.confirmed, ['nvr:0|person|any']);
});

test('transfer bundle carries smart alerts', () => {
  const b = parseBundle(JSON.stringify(bundle()));
  assert.deepEqual((b.sections.smart as BackupSource['smart']).checkins.map((c) => c.who), ['Mom', 'Dad']);
  assert.ok(!JSON.stringify(b).includes('momentsToday'));
});

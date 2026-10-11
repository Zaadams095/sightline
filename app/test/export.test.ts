import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { crc32, Sha256, sha256Hex, shortFingerprint } from '../src/export/hash.ts';
import { buildManifest, fileStamp, manifestJson, mismatches, safeName, uniquePath, type ExportMeta } from '../src/export/manifest.ts';
import { clipPieces, exportFolderName, fileAnchors, mergeSpans } from '../src/export/plan.ts';
import { escapeHtml, renderReport } from '../src/export/report-html.ts';
import {
  clampToNow,
  customWindow,
  dayLabel,
  defaultSelection,
  describeWindow,
  durationText,
  estimateBytes,
  isoWithOffset,
  presetWindow,
  replayWarning,
  sizeWarning,
  windowProblem,
} from '../src/export/window.ts';
import { localHeader, writeZip } from '../src/export/zip.ts';

const zone = { timeZone: 'America/Chicago', offsetMin: -300 };

test('sha256 matches node crypto, in one go and in odd-sized chunks', () => {
  for (const len of [0, 1, 55, 56, 63, 64, 65, 1000, 100_003]) {
    const data = new Uint8Array(len).map((_, i) => (i * 31 + 7) & 0xff);
    const want = createHash('sha256').update(data).digest('hex');
    assert.equal(sha256Hex(data), want, `len ${len}`);
    const h = new Sha256();
    for (let i = 0; i < len; i += 17) h.update(data.subarray(i, i + 17));
    assert.equal(h.hex(), want, `chunked len ${len}`);
  }
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('crc32 runs across chunks', () => {
  const s = new TextEncoder().encode('The quick brown fox jumps over the lazy dog');
  assert.equal(crc32(s), 0x414fa339);
  assert.equal(crc32(s.subarray(10), crc32(s.subarray(0, 10))), 0x414fa339);
});

test('shortFingerprint is readable', () => {
  assert.equal(shortFingerprint('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'), 'BA78 16BF … F200 15AD');
});

test('presets: last 30 min and last night', () => {
  const now = new Date(2026, 9, 11, 9, 30, 0); // Oct 11, 9:30 AM local
  const t = Math.floor(now.getTime() / 1000);
  assert.deepEqual(presetWindow('last30', now), { start: t - 1800, end: t });
  const night = presetWindow('lastNight', now);
  assert.equal(night.start, Math.floor(new Date(2026, 9, 10, 20, 0).getTime() / 1000));
  assert.equal(night.end, Math.floor(new Date(2026, 9, 11, 7, 0).getTime() / 1000));
  // At 3 AM the night is still going: it runs until now.
  const early = new Date(2026, 9, 11, 3, 0, 0);
  const n2 = presetWindow('lastNight', early);
  assert.equal(n2.start, Math.floor(new Date(2026, 9, 10, 20, 0).getTime() / 1000));
  assert.equal(n2.end, Math.floor(early.getTime() / 1000));
  // At 10 PM "last night" is still the one that ended this morning.
  const late = presetWindow('lastNight', new Date(2026, 9, 11, 22, 0, 0));
  assert.equal(late.end, Math.floor(new Date(2026, 9, 11, 7, 0).getTime() / 1000));
});

test('custom windows are checked in plain words', () => {
  const now = 1_760_000_000;
  assert.equal(windowProblem({ start: now - 60, end: now - 120 }, now), 'The end time must be after the start time.');
  assert.match(windowProblem({ start: now + 60, end: now + 120 }, now)!, /hasn’t happened/);
  assert.match(windowProblem({ start: now - 30 * 3600, end: now }, now)!, /24 hours/);
  assert.equal(windowProblem({ start: now - 600, end: now + 600 }, now), null);
  assert.deepEqual(clampToNow({ start: now - 600, end: now + 600 }, now), { start: now - 600, end: now });
});

test('time zone shows in every time', () => {
  // 2026-10-11 01:00 UTC = Oct 10, 8:00 PM in UTC-5
  const start = Date.UTC(2026, 9, 11, 1, 0, 0) / 1000;
  assert.equal(isoWithOffset(start, -300), '2026-10-10T20:00:00-05:00');
  assert.equal(isoWithOffset(start, 330), '2026-10-11T06:30:00+05:30');
  assert.equal(
    describeWindow({ start, end: start + 11 * 3600 }, zone),
    'Oct 10, 2026, 8:00 PM – Oct 11, 2026, 7:00 AM (America/Chicago, UTC-05:00)',
  );
  assert.equal(durationText(11 * 3600), '11 hours');
  assert.equal(durationText(90 * 60), '1 hour 30 minutes');
});

test('default camera choice: cameras with recordings or events in the window', () => {
  assert.deepEqual(
    defaultSelection([
      { key: 'a', hasRecordings: true, events: 0 },
      { key: 'b', hasRecordings: false, events: 0 },
      { key: 'c', hasRecordings: null, events: 2 },
      { key: 'd', hasRecordings: null, events: 0 },
    ]),
    ['a', 'c'],
  );
  // Nobody can tell: pick everything that might have video.
  assert.deepEqual(
    defaultSelection([
      { key: 'a', hasRecordings: null, events: 0 },
      { key: 'b', hasRecordings: false, events: 0 },
    ]),
    ['a'],
  );
  assert.deepEqual(defaultSelection([{ key: 'b', hasRecordings: false, events: 0 }]), []);
});

test('size and replay warnings', () => {
  const w = { start: 0, end: 3600 };
  assert.equal(sizeWarning(estimateBytes({ start: 0, end: 600 }, 2)), null);
  assert.match(sizeWarning(estimateBytes(w, 2))!, /1\.8 GB.*shorter time/);
  assert.equal(replayWarning(w, 0), null);
  assert.match(replayWarning(w, 1)!, /about 1 hour/);
});

const meta: ExportMeta = {
  createdAt: Date.UTC(2026, 9, 11, 14, 0, 0) / 1000,
  zone,
  window: { start: Date.UTC(2026, 9, 11, 1, 0, 0) / 1000, end: Date.UTC(2026, 9, 11, 12, 0, 0) / 1000 },
  appVersion: '0.2.0',
  device: 'iPhone 17 (iOS 26.1)',
  systems: ['Frigate'],
};

test('manifest lists every file with its fingerprint, sorted, with local times', () => {
  const files = [
    { path: 'video/b.mp4', kind: 'video' as const, bytes: 3, sha256: sha256Hex('abc'), camera: 'Back', start: meta.window.start, end: meta.window.end },
    { path: 'photos/a.jpg', kind: 'photo' as const, bytes: 1, sha256: sha256Hex('x'), camera: 'Front' },
  ];
  const m = buildManifest(
    meta,
    [{ name: 'Back', system: 'Frigate', method: 'clip', video: 'included', events: 1 }],
    [{ camera: 'Back', start: meta.window.start + 60, end: null, what: 'Person', photo: 'photos/a.jpg' }],
    files,
    { publicKeyFingerprint: 'ab'.repeat(32) },
  );
  assert.equal(m.format, 'sightline-export/1');
  assert.deepEqual(m.files.map((f) => f.path), ['photos/a.jpg', 'video/b.mp4']);
  assert.equal(m.files[1].start, '2026-10-10T20:00:00-05:00');
  assert.equal(m.window.timeZone, 'America/Chicago');
  assert.equal(m.events[0].start, '2026-10-10T20:01:00-05:00');
  assert.equal(m.signature?.signatureFile, 'manifest.sig');
  assert.match(m.howToCheck, /openssl dgst -sha256 -verify public-key\.pem/);

  const json = manifestJson(m);
  assert.ok(json.endsWith('\n'));
  // Same input, same bytes (the signature covers these bytes).
  assert.equal(manifestJson(buildManifest(meta, m.cameras, [], files, { publicKeyFingerprint: 'ab'.repeat(32) })).length > 0, true);
  assert.deepEqual(JSON.parse(json).files[0], { path: 'photos/a.jpg', kind: 'photo', bytes: 1, sha256: sha256Hex('x'), camera: 'Front' });

  // Tampering shows up.
  assert.deepEqual(mismatches(m, { 'photos/a.jpg': sha256Hex('x'), 'video/b.mp4': sha256Hex('abd') }), ['video/b.mp4']);
  assert.deepEqual(mismatches(m, { 'photos/a.jpg': sha256Hex('x').toUpperCase(), 'video/b.mp4': sha256Hex('abc') }), []);

  const unsigned = buildManifest(meta, [], [], [], null);
  assert.equal(unsigned.signature, null);
  assert.doesNotMatch(unsigned.howToCheck, /openssl/);
});

test('file names are safe and unique', () => {
  assert.equal(safeName('Front/Door: "cam" #1'), 'Front_Door_ _cam_ _1');
  assert.equal(fileStamp('Front Door', meta.window.start, -300), 'Front Door 2026-10-10 200000');
  const taken = new Set<string>();
  assert.equal(uniquePath('video/a.mp4', taken), 'video/a.mp4');
  assert.equal(uniquePath('video/a.mp4', taken), 'video/a (2).mp4');
  assert.equal(uniquePath('video/a.mp4', taken), 'video/a (3).mp4');
});

test('PDF report: escapes text, shows the time zone, missing video and every fingerprint', () => {
  const html = renderReport({
    meta,
    cameras: [
      { name: 'Front <Door>', system: 'Frigate', method: 'clip', video: 'included', events: 2 },
      { name: 'Garage', system: 'Blue Iris', method: 'none', video: 'none', events: 1, note: 'Recorder only replays as MJPEG' },
    ],
    events: [
      { camera: 'Front <Door>', start: meta.window.start + 120, end: meta.window.start + 180, what: 'Person', thumb: 'data:image/jpeg;base64,AAAA' },
      { camera: 'Garage', start: meta.window.start + 60, end: null, what: 'Car' },
    ],
    files: [{ path: 'video/front.mp4', kind: 'video', bytes: 2_500_000, sha256: sha256Hex('abc') }],
    signer: { publicKeyFingerprint: sha256Hex('key') },
  });
  assert.match(html, /Front &lt;Door&gt;/);
  assert.doesNotMatch(html, /Front <Door>/);
  assert.match(html, /America\/Chicago, UTC-05:00/);
  assert.match(html, /couldn’t export video for this time.*Garage/s);
  assert.match(html, new RegExp(sha256Hex('abc')));
  assert.match(html, /if any file is changed, even by one frame, its fingerprint won’t match/);
  assert.match(html, /openssl dgst -sha256 -verify public-key\.pem -signature manifest\.sig manifest\.json/);
  assert.match(html, /Sightline 0\.2\.0 on iPhone 17/);
  assert.match(html, /<img src="data:image\/jpeg;base64,AAAA"/);
  // Events in time order: the 8:01 Car before the 8:02 Person.
  assert.ok(html.indexOf('Car') < html.indexOf('Person'));

  const empty = renderReport({ meta, cameras: [], events: [], files: [], signer: null });
  assert.match(empty, /No events were recorded/);
  assert.match(empty, /isn’t signed/);
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
});

test('PDF report caps a very long event list', () => {
  const events = Array.from({ length: 5 }, (_, i) => ({ camera: 'A', start: meta.window.start + i, end: null, what: `E${i}` }));
  const html = renderReport({ meta, cameras: [], events, files: [], signer: null, maxEvents: 3 });
  assert.match(html, /…and 2 more/);
  assert.doesNotMatch(html, /E4/);
});

test('stored zip: headers, data and central directory line up', async () => {
  const files = [new TextEncoder().encode('hello'), new TextEncoder().encode('world!!')];
  const entries = files.map((f, i) => ({ name: `Export/f${i}.txt`, size: f.length, crc: crc32(f), date: new Date(2026, 9, 11, 9, 30, 10) }));
  const chunks: Uint8Array[] = [];
  const sink = { write: (b: Uint8Array) => void chunks.push(b) };
  const total = await writeZip(entries, sink, async (i) => sink.write(files[i]));
  const zip = Buffer.concat(chunks);
  assert.equal(zip.length, total);
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  const eocd = zip.length - 22;
  assert.equal(zip.readUInt32LE(eocd), 0x06054b50);
  assert.equal(zip.readUInt16LE(eocd + 10), 2);
  const cdOffset = zip.readUInt32LE(eocd + 16);
  assert.equal(zip.readUInt32LE(cdOffset), 0x02014b50);
  // Second entry's local header sits where the central directory says.
  const secondOffset = zip.readUInt32LE(cdOffset + 46 + 'Export/f0.txt'.length + 42);
  assert.equal(secondOffset, localHeader(entries[0]).length + 5);
  assert.equal(zip.readUInt32LE(secondOffset), 0x04034b50);
  assert.equal(zip.readUInt32LE(secondOffset + 14), crc32(files[1]));
});

test('custom window: an end before the start is the next morning', () => {
  const now = new Date(2026, 9, 11, 9, 0, 0);
  const w = customWindow(1, '22:00', '06:00', now);
  assert.equal(w.start, Math.floor(new Date(2026, 9, 10, 22, 0).getTime() / 1000));
  assert.equal(w.end, Math.floor(new Date(2026, 9, 11, 6, 0).getTime() / 1000));
  const same = customWindow(0, '08:00', '08:45', now);
  assert.equal(same.end - same.start, 45 * 60);
  assert.equal(dayLabel(0, now), 'Today');
  assert.equal(dayLabel(1, now), 'Yesterday');
  assert.equal(dayLabel(3, now), 'Thu, Oct 8');
});

test('clip pieces: 30 minutes at most, only where there are recordings', () => {
  const w = { start: 0, end: 3600 };
  assert.deepEqual(clipPieces(w, null), [
    [0, 1800],
    [1800, 3600],
  ]);
  assert.deepEqual(clipPieces(w, []), []);
  // Two recordings 30 s apart are one stretch; a later one is separate; outside the window is cut.
  assert.deepEqual(
    clipPieces(w, [
      { start: -100, end: 300 },
      { start: 330, end: 600 },
      { start: 3000, end: 4000 },
    ]),
    [
      [0, 600],
      [3000, 3600],
    ],
  );
  assert.deepEqual(
    mergeSpans([
      [10, 20],
      [0, 5],
    ]),
    [[0, 20]],
  );
});

test('file anchors: window start, each recording and each event, once', () => {
  assert.deepEqual(
    fileAnchors(
      { start: 100, end: 1000 },
      [
        { start: 50, end: 200 },
        { start: 400, end: 700 },
      ],
      [400, 900, 1200],
    ),
    [100, 400, 900],
  );
  assert.equal(fileAnchors({ start: 0, end: 1e9 }, null, Array.from({ length: 500 }, (_, i) => i + 1)).length, 200);
});

test('export folder name uses local time', () => {
  assert.equal(exportFolderName(Date.UTC(2026, 9, 11, 14, 30, 0) / 1000, -300), 'Sightline export 2026-10-11 0930');
});

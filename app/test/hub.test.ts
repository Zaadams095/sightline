import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  endsText,
  grantSummary,
  hubAddresses,
  hubPlaybackSource,
  hubSystemCapabilities,
  inviteMessage,
  looksLikePairingCode,
  normalizeHubAddress,
  parseHubLink,
  parseLocalDateTime,
  presetWindow,
  sharedByText,
  withToken,
  type HubGrant,
} from '../src/systems/hub-links.ts';

test('parses the Hub setup-page pairing QR', () => {
  const l = parseHubLink('sightline://hub?code=123456&name=Home&url=http%3A%2F%2F192.168.1.20%3A8086');
  assert.deepEqual(l, { kind: 'pair', url: 'http://192.168.1.20:8086', lan: undefined, remote: undefined, code: '123456', name: 'Home' });
  assert.deepEqual(hubAddresses(l!), { lanUrl: 'http://192.168.1.20:8086', remoteUrl: undefined });
});

test('parses a guest invite with public and home addresses', () => {
  const l = parseHubLink(
    'sightline://invite?code=ABCDE-FGHJK&lan=http%3A%2F%2F192.168.1.20%3A8086&name=Zach%27s+house&url=https%3A%2F%2Fsightline-hub.tail1.ts.net',
  )!;
  assert.equal(l.kind, 'invite');
  assert.equal(l.name, "Zach's house");
  assert.deepEqual(hubAddresses(l), { lanUrl: 'http://192.168.1.20:8086', remoteUrl: 'https://sightline-hub.tail1.ts.net' });
});

test('parses the Hub invite landing-page link and path-style deep links', () => {
  const web = parseHubLink('https://sightline-hub.tail1.ts.net/invite?code=ABCDE-FGHJK')!;
  assert.equal(web.kind, 'invite');
  assert.equal(web.url, 'https://sightline-hub.tail1.ts.net');
  assert.deepEqual(hubAddresses(web), { lanUrl: 'https://sightline-hub.tail1.ts.net', remoteUrl: undefined });
  assert.equal(parseHubLink('sightline:///invite?code=X&url=http://10.0.0.2:8086')?.kind, 'invite');
});

test('rejects other QR codes', () => {
  for (const s of [
    '[Interface]\nPrivateKey = abc',
    'https://example.com/',
    'sightline://camera/front',
    'sightline://invite?url=http://1.2.3.4:8086', // no code
    'sightline://invite?code=ABC', // no address
    'sightline://invite?code=ABC&url=javascript:alert(1)',
  ]) {
    assert.equal(parseHubLink(s), null, s);
  }
});

test('normalizes typed Hub addresses and recognizes code types', () => {
  assert.equal(normalizeHubAddress('192.168.1.20'), 'http://192.168.1.20:8086');
  assert.equal(normalizeHubAddress('hub.local:9000/'), 'http://hub.local:9000');
  assert.equal(normalizeHubAddress('https://x.ts.net'), 'https://x.ts.net');
  assert.equal(looksLikePairingCode('123 456'), true);
  assert.equal(looksLikePairingCode('ABCDE-FGHJK'), false);
});

const grant = (over: Partial<HubGrant>): HubGrant => ({
  id: 'g',
  name: 'Sitter',
  role: 'temporary',
  cameras: ['front', 'back'],
  recordings: 'all',
  expiresAt: null,
  createdAt: 0,
  devices: 1,
  pendingInvite: false,
  ...over,
});

test('grant summaries read plainly', () => {
  const now = new Date(2026, 9, 10, 12, 0);
  const names: Record<string, string> = { front: 'Front Door', back: 'Backyard' };
  const from = new Date(2026, 9, 10, 0, 0).getTime() / 1000;
  const to = new Date(2026, 9, 17, 23, 59).getTime() / 1000;
  assert.equal(
    grantSummary(grant({ recordings: { from, to }, expiresAt: to }), (id) => names[id], now),
    'Front Door & Backyard · recordings Oct 10 – Oct 17 · ends Oct 17',
  );
  assert.equal(grantSummary(grant({ role: 'live', cameras: 'all', recordings: 'none', devices: 0, pendingInvite: true }), undefined, now), 'All cameras · live only · invite not used yet');
  assert.equal(grantSummary(grant({ role: 'household', cameras: ['a', 'b', 'c'] }), undefined, now), '3 cameras');
  assert.equal(endsText(new Date(2026, 9, 9, 18, 30).getTime() / 1000, now), 'ended Oct 9 6:30 PM');
  assert.equal(endsText(new Date(2027, 0, 2, 0, 0).getTime() / 1000, now), 'ends Jan 2, 2027');
  assert.equal(sharedByText('Home', null, now), 'Shared by Home');
  assert.equal(sharedByText('Home', to, now), 'Shared by Home · ends Oct 17');
});

test('date windows for sharing', () => {
  const now = new Date(2026, 9, 10, 15, 42);
  const today = presetWindow('today', now);
  assert.equal(new Date(today.from * 1000).getHours(), 0);
  assert.deepEqual([new Date(today.to * 1000).getDate(), new Date(today.to * 1000).getHours()], [10, 23]);
  const week = presetWindow('week', now);
  assert.equal(new Date(week.to * 1000).getDate(), 17);

  assert.deepEqual(parseLocalDateTime('2026-10-12'), new Date(2026, 9, 12, 0, 0));
  assert.deepEqual(parseLocalDateTime('2026-10-12', true), new Date(2026, 9, 12, 23, 59));
  assert.deepEqual(parseLocalDateTime('2026-10-12 18:30'), new Date(2026, 9, 12, 18, 30));
  assert.deepEqual(parseLocalDateTime('10/12/2026 6:30 pm'), new Date(2026, 9, 12, 18, 30));
  assert.deepEqual(parseLocalDateTime('10/12/2026 12 am'), new Date(2026, 9, 12, 0, 0));
  assert.equal(parseLocalDateTime('2026-02-30'), null);
  assert.equal(parseLocalDateTime('next tuesday'), null);
  assert.equal(parseLocalDateTime('2026-10-12 25:00'), null);
});

test('invite message carries the links, never a token', () => {
  const m = inviteMessage('Home', 'live', 'sightline://invite?code=A', 'https://h.ts.net/invite?code=A');
  assert.match(m, /watch my cameras live/);
  assert.match(m, /https:\/\/h\.ts\.net\/invite\?code=A/);
  assert.match(m, /sightline:\/\/invite\?code=A/);
  assert.doesNotMatch(m, /slh_/);
});

test('maps every kind of Hub playback answer to a player source', () => {
  const media = (rel: string) => withToken(`http://192.168.1.20:8086${rel}`, 'slh_t');
  assert.deepEqual(hubPlaybackSource({ kind: 'vod', url: '/v1/recordings/front/vod.m3u8?start=1&end=2', start: 1, end: 2 }, media), {
    kind: 'vod',
    uri: 'http://192.168.1.20:8086/v1/recordings/front/vod.m3u8?start=1&end=2&token=slh_t',
  });
  assert.deepEqual(
    hubPlaybackSource(
      { kind: 'stream', source: { kind: 'mse', url: '/v1/recordings/nvr~ch1/playback/stream?start=1&end=2' }, start: 1, end: 2, startTime: 5 },
      media,
    ),
    { kind: 'stream', source: { kind: 'mse', wsUrl: 'ws://192.168.1.20:8086/v1/recordings/nvr~ch1/playback/stream?start=1&end=2&token=slh_t' }, startTime: 5 },
  );
  assert.deepEqual(
    hubPlaybackSource({ kind: 'stream', source: { kind: 'file', url: '/v1/recordings/c/playback/file.mp4?start=1&end=2', startTime: 0.5 }, start: 1, end: 2 }, media),
    { kind: 'stream', source: { kind: 'file', uri: 'http://192.168.1.20:8086/v1/recordings/c/playback/file.mp4?start=1&end=2&token=slh_t', startTime: 0.5 } },
  );
  // A token already in the URL (the Hub echoes ?token= when the request used one) isn't doubled.
  assert.equal(withToken('https://h.ts.net/x?start=1&token=a', 'a'), 'https://h.ts.net/x?start=1&token=a');
  assert.equal(withToken('https://h.ts.net/x', 'a b'), 'https://h.ts.net/x?token=a%20b');
  assert.throws(() => hubPlaybackSource({ kind: 'stream', start: 1, end: 2 }, media), /can’t play/);
});

test('Hub capabilities come from what the Hub reports, not from Frigate', () => {
  const none = { live: true, snapshots: true, events: false, recordings: false, clips: false, ptz: false, push: true, sharing: true };
  assert.deepEqual(hubSystemCapabilities(none), { live: true, snapshots: true, review: false, events: false, ptz: false, twoWayAudio: false, deter: false });
  assert.equal(hubSystemCapabilities({ ...none, events: true, ptz: true }).review, true);
  assert.equal(hubSystemCapabilities({ ...none, snapshots: false }).snapshots, false);
  assert.deepEqual(hubSystemCapabilities(undefined), { live: true, snapshots: true, review: false, events: false, ptz: false, twoWayAudio: false, deter: false });
  // Talk and deterrence only when the Hub says so (it already left them out for guests).
  const talky = hubSystemCapabilities({ ...none, talk: true, deter: true });
  assert.equal(talky.twoWayAudio, true);
  assert.equal(talky.deter, true);
});

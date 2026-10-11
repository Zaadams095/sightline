import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { test } from 'node:test';

import { toBase64, utf8Encode, type Aead } from '../src/backup/bundle.ts';
import { isSealedData, mergeOpenedData, openSealedPush } from '../src/alerts/sealed.ts';

const { subtle } = webcrypto;

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
const sha256 = async (b: Uint8Array) => new Uint8Array(createHash('sha256').update(b).digest());

// Sealed by the Hub (bridge/seal_test.go TestSealedVectorForApp): the app must open it.
const VECTOR_SECRET = '0123456789abcdef-vector';
const VECTOR_ENC =
  'YPxCa8hdoROqmIYV8AiWTvQOnB5krvKXKC/QAbKfLb6cDNk1GXtwna++EMq0oEAhfubKDAo3btr7vfUAUMKeDarY05jkwOqLKIKeAqBISzveg5IZ6Zc84BN0Jmo9j/dQvY5vfrC/NDKjic87u3XSCAH2xpsyVU/p2S4D5H0FfqV1RIB324zZz9WRu//S1k0Os4Pbjsm7vIk850ayg8FtA4UHCkrrex9yXOkpRDIp/4YahS66b23Rhcdln1E/hwarhmEk5P2g';

test('opens what the Hub sealed', async () => {
  const opened = await openSealedPush(VECTOR_ENC, VECTOR_SECRET, aead, sha256);
  assert.deepEqual(opened, {
    title: 'Person · Front Door',
    body: 'In Driveway',
    threadId: 'hub:front_door',
    data: { systemId: 'hub', cameraId: 'front_door', start: '1699999995', reviewId: 'rev-1' },
  });
});

test('wrong secret, changed data or another key: stays sealed', async () => {
  assert.equal(await openSealedPush(VECTOR_ENC, 'someone-elses-secret', aead, sha256), null);
  const tampered = VECTOR_ENC.slice(0, 40) + (VECTOR_ENC[40] === 'A' ? 'B' : 'A') + VECTOR_ENC.slice(41);
  assert.equal(await openSealedPush(tampered, VECTOR_SECRET, aead, sha256), null);
  assert.equal(await openSealedPush('not base64 at all!', VECTOR_SECRET, aead, sha256), null);
  // Sealed with the thumbnail key (a different derivation) doesn't open as a message.
  const thumbKey = await sha256(utf8Encode('sightline-thumb-v1:' + VECTOR_SECRET));
  const asThumb = toBase64(await aead.seal(thumbKey, utf8Encode('{"v":"1","title":"x"}'), new Uint8Array(0)));
  assert.equal(await openSealedPush(asThumb, VECTOR_SECRET, aead, sha256), null);
});

test('unknown versions are ignored', async () => {
  const key = await sha256(utf8Encode('sightline-msg-v1:' + VECTOR_SECRET));
  const v2 = toBase64(await aead.seal(key, utf8Encode('{"v":"2","title":"x"}'), new Uint8Array(0)));
  assert.equal(await openSealedPush(v2, VECTOR_SECRET, aead, sha256), null);
});

test('merges the opened fields over the visible data', async () => {
  const visible = { enc: VECTOR_ENC, thumb: 'abc' };
  assert.ok(isSealedData(visible));
  assert.ok(!isSealedData({ systemId: 'hub' }));
  assert.ok(!isSealedData(undefined));
  const opened = await openSealedPush(VECTOR_ENC, VECTOR_SECRET, aead, sha256);
  assert.ok(opened);
  assert.deepEqual(mergeOpenedData(visible, opened), {
    thumb: 'abc',
    systemId: 'hub',
    cameraId: 'front_door',
    start: '1699999995',
    reviewId: 'rev-1',
  });
});

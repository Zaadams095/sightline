import { AESEncryptionKey, AESSealedData, aesDecryptAsync, aesEncryptAsync, getRandomBytes } from 'expo-crypto';

import { fromBase64, toBase64, type Aead, type DeriveKey } from '@/backup/bundle';
import { WgTunnel } from '@modules/wg-tunnel';

/** AES-256-GCM through expo-crypto (CryptoKit on iOS). Same layout as the tests' WebCrypto. */
export const nativeAead: Aead = {
  async seal(key, plaintext, aad) {
    const k = await AESEncryptionKey.import(key);
    const sealed = await aesEncryptAsync(plaintext, k, { additionalData: aad });
    return sealed.combined('bytes');
  },
  async open(key, sealed, aad) {
    const k = await AESEncryptionKey.import(key);
    return aesDecryptAsync(AESSealedData.fromCombined(sealed), k, { additionalData: aad });
  },
};

/** True when this build has the Go helpers (PBKDF2 and the Wi-Fi transfer server). */
export const hasTransferSupport = () =>
  typeof WgTunnel?.transferServe === 'function' && typeof WgTunnel?.transferFetch === 'function' && typeof WgTunnel?.deriveKey === 'function';

/** PBKDF2-HMAC-SHA256 in Go (fast enough for 600k rounds; JS would take minutes). */
export const nativeDeriveKey: DeriveKey = async (passcode, salt, iterations) => {
  if (!WgTunnel?.deriveKey) throw new Error('Update Sightline to use backup files.');
  const b64 = await WgTunnel.deriveKey(passcode, toBase64(salt), iterations);
  if (!b64) throw new Error('Couldn’t use that passcode.');
  return fromBase64(b64);
};

export const randomBytes = (n: number) => getRandomBytes(n);

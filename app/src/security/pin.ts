import * as Crypto from 'expo-crypto';

import { secrets } from '@/state/secrets';

/** App PIN, stored as a salted SHA-256 in the Keychain (never in plain text). */
const SCOPE = 'applock';

async function hash(pin: string, salt: string) {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `${salt}:${pin}`);
}

export async function setPin(pin: string) {
  const salt = Array.from(Crypto.getRandomBytes(16), (b) => b.toString(16).padStart(2, '0')).join('');
  await secrets.set(SCOPE, 'salt', salt);
  await secrets.set(SCOPE, 'hash', await hash(pin, salt));
}

export async function hasPin() {
  return !!(await secrets.get(SCOPE, 'hash'));
}

export async function checkPin(pin: string) {
  const [salt, stored] = await Promise.all([secrets.get(SCOPE, 'salt'), secrets.get(SCOPE, 'hash')]);
  if (!salt || !stored) return false;
  return (await hash(pin, salt)) === stored;
}

export async function clearPin() {
  await Promise.all([secrets.remove(SCOPE, 'salt'), secrets.remove(SCOPE, 'hash')]);
}

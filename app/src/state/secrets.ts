import * as SecureStore from 'expo-secure-store';

/** Keychain-backed secrets. Keys are namespaced so a system's secrets can be wiped together. */
const opts: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

const key = (scope: string, name: string) => `${scope}.${name}`.replace(/[^A-Za-z0-9._-]/g, '_');

export const secrets = {
  get: (scope: string, name: string) => SecureStore.getItemAsync(key(scope, name), opts),
  set: (scope: string, name: string, value: string) =>
    SecureStore.setItemAsync(key(scope, name), value, opts),
  remove: (scope: string, name: string) => SecureStore.deleteItemAsync(key(scope, name), opts),
};

export const SECRET = {
  password: 'password',
  token: 'token',
  wireguardConf: 'wg.conf',
} as const;

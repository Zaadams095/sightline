import Constants from 'expo-constants';
import { PermissionsAndroid, Platform, type Permission } from 'react-native';

const ACCESS_LOCAL_NETWORK = 'android.permission.ACCESS_LOCAL_NETWORK';

/**
 * Android 17 blocks an app's traffic to the home network (cameras, recorders, discovery)
 * unless the person allows "Nearby devices", but only for apps that target Android 17
 * (SDK 37). Sightline targets SDK 36 today, where Android grants it with INTERNET, and Google
 * says not to declare or ask for the permission before targeting 37.
 *
 * So this asks only once the app declares the permission (add
 * "android.permission.ACCESS_LOCAL_NETWORK" to app.json android.permissions when moving to
 * targetSdk 37, see docs/ANDROID.md) and on Android 17 or later; otherwise it answers true.
 * Loopback (the tunnel's 127.0.0.1 gateway) and the VPN aren't the local network.
 */
export async function ensureLocalNetworkAccess(): Promise<boolean> {
  if (Platform.OS !== 'android' || Number(Platform.Version) < 37) return true;
  if (!Constants.expoConfig?.android?.permissions?.includes(ACCESS_LOCAL_NETWORK)) return true;
  const permission = ACCESS_LOCAL_NETWORK as Permission;
  try {
    if (await PermissionsAndroid.check(permission)) return true;
    return (await PermissionsAndroid.request(permission)) === PermissionsAndroid.RESULTS.GRANTED;
  } catch {
    return true; // Can't tell: try the network and let the usual errors speak.
  }
}

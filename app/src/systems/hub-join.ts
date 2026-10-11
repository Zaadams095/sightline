import * as Device from 'expo-device';
import { router } from 'expo-router';

import { registerBackgroundAlerts, requestNotificationPermission } from '@/alerts/background';
import { syncHubDevices } from '@/alerts/bridge';
import { connectSystem, disconnectSystem } from '@/net/connection';
import { useApp } from '@/state/store';
import { forgetHubToken, joinHub } from '@/systems/hub';
import type { HubLink } from '@/systems/hub-links';
import { dropAdapter, getAdapter } from '@/systems/registry';

/**
 * Pairs with (owner) or joins (guest) a Hub, checks the cameras load, and saves the system.
 * Returns the number of cameras this phone can see. Throws a readable Error on failure.
 */
export async function joinAndSaveHub(link: HubLink, systemName?: string): Promise<{ cameras: number; hubName: string }> {
  const existed = new Set(useApp.getState().systems.map((s) => s.id));
  const system = await joinHub(link, { deviceName: Device.deviceName ?? undefined, systemName });
  try {
    disconnectSystem(system.id);
    dropAdapter(system.id);
    const conn = await connectSystem(system);
    if (conn.mode === 'offline') throw new Error(conn.error ?? 'Couldn’t reach the Hub.');
    const adapter = getAdapter(system, conn)!;
    await adapter.connect();
    const cams = await adapter.listCameras();
    useApp.getState().upsertSystem(system);
    // Reconnect with the saved config so the published route matches it.
    void connectSystem(system);
    return { cameras: cams.length, hubName: system.extra?.hubName || system.name };
  } catch (e) {
    if (!existed.has(system.id)) {
      disconnectSystem(system.id);
      dropAdapter(system.id);
      await forgetHubToken(system.id);
    }
    throw e;
  }
}

/** After joining: first-time users finish onboarding (alerts on), then go to the cameras. */
export async function finishHubJoin(): Promise<void> {
  const st = useApp.getState();
  if (!st.onboarded) {
    st.setAlerts({ mode: 'instant' });
    await requestNotificationPermission().catch(() => false);
    await registerBackgroundAlerts().catch(() => {});
    void syncHubDevices().catch(() => {});
    // Setup ends with the Face ID offer, which marks onboarding done.
    router.push('/onboarding/lock');
    return;
  }
  void syncHubDevices().catch(() => {});
  router.replace('/');
}

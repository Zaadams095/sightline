import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';

import { syncBridge } from '@/alerts/bridge';
import { useApp } from '@/state/store';

/**
 * Home/Away via iOS region monitoring: the OS wakes the app when you cross the home
 * boundary, even if it isn't running. Location never leaves the phone; only "home" or
 * "away" is synced to the Instant Alerts bridge.
 */
export const GEOFENCE_TASK = 'sightline-home-geofence';
const DEFAULT_RADIUS_M = 150;

interface GeofenceEvent {
  eventType: Location.GeofencingEventType;
  region: Location.LocationRegion;
}

TaskManager.defineTask<GeofenceEvent>(GEOFENCE_TASK, async ({ data, error }) => {
  if (error || !data) return;
  await useApp.persist.rehydrate();
  await setAtHome(data.eventType === Location.GeofencingEventType.Enter);
});

async function setAtHome(atHome: boolean) {
  const { alerts, setAlerts } = useApp.getState();
  if (alerts.presence.atHome === atHome) return;
  setAlerts({ presence: { ...alerts.presence, atHome } });
  if (alerts.mode === 'instant' && alerts.bridge) await syncBridge().catch(() => {});
}

/** Saves the current location as home and starts watching it. Returns an error message or null. */
export async function setHomeHere(): Promise<string | null> {
  const fg = await Location.requestForegroundPermissionsAsync();
  if (!fg.granted) return 'Location access is needed to set your home.';
  const bg = await Location.requestBackgroundPermissionsAsync();
  if (!bg.granted) return 'Choose "Always Allow" for location so Sightline can notice when you get home.';

  const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
  const home = { latitude: pos.coords.latitude, longitude: pos.coords.longitude, radius: DEFAULT_RADIUS_M };
  const { alerts, setAlerts } = useApp.getState();
  setAlerts({ presence: { ...alerts.presence, enabled: true, home, atHome: true } });
  await startWatching();
  return null;
}

export async function startWatching() {
  const { home, enabled } = useApp.getState().alerts.presence;
  if (!enabled || !home) return;
  await Location.startGeofencingAsync(GEOFENCE_TASK, [
    { identifier: 'home', latitude: home.latitude, longitude: home.longitude, radius: home.radius, notifyOnEnter: true, notifyOnExit: true },
  ]);
}

export async function disableHomeAway() {
  if (await Location.hasStartedGeofencingAsync(GEOFENCE_TASK).catch(() => false)) {
    await Location.stopGeofencingAsync(GEOFENCE_TASK);
  }
  const { alerts, setAlerts } = useApp.getState();
  setAlerts({ presence: { ...alerts.presence, enabled: false, atHome: false } });
  if (alerts.mode === 'instant' && alerts.bridge) await syncBridge().catch(() => {});
}

/** Manual override from settings (e.g. guests over: "I'm away"). The next boundary crossing resets it. */
export async function overrideAtHome(atHome: boolean) {
  await setAtHome(atHome);
}

/** Re-registers the region at launch (iOS keeps it, but this covers reinstalls and edits). */
export async function resumeHomeAway() {
  try {
    if (useApp.getState().alerts.presence.enabled) await startWatching();
  } catch {
    // Location permission revoked; the settings screen explains how to fix it.
  }
}

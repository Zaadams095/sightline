import { File, Paths } from 'expo-file-system';
import * as Notifications from 'expo-notifications';

import { requestNotificationPermission } from '@/alerts/background';
import { notificationTitle } from '@/alerts/rules';
import { connectSystem, disconnectSystem } from '@/net/connection';
import { useApp, type CameraLink, type MapPlacement } from '@/state/store';
import { DEMO_GROUPS, DEMO_SYSTEM_ID, DEMO_SYSTEM_NAME, demoEvents } from '@/systems/demo/data';
import { stillUri } from '@/systems/demo/media';
import { useDemoPtz } from '@/systems/demo/ptz';
import { dropAdapter } from '@/systems/registry';
import type { SystemConfig } from '@/systems/types';
import { titleFor } from '@/util/format';
import { fetchToFile } from '@/util/share';

/** Whether a system is Demo mode's sample cameras (never a real recorder). */
export function isDemo(s: Pick<SystemConfig, 'kind'> | null | undefined): boolean {
  return s?.kind === 'demo';
}

export function useDemoActive(): boolean {
  return useApp((s) => s.systems.some(isDemo));
}

export function useOnlyDemo(): boolean {
  return useApp((s) => s.systems.length > 0 && s.systems.every(isDemo));
}

function demoSystem(): SystemConfig {
  return { id: DEMO_SYSTEM_ID, kind: 'demo', name: DEMO_SYSTEM_NAME, endpoint: { lanUrl: '', useTunnel: false } };
}

const key = (cameraId: string) => `${DEMO_SYSTEM_ID}:${cameraId}`;

/** Where the sample cameras sit on the property map, so the Map tab and "next seen on" work. */
const PLACEMENTS: Record<string, MapPlacement> = {
  'front-door': { x: 0.55, y: 0.68, heading: 180, fov: 110 },
  driveway: { x: 0.24, y: 0.7, heading: 180, fov: 90 },
  backyard: { x: 0.5, y: 0.26, heading: 0, fov: 100 },
  garage: { x: 0.24, y: 0.5, heading: 90, fov: 90 },
  'living-room': { x: 0.68, y: 0.46, heading: 270, fov: 100 },
};
const LINKS: CameraLink[] = [
  { a: key('front-door'), b: key('driveway'), transitSec: 12 },
  { a: key('driveway'), b: key('garage'), transitSec: 15 },
  { a: key('front-door'), b: key('living-room'), transitSec: 20 },
  { a: key('living-room'), b: key('backyard'), transitSec: 15 },
];

/**
 * Adds the sample cameras (and finishes setup, so the app opens on them). Works offline and
 * in Expo Go: nothing is downloaded.
 */
export async function startDemo() {
  const st = useApp.getState();
  const system = demoSystem();
  st.upsertSystem(system);

  // Groups and map spots show off those features; anything the user already set stays.
  for (const g of DEMO_GROUPS) {
    const id = `${DEMO_SYSTEM_ID}-${g.name}`;
    if (!st.cameraGroups.some((x) => x.id === id)) {
      st.saveGroup({ id, name: g.name, cameraKeys: g.cameraIds.map(key), source: DEMO_SYSTEM_ID });
    }
  }
  const map = useApp.getState().cameraMap;
  const placements = { ...map.placements };
  for (const [id, p] of Object.entries(PLACEMENTS)) placements[key(id)] ??= p;
  const links = [...map.links, ...LINKS.filter((l) => !map.links.some((x) => x.a === l.a && x.b === l.b))];
  st.setCameraMap({ placements, links });

  await connectSystem(system);
  st.setOnboarded(true);
}

/** Removes the sample cameras and everything Demo mode added. */
export function removeDemo() {
  const st = useApp.getState();
  disconnectSystem(DEMO_SYSTEM_ID);
  dropAdapter(DEMO_SYSTEM_ID);
  st.removeSystem(DEMO_SYSTEM_ID);
  for (const g of st.cameraGroups) if (g.source === DEMO_SYSTEM_ID) st.deleteGroup(g.id);
  for (const c of st.savedClips) if (c.systemId === DEMO_SYSTEM_ID) st.removeClip(c.id);
  const mine = (k: string) => k.startsWith(`${DEMO_SYSTEM_ID}:`);
  const map = useApp.getState().cameraMap;
  st.setCameraMap({
    placements: Object.fromEntries(Object.entries(map.placements).filter(([k]) => !mine(k))),
    links: map.links.filter((l) => !mine(l.a) && !mine(l.b)),
  });
  useDemoPtz.setState({ views: {} });
  // With nothing left, the app goes back to the welcome screen.
  if (useApp.getState().systems.length === 0) st.setOnboarded(false);
}

/**
 * Sends one sample alert a few seconds from now (after asking for permission), so people can
 * see what alerts look like. Only ever called from a button the person tapped.
 */
export async function sendSampleAlert(delaySec = 4): Promise<'scheduled' | 'denied'> {
  if (!(await requestNotificationPermission())) return 'denied';
  const now = Date.now() / 1000;
  const ev = demoEvents(now, { cameras: ['front-door'], after: now - 86400 }).find((e) => e.endTime != null && !e.objects.includes('doorbell'));
  const item = ev ?? { objects: ['person'], subLabels: [], startTime: now - 60, id: '' };

  const attachments: Notifications.NotificationContentAttachmentIos[] = [];
  try {
    const file = await fetchToFile(stillUri(ev?.kind.thumb ?? 'front-door-event'), new File(Paths.cache, 'sample-alert.jpg'));
    attachments.push({ identifier: 'sample', url: file.uri, type: 'public.jpeg', typeHint: 'public.jpeg' } as never);
  } catch {
    // A text-only alert is fine.
  }

  await Notifications.scheduleNotificationAsync({
    content: {
      title: notificationTitle(item, 'Front Door', titleFor(item)),
      body: 'Sample alert. Your own cameras’ alerts look like this. Tap to watch the recording.',
      // kind marks it as a sample: no Lock Screen activity, and a tap opens the recording.
      data: { systemId: DEMO_SYSTEM_ID, cameraId: 'front-door', start: String(Math.floor(item.startTime - 5)), reviewId: item.id, kind: 'sample' },
      attachments,
    },
    trigger: { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds: delaySec },
  });
  return 'scheduled';
}

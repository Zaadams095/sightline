import { Image } from 'react-native';

import type { DemoClip, DemoStill } from '@/systems/demo/data';

/*
 * Sample footage bundled with the app (app/assets/demo, about 4 MB). It is drawn by
 * scripts/demo-media from simple shapes, so it has no third-party license, and it plays with
 * no network at all. In Expo Go the files come from the dev server like any other asset.
 */
const CLIPS: Record<string, Record<DemoClip, number>> = {
  'front-door': { live: require('../../../assets/demo/front-door-live.mp4'), event: require('../../../assets/demo/front-door-event.mp4') },
  driveway: { live: require('../../../assets/demo/driveway-live.mp4'), event: require('../../../assets/demo/driveway-event.mp4') },
  backyard: { live: require('../../../assets/demo/backyard-live.mp4'), event: require('../../../assets/demo/backyard-event.mp4') },
  garage: { live: require('../../../assets/demo/garage-live.mp4'), event: require('../../../assets/demo/garage-event.mp4') },
  'living-room': { live: require('../../../assets/demo/living-room-live.mp4'), event: require('../../../assets/demo/living-room-event.mp4') },
};

const STILLS: Record<DemoStill, number> = {
  'front-door-live': require('../../../assets/demo/front-door-live.jpg'),
  'front-door-event': require('../../../assets/demo/front-door-event.jpg'),
  'front-door-ring': require('../../../assets/demo/front-door-ring.jpg'),
  'front-door-package': require('../../../assets/demo/front-door-package.jpg'),
  'driveway-live': require('../../../assets/demo/driveway-live.jpg'),
  'driveway-street': require('../../../assets/demo/driveway-street.jpg'),
  'driveway-event': require('../../../assets/demo/driveway-event.jpg'),
  'backyard-live': require('../../../assets/demo/backyard-live.jpg'),
  'backyard-event': require('../../../assets/demo/backyard-event.jpg'),
  'garage-live': require('../../../assets/demo/garage-live.jpg'),
  'garage-event': require('../../../assets/demo/garage-event.jpg'),
  'living-room-live': require('../../../assets/demo/living-room-live.jpg'),
  'living-room-event': require('../../../assets/demo/living-room-event.jpg'),
};

const uriOf = (mod: number) => Image.resolveAssetSource(mod)?.uri ?? '';

export function clipUri(cameraId: string, clip: DemoClip): string {
  const c = CLIPS[cameraId];
  return c ? uriOf(c[clip]) : '';
}

export function stillUri(still: DemoStill): string {
  return uriOf(STILLS[still]);
}

/** The bundled module for a still (for expo-asset, e.g. to attach it to a notification). */
export function stillModule(still: DemoStill): number {
  return STILLS[still];
}

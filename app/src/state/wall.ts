import Storage from 'expo-sqlite/kv-store';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import type { NightSettings, TourMode } from '@/wall/schedule';

/** Wall display settings (iPad on the wall). Kept apart from the main store. */
export interface WallSettings {
  mode: TourMode;
  /** Seconds per page of the tour. */
  intervalSec: number;
  /** Cameras on the wall, in order; empty = all cameras. */
  cameraKeys: string[];
  /** Show the doorbell full screen when someone rings. */
  jumpToDoorbell: boolean;
  /** Show a camera full screen for a new alert (uses your alert settings). */
  jumpToAlerts: boolean;
  night: NightSettings;
  showClock: boolean;
}

interface WallState extends WallSettings {
  setWall(p: Partial<WallSettings>): void;
}

export const DEFAULT_WALL: WallSettings = {
  mode: 'grid',
  intervalSec: 15,
  cameraKeys: [],
  jumpToDoorbell: true,
  jumpToAlerts: true,
  night: { enabled: true, start: '22:00', end: '06:30', level: 0.6 },
  showClock: true,
};

export const useWall = create<WallState>()(
  persist(
    (set) => ({
      ...DEFAULT_WALL,
      setWall: (p) => set(p),
    }),
    {
      name: 'wall-display',
      version: 1,
      storage: createJSONStorage(() => Storage),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<WallState>;
        return { ...current, ...p, night: { ...current.night, ...p.night } };
      },
    },
  ),
);

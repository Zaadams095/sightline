import { requireOptionalNativeModule } from 'expo-modules-core';

/** Must match SightlineActivityAttributes.ContentState (ios/LiveActivityModule.swift, targets/widget/LiveActivity.swift). */
export interface ActivityState {
  headline: string;
  /** Small JPEG relative to the App Group container (from saveImage). */
  image?: string | null;
  /** Unix seconds the ring / event began. */
  since: number;
  ended: boolean;
}

export interface ActivityStart {
  kind: 'doorbell' | 'event';
  key: string;
  camera: string;
  url: string;
  state: ActivityState;
  maxSeconds: number;
}

interface NativeLiveActivity {
  isEnabled(): boolean;
  list(): { id: string; key: string; kind: string }[];
  start(opts: ActivityStart): Promise<string>;
  update(id: string, state: ActivityState): Promise<void>;
  end(id: string, state: ActivityState | null, dismissAfterSec: number): Promise<void>;
  endAll(): Promise<void>;
  endStale(): Promise<void>;
  saveImage(fromUri: string, relPath: string, maxSide: number): Promise<string | null>;
}

/** Lock Screen / Dynamic Island Live Activities. null in Expo Go, on Android and older builds. */
export const LiveActivity = requireOptionalNativeModule<NativeLiveActivity>('LiveActivity');

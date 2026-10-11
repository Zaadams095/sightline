import { requireOptionalNativeModule } from 'expo-modules-core';

export interface WatchStatus {
  supported: boolean;
  paired: boolean;
  installed: boolean;
  reachable: boolean;
}

/** A request from the watch. `id` is '' when the watch isn't waiting for a reply. */
export interface WatchRequestEvent {
  id: string;
  /** JSON of the watch's message, e.g. {"type":"snapshot","key":"sys:cam","size":300}. */
  body: string;
}

interface Subscription {
  remove(): void;
}

interface NativeWatchBridge {
  status(): WatchStatus;
  updateContext(json: string): Promise<void>;
  sendCredentials(json: string): Promise<void>;
  replyImage(id: string, key: string, fileUri: string, maxPixels: number): Promise<boolean>;
  /** Answers a request with a small message, e.g. {ok: '1'} or {error: '…'}. */
  reply(id: string, message: Record<string, string>): void;
  pushImage(key: string, fileUri: string, maxPixels: number): Promise<boolean>;
  addListener(event: 'onWatchRequest', listener: (e: WatchRequestEvent) => void): Subscription;
}

/** WatchConnectivity link to the Apple Watch app. null in Expo Go and on builds without it. */
export const WatchBridge = requireOptionalNativeModule<NativeWatchBridge>('WatchBridge');

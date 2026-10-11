import { create } from 'zustand';

/** Breakdown of the most recent live-view startup, in ms from opening the camera. */
export interface LiveStartup {
  camera: string;
  /** Web player page loaded (WebKit startup). */
  page: number;
  /** WebSocket to the stream connected. */
  wsOpen?: number;
  /** go2rtc agreed on codecs (stream is up on the server). */
  codecs?: number;
  /** First video data arrived (waits for the camera's next keyframe). */
  firstData?: number;
  /** Video is playing. */
  playing?: number;
}

export const useLiveStats = create<{ last: LiveStartup | null; set(s: LiveStartup): void }>((set) => ({
  last: null,
  set: (last) => set({ last }),
}));

export function describeStartup(s: LiveStartup): string {
  const step = (a: number | undefined, b: number | undefined) => (a != null && b != null ? `${b - a} ms` : '?');
  return [
    `Camera: ${s.camera}`,
    `Total to video: ${s.playing ?? '?'} ms`,
    `  Player load: ${s.page} ms`,
    `  Connect: ${step(s.page, s.wsOpen)}`,
    `  Stream ready: ${step(s.wsOpen, s.codecs)}`,
    `  Wait for keyframe: ${step(s.codecs, s.firstData)}`,
    `  Decode & show: ${step(s.firstData, s.playing)}`,
  ].join('\n');
}

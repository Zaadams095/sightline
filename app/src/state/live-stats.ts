import { create } from 'zustand';

import type { HubLiveStart } from '@/systems/hub-links';

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
  /** Through a Sightline Hub: how the Hub started the stream (cached picture, warm, cold). */
  hub?: HubLiveStart;
}

export const useLiveStats = create<{ last: LiveStartup | null; set(s: LiveStartup): void }>((set) => ({
  last: null,
  set: (last) => set({ last }),
}));

// The codecs this phone's player supports (reported by the WebView), so a Hub warm-up can
// start the stream in a format this phone can join.
let playerCodecs = '';
export const rememberPlayerCodecs = (c: string) => {
  if (c) playerCodecs = c;
};
export const knownPlayerCodecs = () => playerCodecs;

const HUB_START: Record<string, string> = {
  gop: 'camera already streaming, cached picture sent at once',
  warm: 'camera already connected, waited for a keyframe',
  cold: 'Hub connected to the camera for this view',
  dedicated: 'separate stream for this phone’s video format',
};

export function describeStartup(s: LiveStartup): string {
  const step = (a: number | undefined, b: number | undefined) => (a != null && b != null ? `${b - a} ms` : '?');
  const lines = [
    `Camera: ${s.camera}`,
    `Total to video: ${s.playing ?? '?'} ms`,
    `  Player load: ${s.page} ms`,
    `  Connect: ${step(s.page, s.wsOpen)}`,
    `  Stream ready: ${step(s.wsOpen, s.codecs)}`,
    `  Wait for keyframe: ${step(s.codecs, s.firstData)}`,
    `  Decode & show: ${step(s.firstData, s.playing)}`,
  ];
  if (s.hub) {
    const u = s.hub.upstream ?? {};
    lines.push(`  Hub: ${HUB_START[s.hub.start] ?? s.hub.start} (ready after ${s.hub.waitMs ?? '?'} ms)`);
    if (s.hub.start === 'cold' || s.hub.start === 'dedicated') {
      lines.push(`  Hub to camera: connect ${u.connectMs ?? '?'} ms, first keyframe ${u.keyframeMs ?? '?'} ms`);
    }
  }
  return lines.join('\n');
}

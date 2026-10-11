/**
 * Pure helpers for two-way audio and deterrence (no React Native imports, so `npm test`
 * covers them). The native side is tunnel/wgtunnel/talk.go; the Hub's is bridge/talk.go.
 */

import type { DeterInfo, SystemCapabilities, TalkTarget } from '../systems/types';

/** The talk layer's own wire format: 16-bit little-endian mono PCM at this rate. */
export const TALK_SAMPLE_RATE = 8000;

/** A press shorter than this latches Talk on (tap to talk, tap again to stop). */
export const TALK_TAP_MS = 350;

/**
 * host:port the phone must reach for a talk target (to choose home network vs. tunnel).
 * null for the Hub's WebSocket, which is always reached directly.
 */
export function talkHostPort(target: TalkTarget): string | null {
  if (target.kind === 'ws') return null;
  try {
    const u = new URL(target.url.replace(/^rtsps?:/i, 'http:'));
    const port = u.port || (target.kind === 'isapi' ? '80' : /^rtsps:/i.test(target.url) ? '322' : '554');
    return `${u.hostname.includes(':') ? `[${u.hostname}]` : u.hostname}:${port}`;
  } catch {
    return null;
  }
}

/**
 * Whether to even ask a camera about talking: the system says it may (capability + method) and
 * this build of the app has the native talk support (older binaries running newer JS don't).
 */
export function mayOfferTalk(caps: SystemCapabilities, hasTalkTarget: boolean, nativeTalk: boolean): boolean {
  return caps.twoWayAudio && hasTalkTarget && nativeTalk;
}

/** Which deterrence buttons to show: only what the camera itself says it has. */
export function deterButtons(caps: SystemCapabilities, info: DeterInfo | null | undefined): { light: boolean; siren: boolean } {
  if (!caps.deter || !info) return { light: false, siren: false };
  return { light: !!info.light, siren: !!info.siren };
}

/** The siren confirmation, in plain words. */
export function sirenConfirmText(info: DeterInfo): string {
  const secs = info.sirenSec ? ` for about ${info.sirenSec} seconds` : '';
  return `It’s very loud and plays${secs}, then stops by itself.`;
}

// ---- push-to-talk button: hold to talk, or tap to latch ----

export type TalkPress = 'idle' | 'holding' | 'latched';

/** Finger down. Returns the new mode and whether to start or stop talking. */
export function pressIn(mode: TalkPress): { mode: TalkPress; action: 'start' | 'stop' | 'none' } {
  if (mode === 'latched') return { mode: 'idle', action: 'stop' };
  if (mode === 'idle') return { mode: 'holding', action: 'start' };
  return { mode, action: 'none' };
}

/** Finger up after heldMs. A quick tap keeps talking; a hold stops on release. */
export function pressOut(mode: TalkPress, heldMs: number): { mode: TalkPress; action: 'stop' | 'none' } {
  if (mode !== 'holding') return { mode, action: 'none' };
  if (heldMs < TALK_TAP_MS) return { mode: 'latched', action: 'none' };
  return { mode: 'idle', action: 'stop' };
}

/** What the mic page reports, as words for the button. */
export type TalkState = 'idle' | 'connecting' | 'talking';

export function talkLabel(state: TalkState, mode: TalkPress): { title: string; hint: string } {
  if (state === 'connecting') return { title: 'Connecting…', hint: mode === 'latched' ? 'Tap to cancel' : 'Keep holding' };
  if (state === 'talking') return { title: 'Talking…', hint: mode === 'latched' ? 'Tap to stop' : 'Let go to stop' };
  return { title: 'Talk', hint: 'Hold to talk, or tap' };
}

/** A failure from the mic page or the camera, as something anyone can act on. */
export function talkErrorText(code: string): string {
  switch (code) {
    case 'mic-denied':
      return 'Sightline isn’t allowed to use the microphone. You can turn it on in Settings → Sightline → Microphone.';
    case 'mic-failed':
      return 'The microphone couldn’t start. Close other apps that are using it and try again.';
    case 'closed':
      return 'The camera ended the conversation.';
    case 'unreachable':
      return 'Can’t reach this camera’s speaker right now.';
    default:
      // The tunnel library and the Hub already send plain-language reasons.
      return code || 'Couldn’t connect to the camera’s speaker.';
  }
}

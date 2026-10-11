import type { VideoPlayer } from 'expo-video';

// Imperative player helpers. Mutating the hook-returned player inline trips the React
// Compiler's immutability rule; routing through plain functions keeps intent explicit.
export function seekPlayer(player: VideoPlayer, seconds: number) {
  player.currentTime = seconds;
}

export function setPlayerRate(player: VideoPlayer, rate: number) {
  player.playbackRate = rate;
}

export function setPlayerMuted(player: VideoPlayer, muted: boolean) {
  player.muted = muted;
}

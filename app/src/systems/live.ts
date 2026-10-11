import { ensureTunnel } from '@/net/connection';
import type { LiveSource, SystemConfig } from '@/systems/types';
import { WgTunnel } from '@modules/wg-tunnel';

/** What the players can show directly. RTSP never reaches the UI; it's restreamed to MSE. */
export type ResolvedLive = ({ kind: 'mse'; wsUrl: string } | { kind: 'hls'; uri: string } | { kind: 'mjpeg'; uri: string }) & {
  /** System kind, for diagnostics only. */
  brand?: string;
};

/** Running restreamers by RTSP URL, with the system that opened each (to release per system). */
const rtspPorts = new Map<string, { port: number; systemId: string }>();

function rtspHostPort(url: string): string {
  const u = new URL(url.replace(/^rtsps?:/, 'http:'));
  return `${u.hostname}:${u.port || '554'}`;
}

/**
 * Turns any adapter's LiveSource into a playable one. RTSP (most NVRs and IP cameras) is
 * restreamed in-process by the tunnel library, directly on home Wi-Fi or through the VPN
 * when the camera isn't reachable and the system allows it.
 */
export async function resolveLive(source: LiveSource, system: SystemConfig): Promise<ResolvedLive> {
  if (source.kind !== 'rtsp') return source.kind === 'mse' ? { kind: 'mse', wsUrl: source.wsUrl } : source;
  if (!WgTunnel) throw new Error('Live view for this camera needs the full app (not Expo Go).');

  const direct = await WgTunnel.probe(rtspHostPort(source.url), false, 1500);
  let viaTunnel = false;
  if (!direct) {
    if (!system.endpoint.useTunnel) throw new Error('This camera isn’t reachable from this network.');
    await ensureTunnel();
    viaTunnel = true;
  }

  let port = rtspPorts.get(source.url)?.port;
  if (port == null) {
    port = await WgTunnel.addRTSPSource(source.url, viaTunnel);
    rtspPorts.set(source.url, { port, systemId: system.id });
  } else {
    WgTunnel.setRTSPViaTunnel(port, viaTunnel);
  }
  return { kind: 'mse', wsUrl: `ws://127.0.0.1:${port}/api/ws` };
}

/** Stops the restreamer for one RTSP URL (e.g. a playback stream that's no longer shown). */
export function releaseLiveUrl(url: string) {
  const entry = rtspPorts.get(url);
  if (entry) {
    WgTunnel?.removeRTSPSource(entry.port);
    rtspPorts.delete(url);
  }
}

/** Stops every restreamer one system opened (e.g. after its address or sign-in changed). */
export function releaseSystemLive(systemId: string) {
  for (const [url, entry] of rtspPorts) {
    if (entry.systemId === systemId) {
      WgTunnel?.removeRTSPSource(entry.port);
      rtspPorts.delete(url);
    }
  }
}

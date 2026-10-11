import { ensureTunnel } from '@/net/connection';
import type { LiveSource, SystemConfig } from '@/systems/types';
import { WgTunnel } from '@modules/wg-tunnel';

/** What the players can show directly. RTSP never reaches the UI; it's restreamed to MSE. */
export type ResolvedLive = { kind: 'mse'; wsUrl: string } | { kind: 'hls'; uri: string } | { kind: 'mjpeg'; uri: string };

const rtspPorts = new Map<string, number>();

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

  let port = rtspPorts.get(source.url);
  if (port == null) {
    port = await WgTunnel.addRTSPSource(source.url, viaTunnel);
    rtspPorts.set(source.url, port);
  } else {
    WgTunnel.setRTSPViaTunnel(port, viaTunnel);
  }
  return { kind: 'mse', wsUrl: `ws://127.0.0.1:${port}/api/ws` };
}

/** Drops restreamers whose URL starts with a prefix (e.g. after a system's credentials change). */
export function releaseLive(urlPrefix: string) {
  for (const [url, port] of rtspPorts) {
    if (url.startsWith(urlPrefix)) {
      WgTunnel?.removeRTSPSource(port);
      rtspPorts.delete(url);
    }
  }
}

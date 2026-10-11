import { useQuery } from '@tanstack/react-query';

import { tr } from '@/i18n';
import { ensureTunnel } from '@/net/connection';
import { useApp } from '@/state/store';
import type { CameraSystemAdapter, SystemConfig, TalkTarget } from '@/systems/types';
import { mayOfferTalk, talkHostPort } from '@/talk/talk-core';
import { WgTunnel } from '@modules/wg-tunnel';

/**
 * Two-way audio for every brand. Adapters only say where a camera's speaker is (TalkTarget);
 * this layer decides home network vs. tunnel, asks the camera whether it really takes audio
 * (so Talk is never shown broken), and opens the tunnel library's loopback talk endpoint that
 * the microphone page (talk-page.ts) streams to.
 */

/** A talk target with its route, ready for WgTunnel.addTalk. */
export interface TalkRoute {
  kind: TalkTarget['kind'];
  url: string;
  viaTunnel: boolean;
  /** The camera speaker's codec, when the camera was asked (not for Hub targets). */
  codec?: string;
}

/** This build of the app has the native talk endpoint (older binaries running newer JS don't). */
export function nativeTalkAvailable(): boolean {
  return typeof WgTunnel?.addTalk === 'function' && typeof WgTunnel?.probeTalk === 'function';
}

/** Chooses direct or tunnel for a target; null when the camera can't be reached at all. */
async function routeOf(target: TalkTarget, system: SystemConfig): Promise<TalkRoute | null> {
  if (target.kind === 'ws') return { kind: 'ws', url: target.url, viaTunnel: false };
  const hostPort = talkHostPort(target);
  if (!hostPort || !WgTunnel) return null;
  if (await WgTunnel.probe(hostPort, false, 1500)) return { kind: target.kind, url: target.url, viaTunnel: false };
  if (!system.endpoint.useTunnel) return null;
  await ensureTunnel();
  return { kind: target.kind, url: target.url, viaTunnel: true };
}

/** Whether a camera can take the user's voice right now, and how to reach it. */
export async function findTalkRoute(adapter: CameraSystemAdapter, cameraId: string, system: SystemConfig): Promise<TalkRoute | null> {
  if (!mayOfferTalk(adapter.capabilities, !!adapter.talkTarget, nativeTalkAvailable())) return null;
  const target = await adapter.talkTarget!(cameraId);
  if (!target) return null;
  const route = await routeOf(target, system);
  if (!route) return null;
  if (route.kind === 'ws') return route; // the Hub already asked the camera
  const codec = await WgTunnel!.probeTalk!(route.kind, route.url, route.viaTunnel, 6000);
  return codec ? { ...route, codec } : null;
}

/** Talk availability for one camera (null while unknown or when it can't talk). */
export function useTalkRoute(adapter: CameraSystemAdapter | null, systemId: string, cameraId: string) {
  const system = useApp((s) => s.systems.find((x) => x.id === systemId));
  const query = useQuery({
    queryKey: ['talk-route', systemId, cameraId, !!adapter],
    queryFn: () => findTalkRoute(adapter!, cameraId, system!),
    enabled: !!adapter && !!system && !!adapter.capabilities.twoWayAudio && nativeTalkAvailable(),
    // A camera's speaker doesn't come and go; don't keep asking it.
    staleTime: 10 * 60_000,
    retry: false,
  });
  return query.data ?? null;
}

/** Opens the loopback talk endpoint for a route; returns its port. */
export async function openTalk(route: TalkRoute): Promise<number> {
  if (!nativeTalkAvailable()) throw new Error(tr().viewing.talk.needsUpdate);
  if (route.viaTunnel) await ensureTunnel();
  return WgTunnel!.addTalk!(route.kind, route.url, route.viaTunnel);
}

export function closeTalk(port: number) {
  WgTunnel?.removeTalk?.(port);
}

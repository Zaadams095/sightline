import { useQuery } from '@tanstack/react-query';

import { useLinks, type SystemLink } from '@/net/connection';
import { useApp } from '@/state/store';
import { AgentDvrAdapter } from '@/systems/agent-dvr';
import { BlueIrisAdapter } from '@/systems/blue-iris';
import { DahuaAdapter } from '@/systems/dahua';
import { FrigateAdapter } from '@/systems/frigate';
import { usesGateway } from '@/systems/catalog';
import { OnvifAdapter } from '@/systems/onvif';
import { HikvisionAdapter } from '@/systems/hikvision';
import { ReolinkAdapter } from '@/systems/reolink';
import { RtspAdapter } from '@/systems/rtsp';
import { ScryptedAdapter } from '@/systems/scrypted';
import { ShinobiAdapter } from '@/systems/shinobi';
import { ZoneMinderAdapter } from '@/systems/zoneminder';
import { UnifiProtectAdapter } from '@/systems/unifi-protect';
import type { Camera, CameraSystemAdapter, SystemConfig } from '@/systems/types';

const adapters = new Map<string, CameraSystemAdapter>();

function create(s: SystemConfig, baseUrl: string): CameraSystemAdapter {
  switch (s.kind) {
    case 'frigate':
      return new FrigateAdapter(s, baseUrl);
    case 'dahua':
      return new DahuaAdapter(s, baseUrl);
    case 'unifi-protect':
      return new UnifiProtectAdapter(s, baseUrl);
    case 'rtsp':
      return new RtspAdapter(s);
    case 'onvif':
      return new OnvifAdapter(s, baseUrl);
    case 'blue-iris':
      return new BlueIrisAdapter(s, baseUrl);
    case 'agent-dvr':
      return new AgentDvrAdapter(s, baseUrl);
    case 'shinobi':
      return new ShinobiAdapter(s, baseUrl);
    case 'zoneminder':
      return new ZoneMinderAdapter(s, baseUrl);
    case 'scrypted':
      return new ScryptedAdapter(s, baseUrl);
    case 'reolink':
      return new ReolinkAdapter(s, baseUrl);
    case 'hikvision':
      return new HikvisionAdapter(s, baseUrl);
    default:
      throw new Error(`${s.kind} is not supported yet`);
  }
}

/** Adapter for a system, kept in sync with its current route (LAN vs tunnel port). */
export function getAdapter(s: SystemConfig, link: SystemLink | undefined): CameraSystemAdapter | null {
  // Systems reached over HTTP need a route (gateway port) before an adapter is useful.
  if (usesGateway(s.kind) && !link?.baseUrl) return null;
  let a = adapters.get(s.id);
  if (a && a.config !== s) {
    a.dispose();
    a = undefined;
  }
  if (!a) {
    a = create(s, link?.baseUrl ?? '');
    adapters.set(s.id, a);
  } else if (link?.baseUrl) {
    a.setBaseUrl?.(link.baseUrl);
  }
  return a;
}

export function dropAdapter(id: string) {
  adapters.get(id)?.dispose();
  adapters.delete(id);
}

export function useAdapter(systemId: string): CameraSystemAdapter | null {
  const system = useApp((st) => st.systems.find((s) => s.id === systemId));
  const link = useLinks((st) => st.links[systemId]);
  if (!system) return null;
  return getAdapter(system, link);
}

export interface CameraEntry {
  camera: Camera;
  adapter: CameraSystemAdapter;
}

/** All cameras across all systems, in the user's order, hidden ones removed. */
export function useAllCameras(opts: { includeHidden?: boolean } = {}) {
  const systems = useApp((st) => st.systems);
  const links = useLinks((st) => st.links);
  const order = useApp((st) => st.phoneOrder);
  const hidden = useApp((st) => st.hidden);

  const ready = systems.filter((s) => !usesGateway(s.kind) || links[s.id]?.mode === 'lan' || links[s.id]?.mode === 'tunnel');
  const key = ready.map((s) => `${s.id}@${links[s.id]?.baseUrl ?? ''}`).join('|');

  const query = useQuery({
    queryKey: ['cameras', key],
    enabled: ready.length > 0,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const results = await Promise.allSettled(
        ready.map(async (s) => {
          const adapter = getAdapter(s, links[s.id])!;
          const cams = await adapter.listCameras();
          return cams.map((camera) => ({ camera, adapter }));
        }),
      );
      return results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
    },
  });

  const entries = sortByOrder(query.data ?? [], order).filter(
    (e) => opts.includeHidden || !hidden.includes(e.camera.key),
  );
  return { ...query, entries };
}

function sortByOrder(entries: CameraEntry[], order: string[]) {
  const idx = new Map(order.map((k, i) => [k, i]));
  return [...entries].sort(
    (a, b) => (idx.get(a.camera.key) ?? 1e6) - (idx.get(b.camera.key) ?? 1e6),
  );
}

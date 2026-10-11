import { CATALOG, discoveryPorts, type ProbeResult, type SystemDescriptor } from '@/systems/catalog';
import { matchesScan, type StreamTarget, type SystemTarget } from '@/systems/guides';
import type { SystemKind } from '@/systems/types';
import { resolveScheme } from '@/util/url';
import { WgTunnel } from '@modules/wg-tunnel';

export interface Found {
  host: string;
  /** Best guess, or null when only a camera stream port (RTSP) answered. */
  kind: SystemKind | null;
  label: string;
  /** Address to prefill (host:port) for the matched brand. */
  address: string;
}

/**
 * "Find my cameras": scan the phone's local network for camera/NVR ports, then identify each
 * device with a cheap HTTP request per brand fingerprint. Takes ~10–20 s on a /24.
 */
export async function discover(onProgress?: (msg: string) => void): Promise<Found[]> {
  const byHost = await scanNetwork(discoveryPorts(), onProgress);
  onProgress?.(`Checking ${byHost.size} device${byHost.size === 1 ? '' : 's'}…`);
  const results = await Promise.all(
    [...byHost].map(async ([host, hostPorts]) => (await identify(host, hostPorts)) ?? null),
  );
  return results.filter((r): r is Found => !!r).sort((a, b) => Number(!a.kind) - Number(!b.kind) || a.host.localeCompare(b.host, undefined, { numeric: true }));
}

/** Every device on the phone's local network with any of these ports open (host → open ports). */
export async function scanNetwork(ports: number[], onProgress?: (msg: string) => void): Promise<Map<string, Set<number>>> {
  if (!WgTunnel) throw new Error('Finding cameras needs the full app (not Expo Go).');
  const subnets = JSON.parse(WgTunnel.localSubnets()) as string[];
  if (!subnets.length) throw new Error('Connect to your home Wi-Fi first.');

  const open: string[] = [];
  for (const cidr of subnets) {
    onProgress?.(`Looking around ${cidr.replace('.0/24', '.x')}…`);
    open.push(...(JSON.parse(await WgTunnel.scanSubnet(cidr, ports.join(','), 400)) as string[]));
  }

  const byHost = new Map<string, Set<number>>();
  for (const hp of open) {
    const i = hp.lastIndexOf(':');
    const host = hp.slice(0, i);
    byHost.set(host, (byHost.get(host) ?? new Set()).add(Number(hp.slice(i + 1))));
  }
  return byHost;
}

/**
 * Guided setup: find devices that look like the brand being set up. Stream cameras are matched
 * by their ports; recorders by the adapter's own fingerprints, so only that brand shows.
 */
export async function discoverFor(target: StreamTarget | SystemTarget, onProgress?: (msg: string) => void): Promise<Found[]> {
  if (target.type === 'system') {
    const found = await discover(onProgress);
    return found.filter((f) => f.kind === target.system);
  }
  const byHost = await scanNetwork(target.scan.ports, onProgress);
  return [...byHost]
    .filter(([, open]) => matchesScan(open, target.scan))
    .map(([host]) => ({ host, kind: null, label: target.cameraName, address: host }))
    .sort((a, b) => a.host.localeCompare(b.host, undefined, { numeric: true }));
}

async function identify(host: string, ports: Set<number>): Promise<Found | null> {
  // Hub and recorders first: a recorder often also exposes RTSP and ONVIF.
  const ordered = [...CATALOG].sort((a, b) => rank(a) - rank(b));
  for (const d of ordered) {
    for (const fp of d.fingerprints) {
      if (!ports.has(fp.port)) continue;
      const url = `${fp.https ? 'https' : 'http'}://${host}:${fp.port}${fp.path}`;
      const r = JSON.parse(await WgTunnel!.httpProbe(url, 2500)) as ProbeResult;
      if (!r.error && fp.match(r)) return { host, kind: d.kind, label: d.label, address: `${host}:${fp.port}` };
    }
  }
  if (ports.has(554)) return { host, kind: null, label: 'Camera', address: host };
  return null;
}

function rank(d: SystemDescriptor) {
  return { hub: 0, software: 1, recorder: 2, camera: 3, demo: 4 }[d.category];
}

/**
 * Turns what the user typed into a full URL. A bare host tries the brand's usual ports in
 * order; https:// is downgraded when the server actually speaks plain HTTP.
 */
export async function resolveAddress(d: SystemDescriptor, input: string): Promise<string> {
  const raw = input.trim().replace(/\/+$/, '');
  if (/^https?:\/\//i.test(raw)) return raw;

  const portMatch = raw.match(/:(\d+)$/);
  const host = portMatch ? raw.slice(0, -portMatch[0].length) : raw;
  let candidates = d.defaultPorts;
  if (portMatch) {
    const port = Number(portMatch[1]);
    const known = d.defaultPorts.find((p) => p.port === port);
    candidates = [{ port, https: known ? known.https : port === 443 || port === 8443 || port === 8971 }];
  }

  let chosen = candidates[0];
  if (WgTunnel && candidates.length > 1) {
    for (const c of candidates) {
      if (await WgTunnel.probe(`${host}:${c.port}`, false, 1500)) {
        chosen = c;
        break;
      }
    }
  }
  if (!chosen) return `http://${host}`;
  const url = `${chosen.https ? 'https' : 'http'}://${host}:${chosen.port}`;
  return WgTunnel ? resolveScheme(url, (u) => WgTunnel!.httpCheck(u, false, 4000)) : url;
}

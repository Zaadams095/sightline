/**
 * The TV talks only to a Sightline Hub (docs/HUB_API.md), with its own revocable token: the
 * Hub is the brand-neutral path, so every brand behind it works on the TV too.
 */

export interface TvConfig {
  hubName: string;
  lanUrl: string;
  remoteUrl: string;
  token: string;
}

export interface HubCamera {
  id: string;
  name: string;
  enabled: boolean;
  aspect: number;
}

/** What the iPhone app POSTs to the TV (see app/src/tv/link.ts). */
export interface PairBody {
  key: string;
  hub: { name: string; lanUrl: string; remoteUrl: string };
  code: string;
}

export class HubError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code = '', status = 0) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const trim = (u: string) => u.replace(/\/+$/, '');
const enc = encodeURIComponent;

export function parsePairBody(body: string): PairBody | null {
  try {
    const b = JSON.parse(body) as Partial<PairBody>;
    if (!b || typeof b.key !== 'string' || typeof b.code !== 'string' || !b.hub || typeof b.hub.lanUrl !== 'string') return null;
    if (!/^https?:\/\//.test(b.hub.lanUrl) || (b.hub.remoteUrl && !/^https:\/\//.test(b.hub.remoteUrl))) return null;
    return {
      key: b.key,
      code: b.code,
      hub: { name: String(b.hub.name ?? 'Sightline Hub'), lanUrl: trim(b.hub.lanUrl), remoteUrl: trim(String(b.hub.remoteUrl ?? '')) },
    };
  } catch {
    return null;
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function errorFrom(res: Response): Promise<HubError> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  if (body.error === 'revoked' || body.error === 'expired' || (res.status === 401 && body.error === 'unauthorized'))
    return new HubError('This TV was removed from the Hub. Connect it again from your iPhone.', body.error, res.status);
  return new HubError(body.message ?? `The Hub returned HTTP ${res.status}`, body.error ?? '', res.status);
}

/** Redeems the invite the phone handed over; the TV gets its own token. */
export async function redeem(p: PairBody): Promise<TvConfig> {
  let last: unknown = null;
  for (const base of [p.hub.lanUrl, p.hub.remoteUrl].filter(Boolean)) {
    try {
      const res = await fetchWithTimeout(
        `${base}/v1/redeem`,
        { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ code: p.code }) },
        8000,
      );
      if (!res.ok) throw await errorFrom(res);
      const r = (await res.json()) as { token: string; hub?: { name?: string; lanUrl?: string; remoteUrl?: string } };
      return {
        token: r.token,
        hubName: r.hub?.name || p.hub.name,
        lanUrl: trim(r.hub?.lanUrl || p.hub.lanUrl),
        remoteUrl: trim(r.hub?.remoteUrl || p.hub.remoteUrl),
      };
    } catch (e) {
      last = e;
      if (e instanceof HubError && e.status) break; // the Hub answered (bad code etc.)
    }
  }
  if (last instanceof HubError) throw last;
  throw new HubError('The TV couldn’t reach the Hub. Is the TV on the same network as the Hub?');
}

/** The Hub's home address when the TV can reach it, else its public link. */
export async function pickBase(c: TvConfig): Promise<string> {
  const tries: [string, number][] = [[c.lanUrl, 2500]];
  if (c.remoteUrl && c.remoteUrl !== c.lanUrl) tries.push([c.remoteUrl, 8000]);
  let last: unknown = null;
  for (const [base, ms] of tries) {
    try {
      const res = await fetchWithTimeout(`${base}/v1/info`, { headers: { Authorization: `Bearer ${c.token}` } }, ms);
      if (!res.ok) throw await errorFrom(res);
      return base;
    } catch (e) {
      last = e;
      if (e instanceof HubError && e.status) throw e;
    }
  }
  throw last instanceof HubError ? last : new HubError(`Can’t reach ${c.hubName}. Check that the Hub is on.`);
}

export async function listCameras(base: string, token: string): Promise<HubCamera[]> {
  const res = await fetchWithTimeout(`${base}/v1/cameras`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }, 10000);
  if (!res.ok) throw await errorFrom(res);
  const cams = (await res.json()) as HubCamera[];
  return cams.filter((c) => c.enabled);
}

export const snapshotUrl = (base: string, token: string, id: string, height: number, t: number) =>
  `${base}/v1/cameras/${enc(id)}/snapshot.jpg?height=${height}&token=${enc(token)}&t=${t}`;

/** HLS live view (GET /v1/cameras/{id}/live.m3u8), played with AVPlayer. */
export const liveUrl = (base: string, token: string, id: string) => `${base}/v1/cameras/${enc(id)}/live.m3u8?token=${enc(token)}`;

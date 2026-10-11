/**
 * Apple TV sign-in (tv/ app): the TV shows a QR code `sightline://tv?h=<ip:port>&k=<key>&n=<name>`.
 * The phone creates a Hub invite for the TV and POSTs it to http://<ip:port>/pair on the home
 * network; the TV redeems it and gets its own token. No cloud server is involved. Kept pure
 * (no RN imports) so it's unit-tested.
 */

export interface TvLink {
  /** "192.168.1.40:49152" */
  host: string;
  key: string;
  name: string;
}

/** Only private IPv4 addresses: a QR code must not make the phone send an invite elsewhere. */
export function isPrivateHostPort(hostPort: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):(\d{1,5})$/.exec(hostPort);
  if (!m) return false;
  const [a, b, c, d, port] = m.slice(1).map(Number);
  if ([a, b, c, d].some((n) => n > 255) || port < 1 || port > 65535) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

export function parseTvLink(raw: string | { h?: string; k?: string; n?: string }): TvLink | null {
  let h: string | undefined;
  let k: string | undefined;
  let n: string | undefined;
  if (typeof raw === 'string') {
    const m = /^sightline:\/\/tv\/?\?(.*)$/i.exec(raw.trim());
    if (!m) return null;
    const q = new URLSearchParams(m[1]);
    h = q.get('h') ?? undefined;
    k = q.get('k') ?? undefined;
    n = q.get('n') ?? undefined;
  } else {
    ({ h, k, n } = raw);
  }
  if (!h || !k || !/^[A-Za-z0-9]{16,128}$/.test(k) || !isPrivateHostPort(h)) return null;
  return { host: h, key: k, name: (n ?? '').trim().slice(0, 40) || 'Apple TV' };
}

/** What the TV expects at POST /pair (tv/src/hub.ts parsePairBody). */
export function tvPairBody(link: TvLink, hub: { name: string; lanUrl: string; remoteUrl: string }, code: string): string {
  return JSON.stringify({ key: link.key, code, hub });
}

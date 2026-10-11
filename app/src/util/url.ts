/** Accepts "192.168.1.10", "nvr.lan:5000", or a full URL; defaults to https on 8971. */
export function normalizeUrl(input: string): string {
  let s = input.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(s)) {
    const hasPort = /:\d+$/.test(s);
    const port = hasPort ? Number(s.split(':').pop()) : 8971;
    s = `${port === 5000 || port === 80 ? 'http' : 'https'}://${s}${hasPort ? '' : ':8971'}`;
  }
  return s;
}

/** True when the user typed only a host/IP (no scheme, no port), so we should detect the port. */
export function isBareHost(input: string): boolean {
  const s = input.trim().replace(/\/+$/, '');
  return !/^https?:\/\//i.test(s) && !/:\d+$/.test(s);
}

/** Where Frigate usually listens, most likely first: authenticated UI, internal port, reverse proxies. */
export function frigateCandidates(host: string): string[] {
  const h = host.trim().replace(/\/+$/, '');
  return [`https://${h}:8971`, `http://${h}:5000`, `https://${h}:443`, `http://${h}:80`];
}

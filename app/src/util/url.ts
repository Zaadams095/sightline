/** Accepts "192.168.1.10", "nvr.lan:5000", or a full URL; defaults to https on 8971. */
export function normalizeUrl(input: string): string {
  let s = input.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(s)) {
    const hasPort = /:\d+$/.test(s);
    const port = hasPort ? Number(s.split(':').pop()) : 8971;
    s = `${port === 5000 ? 'http' : 'https'}://${s}${hasPort ? '' : ':8971'}`;
  }
  return s;
}

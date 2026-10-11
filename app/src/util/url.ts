/** Adds http:// to a bare address ("192.168.1.10", "nvr.lan:8080"); full URLs pass through. */
export function normalizeUrl(input: string): string {
  const s = input.trim().replace(/\/+$/, '');
  if (/^https?:\/\//i.test(s)) return s;
  const port = Number(s.match(/:(\d+)$/)?.[1] ?? 0);
  return `${port === 443 || port === 8443 ? 'https' : 'http'}://${s}`;
}

/**
 * A port that usually serves HTTPS may be running plain HTTP (e.g. TLS turned off), and any
 * port could be either. Ask the server: if an HTTPS request is answered in plain HTTP,
 * switch the URL to http://. `check` returns "HTTP <status>" or the error text.
 */
export async function resolveScheme(url: string, check: (url: string) => Promise<string>): Promise<string> {
  if (!url.startsWith('https://')) return url;
  const res = await check(`${url}/`);
  return /HTTP response to HTTPS client/i.test(res) ? url.replace(/^https:/, 'http:') : url;
}

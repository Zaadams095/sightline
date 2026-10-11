import { tr } from '../i18n/index.ts';

/**
 * Turns low-level network errors (Go dial errors, fetch failures) into plain sentences a
 * non-technical person can act on. The raw text stays available for Diagnostics.
 */
export function friendlyNetError(raw: string, name: string): string {
  const e = raw.toLowerCase();
  const t = tr().alerts.errors;
  if (e.includes('connection refused')) {
    return t.refused(name);
  }
  if (e.includes('no such host') || e.includes('server misbehaving')) {
    return t.noSuchHost;
  }
  if (
    e.includes('timeout') ||
    e.includes('timed out') ||
    e.includes('no route to host') ||
    e.includes('host is down') ||
    e.includes('network is unreachable') ||
    e.includes('no response')
  ) {
    return t.notFound(name);
  }
  if (e.includes('certificate') || e.includes('tls') || e.includes('x509')) {
    return t.tls(name);
  }
  if (e.includes('tunnel is not running') || e.includes('no vpn configuration')) {
    return t.noAway;
  }
  return t.generic(name);
}

/** Go/fetch/HTTP wording that means the text came from a library, not from us. */
const TECHNICAL =
  /\b(dial|tcp|udp|eof|errno|econn\w*|x509|tls|i\/o|status code|http \d{3}|network request failed|unexpected token|json|undefined|null|nsurlerror\w*)\b|:\d{2,5}\b|0x[0-9a-f]+/i;

/**
 * The message to show for an error during setup or a reconnect: adapters already throw plain
 * sentences (wrong password, wrong address…), which pass through; anything that reads like a
 * raw network or HTTP error is translated by friendlyNetError.
 */
export function userMessage(e: unknown, name: string): string {
  const raw = e instanceof Error ? e.message : String(e);
  return !raw.trim() || TECHNICAL.test(raw) || /refused|no such host|timed? ?out|unreachable|certificate/i.test(raw)
    ? friendlyNetError(raw, name)
    : raw;
}

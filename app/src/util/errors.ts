/**
 * Turns low-level network errors (Go dial errors, fetch failures) into plain sentences a
 * non-technical person can act on. The raw text stays available for Diagnostics.
 */
export function friendlyNetError(raw: string, name: string): string {
  const e = raw.toLowerCase();
  if (e.includes('connection refused')) {
    return `${name} is on the network but didn’t accept the connection at that address. Check the address (and port) in its app or on the device.`;
  }
  if (e.includes('no such host') || e.includes('server misbehaving')) {
    return `Couldn’t find an address called that. Check it for typos.`;
  }
  if (
    e.includes('timeout') ||
    e.includes('timed out') ||
    e.includes('no route to host') ||
    e.includes('host is down') ||
    e.includes('network is unreachable') ||
    e.includes('no response')
  ) {
    return `Couldn’t find ${name} on this network. Make sure your phone is on your home Wi-Fi and ${name} is turned on.`;
  }
  if (e.includes('certificate') || e.includes('tls') || e.includes('x509')) {
    return `${name} answered, but its secure connection couldn’t be set up. Try the address with http:// in front.`;
  }
  if (e.includes('tunnel is not running') || e.includes('no vpn configuration')) {
    return `You’re away from home, and no away-from-home connection is set up yet (Settings → Away from home).`;
  }
  return `Couldn’t connect to ${name}.`;
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

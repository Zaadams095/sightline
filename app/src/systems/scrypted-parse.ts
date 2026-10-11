import { tr } from '../i18n/index.ts';

/**
 * Pure parsing for Scrypted camera links. Scrypted's Rebroadcast extension shows, per camera
 * stream, an "RTSP Rebroadcast Url" like `rtsp://localhost:34567/a1b2c3d4e5f6a7b8`
 * (plugins/prebuffer-mixin, "Substitute localhost as appropriate"). The path is a random
 * token that stays the same across restarts; knowing it is the only access control.
 */

export interface ScryptedLink {
  id: string;
  name: string;
  url: string;
}

const LOCAL = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/i;

/**
 * Reads pasted links: separated by spaces, commas or new lines; optionally named with
 * `Name=rtsp://…`. `localhost` is replaced with the Scrypted server's host. Returns the
 * links plus anything that couldn't be read, for a clear error.
 */
export function parseLinks(text: string, serverHost: string): { links: ScryptedLink[]; bad: string[] } {
  const links: ScryptedLink[] = [];
  const bad: string[] = [];
  // Names may contain spaces ("Front door=rtsp://…"), so match links rather than split on spaces.
  const re = /(?:([^\s=,;][^=,;\n]*?)\s*=\s*)?(rtsps?:\/\/[^\s,;]+)/gi;
  const leftover = text.replace(re, ' ').split(/[\s,;]+/).filter(Boolean);
  bad.push(...leftover);
  for (const m of text.matchAll(re)) {
    // String parsing, not URL setters (React Native's URL is read-only in places).
    const u = /^(rtsps?):\/\/(?:([^@/]*)@)?(\[[^\]]+\]|[^/:@]+)(?::(\d+))?(\/[^?#]*)?(.*)$/i.exec(m[2]);
    if (!u) {
      bad.push(m[0]);
      continue;
    }
    const [, scheme, creds, host0, port, path = '/', rest] = u;
    const host = LOCAL.test(host0) && serverHost ? serverHost : host0;
    const fixed = `${scheme.toLowerCase()}://${creds ? `${creds}@` : ''}${host}${port ? `:${port}` : ''}${path}${rest}`;
    const token = path.replace(/^\//, '').replace(/[^A-Za-z0-9]/g, '');
    const n = links.length + 1;
    let id = token || `cam${n}`;
    while (links.some((l) => l.id === id)) id = `${id}-${n}`;
    links.push({ id, name: m[1]?.trim() || tr().systems.common.cameraN(n), url: fixed });
  }
  return { links, bad };
}

/** `POST /login` answers 200 even on failure, with `{error}` (server/src/scrypted-server-main.ts). */
export function loginError(body: { error?: string; authorization?: string } | null): string | null {
  if (!body) return tr().systems.http.unexpectedReplyShort('Scrypted');
  if (body.error) {
    return /password|user/i.test(body.error)
      ? tr().systems.http.badLoginShort('Scrypted')
      : tr().systems.http.said('Scrypted', body.error);
  }
  return null;
}

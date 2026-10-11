import type { AlertZones } from '@/alerts/zones';
import type { AlertMasks, AlertSettings, CameraGroup, CameraMap, GridView, SavedClip } from '@/state/store';
import type { SystemConfig } from '@/systems/types';
import type { Appearance } from '@/theme/tokens';

/**
 * What a backup contains, and how two phones' copies are reconciled. Pure (no RN imports) so
 * it's covered by `npm test`. Used by both the iCloud backup and the phone-to-phone transfer.
 *
 * Included: systems (no passwords), camera order/groups/grid layouts, alert rules, Home/Away,
 * activity zones, map layout, appearance, saved-clip bookmarks.
 * Never included: video files (offline downloads, the map's background picture), per-device
 * state (push registration marks, snoozes, "at home" right now, app lock, notification
 * bookkeeping). Passwords travel separately: iCloud Keychain, or inside the encrypted transfer.
 */

export const SECTIONS = ['systems', 'layout', 'alerts', 'zones', 'map', 'appearance', 'clips'] as const;
export type SectionName = (typeof SECTIONS)[number];
export type Sections = Partial<Record<SectionName, unknown>>;

/** The parts of the app state a backup is made from (structurally the persisted store). */
export interface BackupSource {
  systems: SystemConfig[];
  appearance: Appearance;
  phoneOrder: string[];
  hidden: string[];
  gridViews: GridView[];
  cameraGroups: CameraGroup[];
  alerts: AlertSettings;
  cameraMap: CameraMap;
  alertZones: AlertZones;
  savedClips: SavedClip[];
}

/** System `extra` keys that describe this phone, not the system. */
const PER_DEVICE_EXTRA = ['push'];

/** Built-in sample cameras ("demo" systems) aren't the user's and aren't backed up. */
const DEVICE_ONLY_KINDS = new Set<string>(['demo']);

function omit<T extends object>(obj: T, keys: readonly string[]): T {
  const out = { ...obj } as Record<string, unknown>;
  for (const k of keys) delete out[k];
  return out as T;
}

export function stripSystem(s: SystemConfig): SystemConfig {
  const out: SystemConfig = { ...s };
  if (s.extra) {
    const extra = omit(s.extra, PER_DEVICE_EXTRA);
    if (Object.keys(extra).length) out.extra = extra;
    else delete out.extra;
  }
  // Stream links can carry the camera's password (rtsp://user:pass@…): never in settings backups.
  if (s.manualCameras) {
    out.manualCameras = s.manualCameras.map((c) => ({
      ...c,
      rtspUrl: stripUrlCredentials(c.rtspUrl).clean,
      ...(c.snapshotUrl ? { snapshotUrl: stripUrlCredentials(c.snapshotUrl).clean } : {}),
    }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Credentials inside camera links

/** Query parameters that carry a password or key (e.g. Reolink's `?password=`). */
const SECRET_PARAM = /^(password|passwd|pass|pwd|psw|token|auth|key|apikey|api_key)$/i;

/**
 * Removes the user:password@ part and password-like query parameters from a camera link.
 * Works on any scheme (rtsp, rtsps, http…) without the URL class (Hermes' is incomplete),
 * and copes with an unescaped "@" in the password.
 */
export function stripUrlCredentials(url: string): { clean: string; hadCredentials: boolean } {
  const m = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)(.*)$/s.exec(url ?? '');
  if (!m) return { clean: url, hadCredentials: false };
  const [, scheme, rest] = m;
  let body = rest;
  let had = false;
  // An "@" followed by a plausible host[:port] and then the end, "/", "?" or "#". Passwords
  // may contain "@" and "/", paths may contain "@", so prefer the last one whose host looks
  // like a real address (dots, a port or [IPv6]); otherwise the first plausible one.
  let first = -1;
  let best = -1;
  for (let at = rest.indexOf('@'); at >= 0; at = rest.indexOf('@', at + 1)) {
    const after = rest.slice(at + 1);
    const host = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(:\d+)?/.exec(after);
    if (!host || (after.length !== host[0].length && !'/?#'.includes(after[host[0].length]))) continue;
    // Without a clear host, only an "@" before the first "/" (else "/live@ch1" is a path).
    if (first < 0 && !rest.slice(0, at).includes('/')) first = at;
    if (host[0].includes('.') || host[0].includes(':') || host[0].startsWith('[') || host[0].toLowerCase() === 'localhost') best = at;
  }
  const at = best >= 0 ? best : first;
  if (at >= 0) {
    body = rest.slice(at + 1);
    had = true;
  }
  const q = body.indexOf('?');
  if (q >= 0) {
    const hash = body.indexOf('#', q);
    const query = body.slice(q + 1, hash >= 0 ? hash : undefined);
    const kept = query.split('&').filter((kv) => {
      const secret = SECRET_PARAM.test(decodeURIComponentSafe(kv.split('=')[0]));
      if (secret) had = true;
      return kv && !secret;
    });
    body = body.slice(0, q) + (kept.length ? `?${kept.join('&')}` : '') + (hash >= 0 ? body.slice(hash) : '');
  }
  return { clean: scheme + body, hadCredentials: had };
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Puts the saved credentials back: `original` is the full link, used if it's still the same link. */
export function restoreUrlCredentials(clean: string, original: string | null | undefined): string {
  if (!original) return clean;
  return stripUrlCredentials(original).clean === clean ? original : clean;
}

/** Secret name for a stream-link camera's full link (with its password). */
export const streamSecretName = (cameraId: string, which: 'rtsp' | 'snap') => `cam.${cameraId}.${which}`;

export function extractSections(st: BackupSource): Required<Sections> {
  const alerts = omit(st.alerts, ['snoozed']) as Partial<AlertSettings>;
  return {
    systems: st.systems.filter((s) => !DEVICE_ONLY_KINDS.has(s.kind)).map(stripSystem),
    // Which group/grid is selected right now is left out: it changes with every tap.
    layout: {
      phoneOrder: st.phoneOrder,
      hidden: st.hidden,
      gridViews: st.gridViews,
      cameraGroups: st.cameraGroups,
    },
    alerts: { ...alerts, presence: omit(st.alerts.presence, ['atHome']) },
    zones: st.alertZones,
    map: omit(st.cameraMap, ['background']),
    appearance: st.appearance,
    clips: st.savedClips.map((c) => omit(c, ['localUri'])),
  };
}

/** Sections only found in backups from older app versions. */
export interface LegacySections {
  /** Before activity zones: per-camera "ignored area" polygons. */
  masks?: unknown;
}
export const LEGACY_SECTIONS = ['masks'] as const;

/** alerts/zones.ts `migrateMasks`, passed in so this file stays import-free for tests. */
export type MigrateMasks = (masks: AlertMasks | undefined, zones: AlertZones | undefined) => AlertZones;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * A store patch that applies a backup on top of `current`. Per-device values (snoozes, "at
 * home", the map picture, offline copies) keep this phone's values. Malformed sections are
 * skipped rather than trusted.
 */
export function applySections(
  sections: Sections & LegacySections,
  current: BackupSource,
  migrateMasks: MigrateMasks,
): Partial<BackupSource> {
  const patch: Partial<BackupSource> = {};
  const { systems, layout, alerts, zones, masks, map, appearance, clips } = sections;

  if (Array.isArray(systems)) {
    patch.systems = (systems as SystemConfig[]).filter((s) => isObj(s) && typeof s.id === 'string' && typeof s.kind === 'string').map(stripSystem);
  }
  if (isObj(layout)) {
    const l = layout as Partial<BackupSource>;
    if (Array.isArray(l.phoneOrder)) patch.phoneOrder = l.phoneOrder;
    if (Array.isArray(l.hidden)) patch.hidden = l.hidden;
    if (Array.isArray(l.gridViews)) patch.gridViews = l.gridViews;
    if (Array.isArray(l.cameraGroups)) patch.cameraGroups = l.cameraGroups;
  }
  // Backups made before activity zones carry `masks` ("ignored areas"): convert them.
  if (isObj(zones) || isObj(masks)) {
    patch.alertZones = migrateMasks(isObj(masks) ? (masks as AlertMasks) : undefined, isObj(zones) ? (zones as AlertZones) : undefined);
  }
  if (isObj(alerts)) {
    const a = alerts as Partial<AlertSettings>;
    patch.alerts = {
      ...current.alerts,
      ...a,
      snoozed: current.alerts.snoozed,
      presence: { ...current.alerts.presence, ...(isObj(a.presence) ? a.presence : {}), atHome: current.alerts.presence.atHome },
    };
  }
  if (isObj(map)) patch.cameraMap = { ...current.cameraMap, ...(map as Partial<CameraMap>), background: current.cameraMap.background };
  if (isObj(appearance)) patch.appearance = { ...current.appearance, ...(appearance as Partial<Appearance>) };
  if (Array.isArray(clips)) {
    const local = new Map(current.savedClips.map((c) => [c.id, c]));
    patch.savedClips = (clips as SavedClip[])
      .filter((c) => isObj(c) && typeof c.id === 'string')
      .map((c) => {
        const mine = local.get(c.id)?.localUri;
        return mine ? { ...omit(c, ['localUri']), localUri: mine } : omit(c, ['localUri']);
      });
  }
  return patch;
}

// ---------------------------------------------------------------------------
// Secrets

export interface SecretRef {
  scope: string;
  name: string;
}

export interface SecretValue extends SecretRef {
  value: string;
}

/** Keychain account for a secret (same naming the app has always used). */
export const secretKey = (scope: string, name: string) => `${scope}.${name}`.replace(/[^A-Za-z0-9._-]/g, '_');

/** Scopes that never leave this phone: the app-lock PIN is per device. */
const DEVICE_ONLY_SCOPES = new Set(['applock']);

export const isSyncableSecret = (scope: string) => !DEVICE_ONLY_SCOPES.has(scope);

/**
 * Every secret a backup should carry: each system's password and Hub token, stream-link
 * cameras' full links (they hold the camera password), the VPN (WireGuard) config with its
 * private key, and the Instant Alerts bridge secret.
 */
export function secretRefs(systems: Pick<SystemConfig, 'id' | 'manualCameras'>[]): SecretRef[] {
  const refs: SecretRef[] = [];
  for (const s of systems) {
    refs.push({ scope: s.id, name: 'password' }, { scope: s.id, name: 'token' });
    for (const c of s.manualCameras ?? []) {
      refs.push({ scope: s.id, name: streamSecretName(c.id, 'rtsp') }, { scope: s.id, name: streamSecretName(c.id, 'snap') });
    }
  }
  refs.push({ scope: 'tunnel', name: 'wg.conf' }, { scope: 'bridge', name: 'secret' });
  return refs.filter((r) => isSyncableSecret(r.scope));
}

// ---------------------------------------------------------------------------
// Summary ("3 systems, 14 cameras")

/** Cameras the backup knows about: every camera key mentioned anywhere, for the listed systems. */
export function countCameras(sections: Sections): number {
  const systems = Array.isArray(sections.systems) ? (sections.systems as SystemConfig[]) : [];
  const ids = new Set(systems.map((s) => s.id));
  const keys = new Set<string>();
  const add = (k: unknown) => {
    if (typeof k !== 'string') return;
    const i = k.indexOf(':');
    if (i > 0 && ids.has(k.slice(0, i))) keys.add(k);
  };
  for (const s of systems) for (const c of s.manualCameras ?? []) add(`${s.id}:${c.id}`);
  const l = (isObj(sections.layout) ? sections.layout : {}) as Partial<BackupSource>;
  l.phoneOrder?.forEach(add);
  l.hidden?.forEach(add);
  l.cameraGroups?.forEach((g) => g.cameraKeys?.forEach(add));
  l.gridViews?.forEach((v) => v.tiles?.forEach((t) => add(t.cameraKey)));
  const a = (isObj(sections.alerts) ? sections.alerts : {}) as Partial<AlertSettings>;
  Object.keys(a.rules ?? {}).forEach(add);
  a.presence?.alertWhenHome?.forEach(add);
  if (isObj(sections.zones)) Object.keys(sections.zones).forEach(add);
  const m = (isObj(sections.map) ? sections.map : {}) as Partial<CameraMap>;
  Object.keys(m.placements ?? {}).forEach(add);
  return keys.size;
}

export function summaryText(sections: Sections): string {
  const systems = Array.isArray(sections.systems) ? sections.systems.length : 0;
  const cameras = countCameras(sections);
  const sys = `${systems} ${systems === 1 ? 'system' : 'systems'}`;
  return cameras > 0 ? `${sys}, ${cameras} ${cameras === 1 ? 'camera' : 'cameras'}` : sys;
}

// ---------------------------------------------------------------------------
// Change detection and conflict policy

/** JSON with object keys sorted, so equal settings always hash the same. */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : stableStringify(x))).join(',')}]`;
  if (isObj(v)) {
    const parts = Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`);
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** FNV-1a over the stable JSON (change detection, not security). */
export function hashSection(v: unknown): string {
  const s = stableStringify(v);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${h.toString(16).padStart(8, '0')}-${s.length.toString(36)}`;
}

export interface SectionStamp {
  /** Unix ms of the edit this copy came from. */
  updatedAt: number;
  /** Random per-install id of the phone that made the edit. */
  device: string;
  hash: string;
}

/** Last-writer-wins: newer edit time wins; an exact tie goes to the larger device id. */
export function newer<T extends SectionStamp>(a: T | null | undefined, b: T | null | undefined): T | null {
  if (!a) return b ?? null;
  if (!b) return a;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  return a.device >= b.device ? a : b;
}

/** Per-section last-writer-wins merge of two copies. */
export function mergeSections<T extends SectionStamp>(
  a: Partial<Record<SectionName, T>>,
  b: Partial<Record<SectionName, T>>,
): Partial<Record<SectionName, T>> {
  const out: Partial<Record<SectionName, T>> = {};
  for (const s of SECTIONS) {
    const w = newer(a[s], b[s]);
    if (w) out[s] = w;
  }
  return out;
}

/** What this phone last uploaded (or adopted) per section. Kept on the phone, not in iCloud. */
export type UploadMeta = Partial<Record<SectionName, { hash: string; updatedAt: number }>>;

/**
 * Decides which sections this phone should write to iCloud.
 * - A section changed here since the last upload is stamped `now` and wins unless the cloud
 *   copy is newer still (another phone edited it later, or clocks disagree).
 * - Unchanged sections are only re-written if the cloud has no copy at all.
 * - A phone with no upload history never overwrites an existing, different cloud copy just by
 *   starting up: it adopts it as the baseline until the user actually changes that section.
 */
export function planUpload(
  localHashes: Record<SectionName, string>,
  meta: UploadMeta,
  remote: Partial<Record<SectionName, SectionStamp | null>>,
  now: number,
  device: string,
): { write: Partial<Record<SectionName, SectionStamp>>; meta: UploadMeta } {
  const write: Partial<Record<SectionName, SectionStamp>> = {};
  const next: UploadMeta = { ...meta };
  for (const s of SECTIONS) {
    const hash = localHashes[s];
    const m = meta[s];
    const r = remote[s] ?? null;
    if (r && r.hash === hash) {
      next[s] = { hash, updatedAt: r.updatedAt };
      continue;
    }
    if (!m) {
      if (r) {
        next[s] = { hash, updatedAt: 0 };
        continue;
      }
      write[s] = { updatedAt: now, device, hash };
      next[s] = { hash, updatedAt: now };
      continue;
    }
    const changed = m.hash !== hash;
    const mine: SectionStamp = { updatedAt: changed ? now : m.updatedAt, device, hash };
    if (!r) {
      write[s] = mine;
      next[s] = { hash, updatedAt: mine.updatedAt };
    } else if (changed && newer(mine, r) === mine) {
      write[s] = mine;
      next[s] = { hash, updatedAt: now };
    }
  }
  return { write, meta: next };
}

// ---------------------------------------------------------------------------
// iCloud key-value layout

export const KV_PREFIX = 'sl1.';
export const KV_SUMMARY = `${KV_PREFIX}summary`;
/** Apple's limit is 1 MB for the whole store; stay well under it. */
export const KV_BUDGET_BYTES = 900_000;
const CHUNK_CHARS = 60_000;

export const kvHeaderKey = (s: SectionName) => `${KV_PREFIX}${s}`;
export const kvPartKey = (s: SectionName, i: number) => `${KV_PREFIX}${s}.${i}`;

interface KvHeader extends SectionStamp {
  /** Number of parts; 0 = the data is inline in `v`. */
  n: number;
  v?: string;
}

/** Splits text into chunks without cutting a UTF-16 surrogate pair in half. */
export function chunkText(text: string, size = CHUNK_CHARS): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + size, text.length);
    const c = text.charCodeAt(end - 1);
    if (end < text.length && c >= 0xd800 && c <= 0xdbff) end--;
    out.push(text.slice(i, end));
    i = end;
  }
  return out;
}

/** Key/value pairs for one section. Parts are listed before the header (write them first). */
export function encodeSection(section: SectionName, stamp: SectionStamp, data: unknown, size = CHUNK_CHARS): [string, string][] {
  const json = JSON.stringify(data);
  const base = { updatedAt: stamp.updatedAt, device: stamp.device, hash: stamp.hash };
  if (json.length <= size) return [[kvHeaderKey(section), JSON.stringify({ ...base, n: 0, v: json } satisfies KvHeader)]];
  const parts = chunkText(json, size);
  return [
    ...parts.map((p, i) => [kvPartKey(section, i), p] as [string, string]),
    [kvHeaderKey(section), JSON.stringify({ ...base, n: parts.length } satisfies KvHeader)],
  ];
}

export function readHeader(section: SectionName, get: (k: string) => string | null | undefined): (KvHeader & SectionStamp) | null {
  try {
    const raw = get(kvHeaderKey(section));
    if (!raw) return null;
    const h = JSON.parse(raw) as KvHeader;
    if (typeof h.updatedAt !== 'number' || typeof h.hash !== 'string' || typeof h.n !== 'number') return null;
    return h;
  } catch {
    return null;
  }
}

/**
 * Reads one section back. Returns null when it's missing, still half-synced (a part hasn't
 * arrived yet) or doesn't match its hash.
 */
export function decodeSection(
  section: SectionName,
  get: (k: string) => string | null | undefined,
): { stamp: SectionStamp; data: unknown } | null {
  const h = readHeader(section, get);
  if (!h) return null;
  let json = h.v ?? '';
  if (h.n > 0) {
    const parts: string[] = [];
    for (let i = 0; i < h.n; i++) {
      const p = get(kvPartKey(section, i));
      if (p == null) return null;
      parts.push(p);
    }
    json = parts.join('');
  }
  try {
    const data = JSON.parse(json) as unknown;
    if (hashSection(data) !== h.hash) return null;
    return { stamp: { updatedAt: h.updatedAt, device: h.device, hash: h.hash }, data };
  } catch {
    return null;
  }
}

/** Part keys left over from a bigger earlier copy of the section. */
export function staleParts(section: SectionName, oldParts: number, newPairs: [string, string][]): string[] {
  const keep = new Set(newPairs.map(([k]) => k));
  const out: string[] = [];
  for (let i = 0; i < oldParts; i++) if (!keep.has(kvPartKey(section, i))) out.push(kvPartKey(section, i));
  return out;
}

/** UTF-8 size of a string. */
export function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/**
 * Keeps the backup inside iCloud's key-value limit: if it's too big, the oldest saved-clip
 * bookmarks are left out first (the only part that grows without bound).
 */
export function fitToBudget(sections: Required<Sections>, budget = KV_BUDGET_BYTES): { sections: Required<Sections>; trimmedClips: number; fits: boolean } {
  const size = (s: Required<Sections>) => SECTIONS.reduce((n, k) => n + utf8Bytes(JSON.stringify(s[k])) + 200, 0);
  if (size(sections) <= budget) return { sections, trimmedClips: 0, fits: true };
  const clips = [...((sections.clips as SavedClip[]) ?? [])].sort((a, b) => b.savedAt - a.savedAt);
  let keep = clips.length;
  let out = sections;
  while (keep > 0) {
    keep = Math.floor(keep / 2);
    out = { ...sections, clips: clips.slice(0, keep) };
    if (size(out) <= budget) break;
  }
  return { sections: out, trimmedClips: clips.length - keep, fits: size(out) <= budget };
}

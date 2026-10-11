import type { HealthReport, PtzAction } from './types';

/**
 * Pure mapping for the Blue Iris JSON interface (`POST /json`). References: the Blue Iris
 * help file, "JSON interface" (https://blueirissoftware.com/blueiris.pdf, BI5/BI6) and UI3,
 * the official HTML5 client (github.com/bp2008/ui3, ui3.js).
 */

/** Second login step: `response = md5("user:session:password")` (lowercase hex). */
export const loginChallenge = (user: string, session: string, pass: string) => `${user}:${session}:${pass}`;

export interface BiReply<T = unknown> {
  result?: 'success' | 'fail' | string;
  session?: string;
  data?: T & { reason?: string };
}

/** Plain-language reason for a failed reply. "missing response" is the normal first login step. */
export function failReason(r: BiReply): string {
  const reason = (r.data as { reason?: string } | undefined)?.reason ?? '';
  if (/invalid session/i.test(reason)) return 'session';
  if (/user|password|login|credential/i.test(reason)) {
    return 'Blue Iris didn’t accept the username or password. Check them in Blue Iris → Settings → Users.';
  }
  return reason ? `Blue Iris said: ${reason}` : 'Blue Iris refused the request.';
}

export interface BiCamEntry {
  optionDisplay?: string;
  optionValue?: string;
  group?: string[];
  isEnabled?: boolean;
  isOnline?: boolean;
  isNoSignal?: boolean;
  hidden?: boolean;
  ptz?: boolean;
  width?: number;
  height?: number;
}

export interface BiCamera {
  id: string;
  name: string;
  enabled: boolean;
  offline: boolean;
  ptz: boolean;
  aspect: number;
}

/**
 * camlist mixes cameras with groups and cycles. Per UI3: a group has a `group` array (the
 * "All cameras" group is short name `index`), an auto-cycle's short name starts with `@`.
 */
export function parseCamList(data: BiCamEntry[] | undefined): BiCamera[] {
  return (data ?? [])
    .filter((c) => c.optionValue && !c.group && !c.optionValue.startsWith('@') && c.optionValue.toLowerCase() !== 'index')
    .filter((c) => !c.hidden)
    .map((c) => ({
      id: c.optionValue!,
      name: c.optionDisplay?.trim() || c.optionValue!,
      enabled: c.isEnabled !== false,
      // UI3: enabled && (!isOnline || isNoSignal) is shown as offline / no signal.
      offline: c.isEnabled !== false && (c.isOnline === false || c.isNoSignal === true),
      ptz: !!c.ptz,
      aspect: c.width && c.height ? c.width / c.height : 16 / 9,
    }));
}

/** Database flags (UI3 `BIDBFLAG`). */
export const FLAG = {
  CANCELLED: 1 << 23,
  AI_PERSON: 1 << 26,
  AI_VEHICLE: 1 << 27,
  AI_CONFIRMED: 1 << 28,
  OFFSET_TIME: 1 << 16,
} as const;

export interface BiAlert {
  camera?: string;
  path?: string;
  clip?: string;
  offset?: number;
  msec?: number;
  flags?: number;
  zones?: number;
  date?: number;
  memo?: string;
  filesize?: string;
}

export interface Alert {
  id: string;
  cameraId: string;
  start: number;
  end: number;
  objects: string[];
  zones: string[];
  confirmed: boolean;
  cancelled: boolean;
  /** `@rec` for /thumbs/ (path without extension). */
  thumb: string;
  clip?: string;
  offsetMs: number;
}

/** "0:15 (1.2MB)" or "1:02:03" → seconds. */
export function parseDuration(s: string | undefined): number {
  const m = /(\d+(?::\d{1,2}){1,2})/.exec(s ?? '');
  if (!m) return 0;
  return m[1].split(':').reduce((acc, x) => acc * 60 + Number(x), 0);
}

const LABEL_ALIASES: Record<string, string> = { people: 'person', vehicle: 'car', vehicles: 'car' };

/** AI memo like "person:87%,car:65%" (or "nothing found" when cancelled) → labels. */
export function memoLabels(memo: string | undefined): string[] {
  if (!memo || /nothing found|cancel/i.test(memo)) return [];
  const out = memo
    .split(/[,;]+/)
    .map((s) => s.trim().replace(/[:\s]*\d+(\.\d+)?%?$/, '').trim().toLowerCase())
    .filter((s) => s && s.length < 40 && !s.includes('@'))
    .map((s) => LABEL_ALIASES[s] ?? s);
  return [...new Set(out)];
}

/** Zone bitmask (A = 1 … H = 128) → names. */
export function zoneNames(mask: number | undefined): string[] {
  const out: string[] = [];
  for (let i = 0; i < 8; i++) if ((mask ?? 0) & (1 << i)) out.push(`Zone ${String.fromCharCode(65 + i)}`);
  return out;
}

const stripExt = (p: string) => p.replace(/\.[^.@/]+$/, '');

export function parseAlerts(data: BiAlert[] | undefined): Alert[] {
  return (data ?? [])
    .filter((a) => a.camera && a.path && typeof a.date === 'number')
    .map((a) => {
      const flags = a.flags ?? 0;
      const objects = memoLabels(a.memo);
      if (flags & FLAG.AI_PERSON && !objects.includes('person')) objects.push('person');
      if (flags & FLAG.AI_VEHICLE && !objects.includes('car')) objects.push('car');
      const dur = (a.msec ?? 0) / 1000 || parseDuration(a.filesize) || 10;
      // A clip of "@-1.…" means a snapshot alert with no video (UI3).
      const clip = a.clip && !a.clip.startsWith('@-1.') ? a.clip : undefined;
      return {
        id: stripExt(a.path!),
        cameraId: a.camera!,
        start: a.date!,
        end: a.date! + dur,
        objects,
        zones: zoneNames(a.zones),
        confirmed: !!(flags & FLAG.AI_CONFIRMED) || objects.length > 0,
        cancelled: !!(flags & FLAG.CANCELLED),
        thumb: stripExt(a.path!),
        clip,
        offsetMs: flags & FLAG.OFFSET_TIME ? (a.offset ?? 0) : 0,
      };
    });
}

export interface BiClip {
  camera?: string;
  path?: string;
  date?: number;
  msec?: number;
  filesize?: string;
}

export interface Clip {
  cameraId: string;
  path: string;
  start: number;
  end: number;
}

export function parseClips(data: BiClip[] | undefined): Clip[] {
  return (data ?? [])
    .filter((c) => c.path && typeof c.date === 'number' && c.filesize !== 'Snapshot')
    .map((c) => ({
      cameraId: c.camera ?? '',
      path: c.path!,
      start: c.date!,
      end: c.date! + ((c.msec ?? 0) / 1000 || parseDuration(c.filesize)),
    }))
    .filter((c) => c.end > c.start);
}

/** PTZ buttons (help file "ptz" command): 0–3 move, 4 home, 5/6 zoom, 64 stop. */
export const PTZ_BUTTON: Record<PtzAction, number> = {
  MOVE_LEFT: 0,
  MOVE_RIGHT: 1,
  MOVE_UP: 2,
  MOVE_DOWN: 3,
  ZOOM_IN: 5,
  ZOOM_OUT: 6,
  STOP: 64,
};
export const PTZ_HOME = 4;

/** `status` disk usage (UI3 reads `disks`, the help says `discs`), in MiB. */
export function parseDisks(data: {
  disks?: { disk?: string; used?: number; free?: number; total?: number; allocated?: number }[];
  discs?: { disk?: string; used?: number; free?: number; total?: number; allocated?: number }[];
}): HealthReport['storage'] {
  return (data.disks ?? data.discs ?? [])
    .filter((d) => (d.total ?? 0) > 0)
    .map((d) => ({
      path: d.disk ?? '',
      usedPct: Math.round(((d.total! - (d.free ?? 0)) / d.total!) * 100),
      freeGb: Math.round(((d.free ?? 0) / 1024) * 10) / 10,
    }));
}

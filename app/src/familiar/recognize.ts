import * as Crypto from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';

import {
  bestMatch,
  decodePrint,
  matchOptions,
  mergeNames,
  pickPlate,
  platesMatch,
  pruneSamples,
  type FamiliarKind,
} from '@/familiar/match';
import {
  FAMILIAR_CROPS_DIR,
  MAX_SAMPLES_PER_IDENTITY,
  useFamiliar,
  type FamiliarIdentity,
  type FamiliarSample,
  type ProcessedEntry,
  type Sighting,
} from '@/familiar/store';
import { objectKind } from '@/stories/group';
import type { MediaSource, ReviewItem } from '@/systems/types';
import { AppGroup } from '@modules/app-group';
import { SightlineVision, type VisionDetection } from '@modules/vision';

/**
 * On-device recognition of familiar faces & vehicles for every brand. Event pictures are
 * downloaded from the user's own recorder to this iPhone, analyzed by Apple Vision
 * (modules/vision) and matched against what the user named. Nothing is uploaded.
 */

export const familiarSupported = (): boolean => !!SightlineVision;

const DOWNLOAD_TIMEOUT_MS = 8000;
/** In-progress events this fresh can use a live snapshot when there's no event picture. */
const SNAPSHOT_FRESH_SEC = 90;

const keyOf = (item: { systemId: string; id: string }) => `${item.systemId}:${item.id}`;

function cropsDir(): Directory {
  return new Directory(Paths.document, FAMILIAR_CROPS_DIR);
}

/** Which kinds of recognition an event deserves (motion-only brands: faces only). */
export function candidateKinds(item: { objects: string[] }): { faces: boolean; vehicles: boolean } {
  const kinds = new Set(item.objects.map(objectKind));
  const vague = !kinds.has('person') && !kinds.has('vehicle') && !kinds.has('animal');
  return { faces: kinds.has('person') || vague, vehicles: kinds.has('vehicle') };
}

/** Names of identities, resolved now (renames apply to old events too). */
export function namesForIds(ids: string[], identities: FamiliarIdentity[]): string[] {
  return ids
    .map((id) => identities.find((i) => i.id === id))
    .filter((i): i is FamiliarIdentity => !!i && !i.ignored && !!i.name)
    .map((i) => i.name);
}

/** Adds on-device names to events already looked at (no work, no network). */
export function withFamiliarNames<T extends ReviewItem>(items: T[]): T[] {
  const { processed, identities, settings } = useFamiliar.getState();
  if (!settings.enabled || !identities.length) return items;
  return items.map((item) => {
    const entry = processed[keyOf(item)];
    if (!entry?.ids.length) return item;
    const names = namesForIds(entry.ids, identities);
    return names.length ? { ...item, subLabels: mergeNames(item.subLabels, names) } : item;
  });
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function download(src: MediaSource, name: string): Promise<File | null> {
  if (!/^https?:\/\//i.test(src.uri) && !src.uri.startsWith('file://')) return null;
  if (src.uri.startsWith('file://')) return new File(src.uri);
  try {
    return await withTimeout(
      File.downloadFileAsync(src.uri, new File(Paths.cache, `familiar-${name}.img`), { headers: src.headers, idempotent: true }),
      DOWNLOAD_TIMEOUT_MS,
    );
  } catch {
    return null;
  }
}

function deleteQuietly(uri: string | undefined) {
  if (!uri) return;
  try {
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch {}
}

interface Classified {
  identity: FamiliarIdentity | null;
  score: number;
  plate?: string;
}

/** Who a detection is, among identities of its kind (ignored strangers included, so they stay quiet). */
export function classify(d: VisionDetection, kind: FamiliarKind, identities: FamiliarIdentity[], plate?: string | null): Classified {
  const pool = identities.filter((i) => i.kind === kind);
  if (plate) {
    const byPlate = pool.find((i) => i.plates.some((p) => platesMatch(p, plate)));
    if (byPlate) return { identity: byPlate, score: 1, plate };
  }
  const { strictness } = useFamiliar.getState().settings;
  const print = decodePrint(d.print);
  const m = bestMatch(
    print,
    pool.map((i) => ({ id: i.id, prints: i.samples.filter((s) => s.dim === d.dim).map((s) => decodePrint(s.print)) })).filter((c) => c.prints.length),
    matchOptions(kind, strictness),
  );
  return { identity: m ? (pool.find((i) => i.id === m.id) ?? null) : null, score: m?.score ?? 0, plate: plate ?? undefined };
}

function sampleFrom(d: VisionDetection, kind: FamiliarKind, item: ReviewItem | null, source: FamiliarSample['source'], plate?: string): FamiliarSample {
  return {
    id: Crypto.randomUUID(),
    kind,
    print: d.print,
    dim: d.dim,
    at: item ? Math.floor(item.startTime) : Math.floor(Date.now() / 1000),
    crop: d.crop,
    plate,
    source,
    systemId: item?.systemId,
    cameraId: item?.cameraId,
    reviewId: item?.id,
  };
}

/**
 * Looks at events not seen yet (newest first, at most `budget`), names who it recognizes,
 * queues unknown faces/vehicles for "Who is this?", and returns the items with on-device names
 * merged into subLabels so alert rules and titles treat them like the system's own names.
 * Events the system already named are skipped.
 */
export async function recognizeItems<T extends ReviewItem>(
  items: T[],
  opts: { budget?: number; snapshot?: (item: T) => MediaSource | null } = {},
): Promise<T[]> {
  if (!useFamiliar.persist.hasHydrated()) await useFamiliar.persist.rehydrate();
  const st = useFamiliar.getState();
  if (!st.settings.enabled || !SightlineVision) return withFamiliarNames(items);
  const vision = SightlineVision;
  const now = Date.now() / 1000;

  const todo = items
    .filter((i) => !st.processed[keyOf(i)] && !(i.subLabels?.length))
    .sort((a, b) => b.startTime - a.startTime)
    .slice(0, opts.budget ?? 10);
  if (!todo.length) return withFamiliarNames(items);

  const processed: Record<string, ProcessedEntry> = {};
  const sightings: Sighting[] = [];
  const unknown: FamiliarSample[] = [];
  const dir = cropsDir().uri;

  for (const item of todo) {
    const want = candidateKinds(item);
    const src: MediaSource | null = item.thumbnailUrl
      ? { uri: item.thumbnailUrl }
      : now - item.startTime < SNAPSHOT_FRESH_SEC
        ? (opts.snapshot?.(item) ?? null)
        : null;
    // Nothing to look at: try again next time only if the event is still going.
    if (!src) {
      if (item.endTime != null) processed[keyOf(item)] = { t: item.startTime, ids: [] };
      continue;
    }
    const file = await download(src, item.id.replace(/[^A-Za-z0-9_-]/g, '_'));
    if (!file) continue;
    try {
      const res = await vision.analyze(file.uri, { faces: want.faces, vehicles: want.vehicles, plates: st.settings.plates, cropDir: dir, maxFaces: 4 });
      const ids: string[] = [];
      const detections: { d: VisionDetection; kind: FamiliarKind }[] = [
        ...res.faces.map((d) => ({ d, kind: 'face' as const })),
        ...res.vehicles.map((d) => ({ d, kind: 'vehicle' as const })),
      ];
      for (const { d, kind } of detections) {
        const plate = kind === 'vehicle' && st.settings.plates ? pickPlate(d.texts ?? []) : null;
        const c = classify(d, kind, useFamiliar.getState().identities, plate);
        if (c.identity) {
          deleteQuietly(d.crop);
          if (c.identity.ignored) continue;
          ids.push(c.identity.id);
          sightings.push({ identityId: c.identity.id, at: item.startTime, systemId: item.systemId, cameraId: item.cameraId, reviewId: item.id, score: c.score });
        } else {
          unknown.push(sampleFrom(d, kind, item, 'event', plate ?? undefined));
        }
      }
      processed[keyOf(item)] = { t: item.startTime, ids: [...new Set(ids)] };
    } catch {
      // Unreadable picture: don't retry forever.
      processed[keyOf(item)] = { t: item.startTime, ids: [] };
    } finally {
      if (src.uri !== file.uri) deleteQuietly(file.uri);
    }
  }

  const s = useFamiliar.getState();
  s.markProcessed(processed);
  if (sightings.length) s.addSightings(sightings);
  if (unknown.length) setUnknownTrimmed([...s.unknown, ...unknown]);
  return withFamiliarNames(items);
}

/** Keeps the unknown pool bounded, deleting crops of the samples that fall off. */
function setUnknownTrimmed(all: FamiliarSample[]) {
  const sorted = [...all].sort((a, b) => a.at - b.at);
  const max = 300;
  for (const s of sorted.slice(0, Math.max(0, sorted.length - max))) deleteQuietly(s.crop);
  useFamiliar.getState().setUnknown(sorted.slice(-max));
}

/**
 * "Who is this?" → a name. Adds the cluster's samples to that person (created if new, merged
 * with an existing one of the same name and kind), and credits the events they came from.
 */
export function nameSamples(samples: FamiliarSample[], name: string): FamiliarIdentity | null {
  const clean = name.trim();
  if (!clean || !samples.length) return null;
  const kind = samples[0].kind;
  const st = useFamiliar.getState();
  const existing = st.identities.find((i) => !i.ignored && i.kind === kind && i.name.toLowerCase() === clean.toLowerCase());
  const identity: FamiliarIdentity = existing
    ? { ...existing }
    : { id: Crypto.randomUUID(), name: clean, kind, samples: [], plates: [], createdAt: Math.floor(Date.now() / 1000) };
  return addToIdentity(identity, samples);
}

/** "Stranger / don't track": remembered only so they're never asked about or named. */
export function ignoreSamples(samples: FamiliarSample[]): void {
  if (!samples.length) return;
  addToIdentity(
    { id: Crypto.randomUUID(), name: '', kind: samples[0].kind, samples: [], plates: [], createdAt: Math.floor(Date.now() / 1000), ignored: true },
    samples,
  );
}

function addToIdentity(identity: FamiliarIdentity, samples: FamiliarSample[]): FamiliarIdentity {
  const st = useFamiliar.getState();
  const merged = [...identity.samples, ...samples];
  const kept = pruneSamples(merged, MAX_SAMPLES_PER_IDENTITY);
  const keptIds = new Set(kept.map((s) => s.id));
  // Keep one crop per sighting for the sightings list; drop crops of pruned samples.
  for (const s of merged) if (!keptIds.has(s.id)) deleteQuietly(s.crop);
  const plates = [...new Set([...identity.plates, ...samples.map((s) => s.plate).filter((p): p is string => !!p)])];
  const next: FamiliarIdentity = { ...identity, samples: kept, plates };
  st.upsertIdentity(next);

  const ids = new Set(samples.map((s) => s.id));
  st.setUnknown(st.unknown.filter((u) => !ids.has(u.id)));
  if (!identity.ignored) {
    const fromEvents = samples.filter((s) => s.reviewId && s.systemId && s.cameraId);
    st.addSightings(
      fromEvents.map((s) => ({ identityId: next.id, at: s.at, systemId: s.systemId!, cameraId: s.cameraId!, reviewId: s.reviewId!, score: 1, crop: keptIds.has(s.id) ? s.crop : undefined })),
    );
    const credit: Record<string, ProcessedEntry> = {};
    for (const s of fromEvents) {
      const key = `${s.systemId}:${s.reviewId}`;
      const prev = useFamiliar.getState().processed[key];
      credit[key] = { t: prev?.t ?? s.at, ids: [...new Set([...(prev?.ids ?? []), next.id])] };
    }
    st.markProcessed(credit);
  }
  void syncGallery();
  return next;
}

export function renameIdentity(id: string, name: string) {
  const st = useFamiliar.getState();
  const i = st.identities.find((x) => x.id === id);
  if (!i || !name.trim()) return;
  st.upsertIdentity({ ...i, name: name.trim() });
  void syncGallery();
}

export function addPlate(id: string, plate: string) {
  const st = useFamiliar.getState();
  const i = st.identities.find((x) => x.id === id);
  const p = plate.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!i || p.length < 2) return;
  st.upsertIdentity({ ...i, plates: [...new Set([...i.plates, p])] });
  void syncGallery();
}

export function forgetIdentity(id: string) {
  const st = useFamiliar.getState();
  const i = st.identities.find((x) => x.id === id);
  for (const s of i?.samples ?? []) deleteQuietly(s.crop);
  for (const s of st.sightings) if (s.identityId === id) deleteQuietly(s.crop);
  st.removeIdentity(id);
  void syncGallery();
}

/** Deletes every print, crop and sighting. */
export function forgetEverything() {
  try {
    const d = cropsDir();
    if (d.exists) d.delete();
  } catch {}
  useFamiliar.getState().reset();
  void syncGallery();
}

/**
 * Faces (or the vehicle) in a photo the user picked, for enrolling someone without waiting
 * for a sighting. Returns the usable samples (largest face first) and how many were skipped.
 */
export async function samplesFromPhoto(uri: string, kind: FamiliarKind): Promise<{ samples: FamiliarSample[]; skipped: number }> {
  if (!SightlineVision) return { samples: [], skipped: 0 };
  const res = await SightlineVision.analyze(uri, {
    faces: kind === 'face',
    vehicles: kind === 'vehicle',
    plates: useFamiliar.getState().settings.plates,
    cropDir: cropsDir().uri,
    maxFaces: 6,
    minFacePx: 60,
  });
  const list = kind === 'face' ? res.faces : res.vehicles;
  return {
    samples: list.map((d) => sampleFrom(d, kind, null, 'photo', kind === 'vehicle' ? (pickPlate(d.texts ?? []) ?? undefined) : undefined)),
    skipped: res.skippedFaces,
  };
}

/**
 * Shares named faces/plates with the notification extension (App Group file
 * familiar/gallery.json) so Instant Alerts can say "Dad is at Front Door". On-device only.
 */
export async function syncGallery(): Promise<void> {
  if (!AppGroup) return;
  const { settings, identities } = useFamiliar.getState();
  const named = identities.filter((i) => !i.ignored && i.name);
  const o = matchOptions('face', settings.strictness);
  const gallery = {
    v: 1,
    enabled: settings.enabled && settings.instantTitles,
    threshold: o.threshold,
    margin: o.margin,
    minVotes: o.minVotes,
    faces: settings.enabled && settings.instantTitles
      ? named.filter((i) => i.kind === 'face').map((i) => ({ name: i.name, prints: i.samples.slice(-6).map((s) => s.print) }))
      : [],
    plates: settings.enabled && settings.instantTitles && settings.plates
      ? named.filter((i) => i.kind === 'vehicle' && i.plates.length).map((i) => ({ name: i.name, plates: i.plates }))
      : [],
  };
  try {
    await AppGroup.writeText('familiar/gallery.json', JSON.stringify(gallery));
  } catch {}
}

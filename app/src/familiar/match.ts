/**
 * Familiar faces & vehicles: the pure matching logic (no RN imports, unit-tested).
 *
 * Apple has no public face-recognition API. The native module (modules/vision) gives a
 * general-purpose image feature print (VNGenerateImageFeaturePrintRequest) of each upright,
 * frontal face crop / vehicle crop, L2-normalized, as base64 Float32. We compare those by
 * cosine similarity with conservative thresholds, a vote over several samples, and a margin
 * over the next-best person, preferring "don't know" over a wrong name. The same rules are
 * mirrored in Swift for the notification extension (targets/notification-service/FamiliarMatcher.swift).
 */

export type FamiliarKind = 'face' | 'vehicle';

/** Matching strictness; 'careful' is the default (fewer wrong names, more "Who is this?"). */
export type Strictness = 'careful' | 'relaxed';

export interface MatchOptions {
  /** Minimum cosine similarity for a sample to count as a vote. */
  threshold: number;
  /** Best person's score must beat the runner-up by this much. */
  margin: number;
  /** Votes needed (capped by how many samples the person has). */
  minVotes: number;
}

/**
 * Starting points, not measured accuracy: general feature prints of face crops put different
 * people closer together than a dedicated face model would, hence the high bar and the margin.
 */
export function matchOptions(kind: FamiliarKind, strictness: Strictness = 'careful'): MatchOptions {
  const base = kind === 'face' ? 0.9 : 0.92;
  return { threshold: strictness === 'relaxed' ? base - 0.04 : base, margin: 0.03, minVotes: 2 };
}

/** Similarity for grouping unknown sightings into one "Who is this?" card. */
export function clusterThreshold(kind: FamiliarKind): number {
  return kind === 'face' ? 0.88 : 0.9;
}

export function decodePrint(b64: string): Float32Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer, 0, Math.floor(bytes.length / 4));
}

export function encodePrint(v: Float32Array): string {
  const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** Cosine similarity; prints of different sizes (another Vision revision) never match. */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return -1;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return -1;
  return dot / Math.sqrt(na * nb);
}

export interface Candidate {
  id: string;
  prints: Float32Array[];
}

/**
 * A person's score is the mean of their best `minVotes` sample similarities; they qualify
 * only when that many samples clear the threshold. Returns null unless one person clearly wins.
 */
export function bestMatch(print: Float32Array, people: Candidate[], o: MatchOptions): { id: string; score: number } | null {
  const scored = people
    .map((p) => {
      const sims = p.prints.map((q) => cosine(print, q)).sort((a, b) => b - a);
      const need = Math.max(1, Math.min(o.minVotes, sims.length));
      const top = sims.slice(0, need);
      const score = top.length ? top.reduce((s, x) => s + x, 0) / top.length : -1;
      const votes = sims.filter((s) => s >= o.threshold).length;
      return { id: p.id, score, ok: votes >= need && score >= o.threshold };
    })
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best?.ok) return null;
  const second = scored[1];
  if (second && best.score - second.score < o.margin) return null;
  return { id: best.id, score: best.score };
}

/** Licence plate text as read on-device: upper-case letters and digits, 4–8 long, with a digit. */
export function normalizePlate(text: string): string | null {
  const t = text.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (t.length < 4 || t.length > 8) return null;
  if (!/[0-9]/.test(t)) return null;
  // Mostly-digit strings of 4 are usually clocks/house numbers, not plates.
  if (/^[0-9]{4}$/.test(t)) return null;
  return t;
}

/** The most plate-like string among recognized text candidates. */
export function pickPlate(texts: string[]): string | null {
  const plates = texts.map(normalizePlate).filter((p): p is string => !!p);
  plates.sort((a, b) => scorePlate(b) - scorePlate(a));
  return plates[0] ?? null;
}

function scorePlate(p: string): number {
  const letters = (p.match(/[A-Z]/g) ?? []).length;
  const digits = p.length - letters;
  return (letters > 0 && digits > 0 ? 10 : 0) + Math.min(p.length, 7);
}

/** Plates match exactly, or with one misread character when long enough. */
export function platesMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length !== b.length || a.length < 6) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
  return diff <= 1;
}

export interface UnknownSample {
  id: string;
  kind: FamiliarKind;
  print: string;
  at: number;
}

/**
 * Groups unknown sightings into "Who is this?" clusters: greedy, oldest first, each sample
 * joins the cluster whose centroid it's most similar to (above the cluster threshold).
 */
export function clusterUnknowns<S extends UnknownSample>(samples: S[]): S[][] {
  const clusters: { kind: FamiliarKind; members: S[]; centroid: Float32Array }[] = [];
  for (const s of [...samples].sort((a, b) => a.at - b.at)) {
    const v = decodePrint(s.print);
    let best: (typeof clusters)[number] | null = null;
    let bestSim = clusterThreshold(s.kind);
    for (const c of clusters) {
      if (c.kind !== s.kind) continue;
      const sim = cosine(v, c.centroid);
      if (sim >= bestSim) {
        best = c;
        bestSim = sim;
      }
    }
    if (best) {
      const n = best.members.length;
      const next = new Float32Array(best.centroid.length);
      for (let i = 0; i < next.length; i++) next[i] = (best.centroid[i] * n + v[i]) / (n + 1);
      best.centroid = next;
      best.members.push(s);
    } else {
      clusters.push({ kind: s.kind, members: [s], centroid: v });
    }
  }
  // Most-seen first; within a size, most recent first.
  return clusters
    .map((c) => c.members)
    .sort((a, b) => b.length - a.length || Math.max(...b.map((x) => x.at)) - Math.max(...a.map((x) => x.at)));
}

/** Keeps a person's sample list varied and bounded: drops the sample most similar to another. */
export function pruneSamples<S extends { print: string; at: number }>(samples: S[], max: number): S[] {
  const out = [...samples];
  while (out.length > max) {
    let worst = 0;
    let worstSim = -2;
    const vs = out.map((s) => decodePrint(s.print));
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const sim = cosine(vs[i], vs[j]);
        if (sim > worstSim) {
          worstSim = sim;
          // Of the closest pair, drop the older sample.
          worst = out[i].at <= out[j].at ? i : j;
        }
      }
    }
    out.splice(worst, 1);
  }
  return out;
}

/** Event names from the system plus on-device names, without duplicates. */
export function mergeNames(system: string[] | undefined, onDevice: string[] | undefined): string[] {
  return [...new Set([...(system ?? []), ...(onDevice ?? [])])];
}

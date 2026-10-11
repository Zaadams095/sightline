import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import type { FamiliarKind, Strictness } from '@/familiar/match';
import { familiarStorage } from '@/familiar/storage';

/**
 * Familiar faces & vehicles: everything recognition knows, kept on this iPhone only.
 *
 * Its own persisted store (key FAMILIAR_STORE_KEY), saved as its own file next to the crop
 * pictures (FAMILIAR_CROPS_DIR) in a folder kept out of iCloud and computer backups
 * (familiar/storage.ts): it holds face/vehicle feature prints (biometric-like data). Nothing
 * here is ever uploaded, and Sightline's own iCloud backup leaves it out too.
 */
export const FAMILIAR_STORE_KEY = 'familiar-faces-v1';
export const FAMILIAR_CROPS_DIR = 'familiar/crops';

export interface FamiliarSample {
  id: string;
  kind: FamiliarKind;
  /** L2-normalized feature print, base64 Float32. */
  print: string;
  dim: number;
  /** Unix seconds seen. */
  at: number;
  /** Local crop picture (file://). */
  crop?: string;
  plate?: string;
  source: 'event' | 'photo';
  systemId?: string;
  cameraId?: string;
  reviewId?: string;
}

export interface FamiliarIdentity {
  id: string;
  /** "Dad", "The dog walker", "Our car". Empty for ignored strangers. */
  name: string;
  kind: FamiliarKind;
  samples: FamiliarSample[];
  /** Known licence plates (vehicles), normalized. */
  plates: string[];
  createdAt: number;
  /** "Stranger / don't track": matches are dropped silently, never named. */
  ignored?: boolean;
}

export interface Sighting {
  identityId: string;
  at: number;
  systemId: string;
  cameraId: string;
  reviewId: string;
  score: number;
  crop?: string;
}

export interface FamiliarSettings {
  enabled: boolean;
  strictness: Strictness;
  /** Read licence plates in vehicle pictures. */
  plates: boolean;
  /** Let the notification extension name people on Instant Alerts. */
  instantTitles: boolean;
}

/** Identity ids (not names, so renaming carries over) recognized in one event. */
export interface ProcessedEntry {
  t: number;
  ids: string[];
}

export const MAX_SAMPLES_PER_IDENTITY = 12;
export const MAX_UNKNOWN = 300;
export const MAX_SIGHTINGS = 600;
export const MAX_PROCESSED = 4000;

interface FamiliarState {
  settings: FamiliarSettings;
  identities: FamiliarIdentity[];
  /** Unnamed sightings waiting in "Who is this?" cards. */
  unknown: FamiliarSample[];
  sightings: Sighting[];
  /** Events already looked at (`systemId:reviewId`) and who was recognized in them. */
  processed: Record<string, ProcessedEntry>;

  setSettings(p: Partial<FamiliarSettings>): void;
  upsertIdentity(i: FamiliarIdentity): void;
  removeIdentity(id: string): void;
  setUnknown(samples: FamiliarSample[]): void;
  addSightings(s: Sighting[]): void;
  removeSightings(identityId: string): void;
  markProcessed(entries: Record<string, ProcessedEntry>): void;
  /** Forget everything (prints, crops are removed by the caller). */
  reset(): void;
}

export const useFamiliar = create<FamiliarState>()(
  persist(
    (set) => ({
      settings: { enabled: false, strictness: 'careful', plates: true, instantTitles: true },
      identities: [],
      unknown: [],
      sightings: [],
      processed: {},

      setSettings: (p) => set((st) => ({ settings: { ...st.settings, ...p } })),
      upsertIdentity: (i) =>
        set((st) => {
          const identities = [...st.identities];
          const at = identities.findIndex((x) => x.id === i.id);
          if (at >= 0) identities[at] = i;
          else identities.push(i);
          return { identities };
        }),
      removeIdentity: (id) =>
        set((st) => ({
          identities: st.identities.filter((x) => x.id !== id),
          sightings: st.sightings.filter((s) => s.identityId !== id),
        })),
      setUnknown: (unknown) => set({ unknown: unknown.slice(-MAX_UNKNOWN) }),
      addSightings: (s) =>
        set((st) => ({ sightings: [...st.sightings, ...s].sort((a, b) => b.at - a.at).slice(0, MAX_SIGHTINGS) })),
      removeSightings: (identityId) => set((st) => ({ sightings: st.sightings.filter((s) => s.identityId !== identityId) })),
      markProcessed: (entries) =>
        set((st) => {
          const merged = { ...st.processed, ...entries };
          const keys = Object.keys(merged);
          if (keys.length <= MAX_PROCESSED) return { processed: merged };
          // Forget the oldest; at worst an old event gets looked at again.
          const keep = keys.sort((a, b) => merged[b].t - merged[a].t).slice(0, MAX_PROCESSED);
          return { processed: Object.fromEntries(keep.map((k) => [k, merged[k]])) };
        }),
      reset: () => set({ identities: [], unknown: [], sightings: [], processed: {} }),
    }),
    {
      name: FAMILIAR_STORE_KEY,
      version: 1,
      storage: createJSONStorage(() => familiarStorage),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<FamiliarState>;
        return { ...current, ...p, settings: { ...current.settings, ...p.settings } };
      },
    },
  ),
);

/** Names of identities the user has named (not ignored strangers). */
export function familiarNames(identities: FamiliarIdentity[]): string[] {
  return [...new Set(identities.filter((i) => !i.ignored && i.name).map((i) => i.name))].sort();
}

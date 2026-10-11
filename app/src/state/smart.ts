import Storage from 'expo-sqlite/kv-store';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import type { CheckIn, CheckInState } from '@/alerts/checkins';
import { addFeedback, forgetRule, type Feedback, type LearnedRule, type LearningState } from '@/alerts/learning';

/**
 * Smart alerts (what Sightline learned from "Not important" / "Always tell me", the rain/wind/
 * headlights setting) and family check-ins. Kept apart from the main settings store so these
 * features stay self-contained; synced to Sightline Hubs with the device rules (alerts/bridge.ts).
 */
interface SmartState {
  learning: LearningState;
  /** "Ignore likely rain, wind and headlights" for motion-only alerts. */
  conditions: boolean;
  checkins: CheckIn[];
  /** Check-in state: the app's own (built-in fallback) or the last copy from the Hub. */
  checkinStates: Record<string, CheckInState>;

  addFeedback(f: Feedback): void;
  forget(rule: Pick<LearnedRule, 'key' | 'camera' | 'objects' | 'light' | 'kind'>): void;
  confirm(key: string): void;
  setConditions(v: boolean): void;
  saveCheckin(c: CheckIn): void;
  deleteCheckin(id: string): void;
  setCheckinState(id: string, st: CheckInState): void;
}

export const useSmart = create<SmartState>()(
  persist(
    (set) => ({
      learning: { feedback: [], confirmed: [] },
      conditions: true,
      checkins: [],
      checkinStates: {},

      addFeedback: (f) => set((s) => ({ learning: addFeedback(s.learning, f) })),
      forget: (r) => set((s) => ({ learning: forgetRule(s.learning, r) })),
      confirm: (key) =>
        set((s) => ({ learning: { ...s.learning, confirmed: [...s.learning.confirmed.filter((k) => k !== key), key] } })),
      setConditions: (conditions) => set({ conditions }),
      saveCheckin: (c) => set((s) => ({ checkins: [...s.checkins.filter((x) => x.id !== c.id), c] })),
      deleteCheckin: (id) =>
        set((s) => {
          const checkinStates = { ...s.checkinStates };
          delete checkinStates[id];
          return { checkins: s.checkins.filter((x) => x.id !== id), checkinStates };
        }),
      setCheckinState: (id, st) => set((s) => ({ checkinStates: { ...s.checkinStates, [id]: st } })),
    }),
    {
      name: 'smart-alerts',
      version: 1,
      storage: createJSONStorage(() => Storage),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<SmartState>;
        return { ...current, ...p, learning: { ...current.learning, ...p.learning } };
      },
    },
  ),
);

/**
 * Resolves once the store has loaded from disk. Backups read and write it, and must never
 * see (or upload) the empty defaults, nor have a restore overwritten by a late load.
 */
export function smartHydrated(): Promise<void> {
  if (useSmart.persist.hasHydrated()) return Promise.resolve();
  return new Promise((resolve) => {
    const unsub = useSmart.persist.onFinishHydration(() => {
      unsub();
      resolve();
    });
    // Hydration may have finished between the check and the subscription.
    if (useSmart.persist.hasHydrated()) {
      unsub();
      resolve();
    }
  });
}

/** The backed-up part of the store (backup/sections.ts). `checkinStates` stays on this phone. */
export function smartBackupSource() {
  const { learning, conditions, checkins } = useSmart.getState();
  return { learning, conditions, checkins };
}

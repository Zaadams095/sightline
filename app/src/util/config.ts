import type { SystemConfig } from '@/systems/types';

/**
 * Systems are compared by value: rehydrating the store (or saving unchanged settings) makes
 * new objects with the same contents, which must not rebuild adapters or refetch cameras.
 */
export function configFingerprint(s: SystemConfig): string {
  return JSON.stringify(s, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

export function sameConfig(a: SystemConfig, b: SystemConfig): boolean {
  return a === b || configFingerprint(a) === configFingerprint(b);
}

/** Short stable hash of a system's settings, for query keys that must change when it's edited. */
export function configVersion(s: SystemConfig): string {
  const text = configFingerprint(s);
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

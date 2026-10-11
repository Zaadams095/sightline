import { useEffect, useMemo, useRef } from 'react';

import { recognizeItems, withFamiliarNames } from '@/familiar/recognize';
import { useFamiliar } from '@/familiar/store';
import { useLinks } from '@/net/connection';
import { useApp } from '@/state/store';
import { getAdapter } from '@/systems/registry';
import type { ReviewItem } from '@/systems/types';

/**
 * Events with on-device names merged in. With `scan`, also looks at a few new events in the
 * background while the screen is open (newest first, a small batch at a time).
 */
export function useFamiliarItems<T extends ReviewItem>(items: T[] | undefined, opts: { scan?: boolean; budget?: number } = {}): T[] {
  const enabled = useFamiliar((s) => s.settings.enabled);
  const processed = useFamiliar((s) => s.processed);
  const identities = useFamiliar((s) => s.identities);
  const running = useRef(false);
  const { scan = false, budget = 12 } = opts;

  useEffect(() => {
    if (!scan || !enabled || !items?.length || running.current) return;
    running.current = true;
    void recognizeItems(items, { budget })
      .catch(() => {})
      .finally(() => {
        running.current = false;
      });
  }, [items, enabled, scan, budget]);

  return useMemo(
    () => withFamiliarNames(items ?? []),
    // processed / identities: re-merge when recognition finds someone or a name changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, enabled, processed, identities],
  );
}

/**
 * "Look through recent events now": every reachable system's events from the last `hours`,
 * up to `budget` pictures. Returns how many events were looked at.
 */
export async function scanRecent(hours = 48, budget = 40): Promise<number> {
  const systems = useApp.getState().systems;
  const links = useLinks.getState().links;
  const after = Date.now() / 1000 - hours * 3600;
  const lists = await Promise.allSettled(
    systems.map(async (s) => {
      const link = links[s.id];
      if (link?.mode !== 'lan' && link?.mode !== 'tunnel') return [];
      const a = getAdapter(s, link);
      return a?.listReview ? a.listReview({ after, limit: 300 }) : [];
    }),
  );
  const items = lists.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  const before = Object.keys(useFamiliar.getState().processed).length;
  await recognizeItems(items, { budget });
  return Object.keys(useFamiliar.getState().processed).length - before;
}

import { useLinks } from '@/net/connection';
import { useApp } from '@/state/store';
import { getAdapter } from '@/systems/registry';
import type { CameraSystemAdapter } from '@/systems/types';

/**
 * Which optional features any connected system offers. Screens use this to show a feature
 * only when at least one of the user's systems can actually do it, never assuming a brand.
 */
export interface FeatureSupport {
  review: boolean;
  search: boolean;
  retain: boolean;
  clip: boolean;
  knownNames: boolean;
  groups: boolean;
  health: boolean;
  masks: boolean;
}

export function supportOf(adapters: (CameraSystemAdapter | null | undefined)[]): FeatureSupport {
  const any = (pick: (a: CameraSystemAdapter) => unknown) => adapters.some((a) => !!a && !!pick(a));
  return {
    review: any((a) => a.capabilities.review && a.listReview),
    search: any((a) => a.search),
    retain: any((a) => a.retain),
    clip: any((a) => a.clip),
    knownNames: any((a) => a.knownNames),
    groups: any((a) => a.groups),
    health: any((a) => a.health),
    masks: any((a) => a.detectionPoints),
  };
}

export function useFeatureSupport(): FeatureSupport {
  const systems = useApp((s) => s.systems);
  const links = useLinks((s) => s.links);
  return supportOf(systems.map((s) => getAdapter(s, links[s.id])));
}

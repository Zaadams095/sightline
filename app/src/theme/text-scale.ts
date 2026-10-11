import { useWindowDimensions } from 'react-native';

import { useApp } from '@/state/store';
import { BIGGER_TEXT } from '@/theme/tokens';

/** The in-app "Bigger text" multiplier (1 when off). The iPhone's own size is applied by iOS. */
export function useTextBoost(): number {
  return useApp((s) => s.appearance.biggerText) ? BIGGER_TEXT : 1;
}

/** iPhone text size × "Bigger text": 1 at the default size, ~3 at the largest accessibility size. */
export function useFontScale(): number {
  const { fontScale } = useWindowDimensions();
  return fontScale * useTextBoost();
}

/**
 * True at the big accessibility text sizes: side-by-side rows should stack (label above its
 * value or switch) and long labels should wrap instead of being cut off.
 */
export function useLargeText(): boolean {
  return useFontScale() >= 1.5;
}

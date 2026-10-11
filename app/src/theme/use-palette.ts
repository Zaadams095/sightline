import { useColorScheme } from 'react-native';

import { useApp } from '@/state/store';
import { ACCENTS, buildPalette, type Palette } from '@/theme/tokens';

export function usePalette(): Palette {
  const { mode, accent } = useApp((s) => s.appearance);
  const system = useColorScheme();
  const resolved = mode === 'system' ? (system === 'light' ? 'light' : 'dark') : mode;
  return buildPalette(resolved, ACCENTS[accent]);
}

export function useIsDark(): boolean {
  const mode = useApp((s) => s.appearance.mode);
  const system = useColorScheme();
  return mode === 'system' ? system !== 'light' : mode !== 'light';
}

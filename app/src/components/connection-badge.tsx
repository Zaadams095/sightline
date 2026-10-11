import { router } from 'expo-router';
import { Pressable, StyleSheet } from 'react-native';
import { useShallow } from 'zustand/react/shallow';

import { StatusDot, T } from '@/components/ui/primitives';
import { useT } from '@/i18n/use-t';
import { useLinks, type LinkMode } from '@/net/connection';
import { usePalette } from '@/theme/use-palette';

/** Summarizes how the app is reaching the user's systems; tap for away-from-home settings. */
export function ConnectionBadge() {
  const p = usePalette();
  const t = useT();
  const links = useLinks(useShallow((s) => Object.values(s.links)));
  if (links.length === 0) return null;

  const mode: LinkMode = links.some((l) => l.mode === 'connecting')
    ? 'connecting'
    : links.every((l) => l.mode === 'offline')
      ? 'offline'
      : links.some((l) => l.mode === 'tunnel')
        ? 'tunnel'
        : 'lan';
  const color = { lan: p.success, tunnel: p.accent, connecting: p.warning, offline: p.danger }[mode];
  // Whether through a Sightline Hub's own link or the user's VPN, it reads the same.
  const label = t.home.badge[mode];

  return (
    <Pressable
      onPress={() => router.push('/settings/vpn')}
      accessibilityRole="button"
      accessibilityLabel={t.home.badge.a11y(label)}
      accessibilityHint={t.home.badge.hint}
      hitSlop={{ top: 8, bottom: 8 }}
      style={[styles.pill, { backgroundColor: p.surfaceRaised, borderColor: p.border }]}>
      <StatusDot color={color} />
      <T v="caption" overlay>
        {label}
      </T>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
  },
});

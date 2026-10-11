import { router } from 'expo-router';
import { Pressable, StyleSheet } from 'react-native';
import { useShallow } from 'zustand/react/shallow';

import { StatusDot, T } from '@/components/ui/primitives';
import { useLinks, type LinkMode } from '@/net/connection';
import { usePalette } from '@/theme/use-palette';

const LABEL: Record<LinkMode, string> = {
  lan: 'Home network',
  tunnel: 'VPN',
  connecting: 'Connecting…',
  offline: 'Offline',
};

/** Summarizes how the app is reaching the user's systems; tap for VPN settings. */
export function ConnectionBadge() {
  const p = usePalette();
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

  return (
    <Pressable
      onPress={() => router.push('/settings/vpn')}
      style={[styles.pill, { backgroundColor: p.surfaceRaised, borderColor: p.border }]}>
      <StatusDot color={color} />
      <T v="caption">{LABEL[mode]}</T>
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

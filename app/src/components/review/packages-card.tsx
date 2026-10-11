import { Image } from 'expo-image';
import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet, View } from 'react-native';

import { packageHandled, packageSeen } from '@/alerts/packages-notify';
import { Card, Chip, T } from '@/components/ui/primitives';
import { useApp } from '@/state/store';
import { space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';
import { formatRelative } from '@/util/format';

/** "Packages" card at the top of Review while any package is still out. */
export function PackagesCard({ names }: { names: Map<string, string> }) {
  const p = usePalette();
  const packages = useApp((s) => s.packages);
  const radius = useApp((s) => s.appearance.radius);
  const open = Object.values(packages).sort((a, b) => b.since - a.since);
  if (!open.length) return null;

  return (
    <View style={{ paddingHorizontal: space.lg }}>
      <Card>
        <View style={styles.header}>
          <SymbolView name="shippingbox.fill" tintColor={p.warning} size={18} />
          <T v="label">{open.length === 1 ? 'A package is outside' : `${open.length} packages are outside`}</T>
        </View>
        {open.map((pkg, i) => (
          <Pressable
            key={pkg.cameraKey}
            onPress={() => {
              void packageSeen(pkg.cameraKey);
              router.push({
                pathname: '/playback',
                params: { systemId: pkg.systemId, cameraId: pkg.cameraId, start: String(Math.floor(pkg.since - 5)), reviewId: pkg.reviewId },
              });
            }}
            style={({ pressed }) => [
              styles.row,
              { backgroundColor: pressed ? p.surfaceRaised : 'transparent', borderTopColor: p.border, borderTopWidth: i === 0 ? StyleSheet.hairlineWidth : 0 },
            ]}>
            {pkg.thumbnailUrl ? (
              <Image source={{ uri: pkg.thumbnailUrl }} style={[styles.thumb, { borderRadius: Math.min(radius, 8) }]} />
            ) : (
              <View style={[styles.thumb, { borderRadius: Math.min(radius, 8), backgroundColor: p.surfaceRaised }]} />
            )}
            <View style={{ flex: 1, gap: 2 }}>
              <T v="label">{names.get(pkg.cameraKey) ?? pkg.cameraName ?? pkg.cameraId}</T>
              <T v="caption" muted numberOfLines={2}>
                Delivered {deliveredWhen(pkg.since)}
                {pkg.personAfter ? ' · someone came by since' : ''}
              </T>
            </View>
            <Chip label="I got it" selected={false} onPress={() => void packageHandled(pkg.cameraKey)} />
          </Pressable>
        ))}
      </Card>
    </View>
  );
}

function deliveredWhen(t: number): string {
  const r = formatRelative(t);
  if (r === 'Just now') return 'just now';
  if (r.startsWith('Today ')) return `today at ${r.slice(6)}`;
  if (r.startsWith('Yesterday ')) return `yesterday at ${r.slice(10)}`;
  return r;
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.sm },
  thumb: { width: 64, height: 40 },
});

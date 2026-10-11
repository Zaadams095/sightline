import { Image } from 'expo-image';
import { router } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';

import { packageHandled, packageSeen } from '@/alerts/packages-notify';
import { Card, Chip, T } from '@/components/ui/primitives';
import { SymbolView } from '@/components/ui/symbol';
import type { Strings } from '@/i18n';
import { useT } from '@/i18n/use-t';
import { useApp } from '@/state/store';
import { useLargeText } from '@/theme/text-scale';
import { space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';
import { formatClock, formatRelative } from '@/util/format';

/** "Packages" card at the top of Review while any package is still out. */
export function PackagesCard({ names }: { names: Map<string, string> }) {
  const p = usePalette();
  const t = useT();
  const large = useLargeText();
  const packages = useApp((s) => s.packages);
  const radius = useApp((s) => s.appearance.radius);
  const open = Object.values(packages).sort((a, b) => b.since - a.since);
  if (!open.length) return null;

  return (
    <View style={{ paddingHorizontal: space.lg }}>
      <Card>
        <View style={styles.header}>
          <SymbolView name="shippingbox.fill" tintColor={p.warning} size={18} />
          <T v="label" style={{ flex: 1 }}>
            {t.home.packages.outside(open.length)}
          </T>
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
              // At big text sizes the "I got it" button moves under the text instead of squeezing it.
              large && styles.rowStacked,
              { backgroundColor: pressed ? p.surfaceRaised : 'transparent', borderTopColor: p.border, borderTopWidth: i === 0 ? StyleSheet.hairlineWidth : 0 },
            ]}>
            {pkg.thumbnailUrl ? (
              <Image source={{ uri: pkg.thumbnailUrl }} style={[styles.thumb, { borderRadius: Math.min(radius, 8) }]} />
            ) : (
              <View style={[styles.thumb, { borderRadius: Math.min(radius, 8), backgroundColor: p.surfaceRaised }]} />
            )}
            <View style={large ? { alignSelf: 'stretch', gap: 2 } : { flex: 1, gap: 2 }}>
              <T v="label">{names.get(pkg.cameraKey) ?? pkg.cameraName ?? pkg.cameraId}</T>
              <T v="caption" muted numberOfLines={large ? undefined : 2}>
                {t.home.packages.delivered(deliveredWhen(pkg.since, t))}
                {pkg.personAfter ? ` · ${t.home.packages.someoneCame}` : ''}
              </T>
            </View>
            <Chip label={t.home.packages.gotIt} selected={false} onPress={() => void packageHandled(pkg.cameraKey)} />
          </Pressable>
        ))}
      </Card>
    </View>
  );
}

/** "just now" / "today at 9:41 AM" / "yesterday at 6:02 PM" / "5 min ago" / "Oct 3 9:41 AM". */
function deliveredWhen(unix: number, t: Strings): string {
  const k = t.home.packages;
  const diff = Date.now() / 1000 - unix;
  if (diff < 60) return k.justNow;
  if (diff < 3600) return formatRelative(unix);
  const d = new Date(unix * 1000);
  if (d.toDateString() === new Date().toDateString()) return k.todayAt(formatClock(unix));
  if (d.toDateString() === new Date(Date.now() - 86_400_000).toDateString()) return k.yesterdayAt(formatClock(unix));
  return formatRelative(unix);
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.sm },
  rowStacked: { flexDirection: 'column', alignItems: 'flex-start' },
  thumb: { width: 64, height: 40 },
});

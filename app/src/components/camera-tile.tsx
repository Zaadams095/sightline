import { useQueryClient } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { memo, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';

import { LiveView, prefetchLiveOptions, useLive } from '@/components/live/live-view';
import { useApp } from '@/state/store';
import type { CameraSystemAdapter, Camera } from '@/systems/types';
import { usePalette } from '@/theme/use-palette';

interface Props {
  camera: Camera;
  adapter: CameraSystemAdapter;
  /** Only visible tiles refresh. */
  active: boolean;
  /** Snapshot refresh interval in ms. */
  intervalMs?: number;
  style?: ViewStyle;
  /** Pixel height to request; keeps bandwidth low for small tiles. */
  requestHeight?: number;
  /** Called with the frame currently shown, so the next screen can display it instantly. */
  onPress?: (posterUri?: string) => void;
  onLongPress?: () => void;
}

/**
 * Snapshot tile. Double-buffered: the next frame loads invisibly and replaces the
 * current one only once decoded, so tiles never flash or go blank.
 */
export const CameraTile = memo(function CameraTile({
  camera,
  adapter,
  active,
  intervalMs = 1000,
  style,
  requestHeight = 360,
  onPress,
  onLongPress,
}: Props) {
  const palette = usePalette();
  const { radius, labelStyle } = useApp((s) => s.appearance);
  const [tick, setTick] = useState(0);
  const [shown, setShown] = useState<string | null>(null);
  const queryClient = useQueryClient();
  // Start resolving the live stream as soon as a finger lands, before the screen opens.
  const prefetchLive = () => {
    if (!adapter.capabilities.live) return;
    void queryClient.prefetchQuery(prefetchLiveOptions(adapter, camera.id));
  };

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setTick((t) => t + 1), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);

  const base = adapter.snapshot(camera.id, { height: requestHeight }).uri;
  // Cameras without a snapshot URL show a muted low-res live stream while visible.
  const liveTile = !base && adapter.capabilities.live;
  const live = useLive(adapter, camera.id, 'sub', liveTile && active);
  const next = base ? `${base}${base.includes('?') ? '&' : '?'}t=${tick}` : null;

  return (
    <View style={style}>
      <Pressable
        onPressIn={prefetchLive}
        onPress={() => onPress?.(shown ?? undefined)}
        onLongPress={onLongPress}
        style={({ pressed }) => [
          styles.frame,
          { borderRadius: radius, backgroundColor: palette.surface, opacity: pressed ? 0.85 : 1 },
        ]}>
        {liveTile && active && live.data && (
          <View style={StyleSheet.absoluteFill} pointerEvents="none">
            <LiveView live={live.data} fit="cover" />
          </View>
        )}
        {/* Memory cache: the visible image reuses the frame the hidden one just downloaded. */}
        {shown && <Image source={{ uri: shown }} style={StyleSheet.absoluteFill} contentFit="cover" transition={0} cachePolicy="memory" />}
        {next && next !== shown && (
          <Image
            source={{ uri: next }}
            style={[StyleSheet.absoluteFill, { opacity: 0 }]}
            cachePolicy="memory"
            onLoad={() => setShown(next)}
          />
        )}
        {!camera.enabled && (
          <View style={[StyleSheet.absoluteFill, styles.center, { backgroundColor: palette.scrim }]}>
            <Text style={styles.disabled}>Camera off</Text>
          </View>
        )}
        {labelStyle === 'overlay' && (
          <View style={styles.labelWrap}>
            <View style={[styles.labelPill, { backgroundColor: palette.scrim }]}>
              {camera.ptz && <Text style={styles.badge}>PTZ</Text>}
              <Text style={styles.label} numberOfLines={1}>
                {camera.name}
              </Text>
            </View>
          </View>
        )}
      </Pressable>
      {labelStyle === 'below' && (
        <Text style={[styles.below, { color: palette.text }]} numberOfLines={1}>
          {camera.name}
        </Text>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  frame: { flex: 1, overflow: 'hidden' },
  center: { alignItems: 'center', justifyContent: 'center' },
  disabled: { color: '#fff', fontWeight: '600' },
  labelWrap: { position: 'absolute', left: 8, bottom: 8, right: 8, flexDirection: 'row' },
  labelPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    maxWidth: '100%',
  },
  label: { color: '#fff', fontSize: 13, fontWeight: '600' },
  badge: { color: '#fff', fontSize: 10, fontWeight: '800', opacity: 0.8 },
  below: { fontSize: 13, fontWeight: '600', marginTop: 6, marginLeft: 2 },
});

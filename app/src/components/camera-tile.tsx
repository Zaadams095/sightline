import { useIsFocused } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { memo, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';

import { SamplePill } from '@/components/demo-banner';
import { LiveView, prefetchLiveOptions, useLive } from '@/components/live/live-view';
import { SymbolView } from '@/components/ui/symbol';
import { useT } from '@/i18n/use-t';
import { useLinks } from '@/net/connection';
import { useApp } from '@/state/store';
import type { CameraSystemAdapter, Camera } from '@/systems/types';
import { OVERLAY_MAX_SCALE } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';
import { useAppActive } from '@/util/app-active';

/** Away from home every tile refresh crosses the home upload; keep it light. */
const AWAY_REFRESH_MS = 4000;
const AWAY_MAX_HEIGHT = 360;

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
  const t = useT();
  const { radius, labelStyle } = useApp((s) => s.appearance);
  const [tick, setTick] = useState(0);
  const [shown, setShown] = useState<string | null>(null);
  const queryClient = useQueryClient();
  // Start resolving the live stream as soon as a finger lands, before the screen opens.
  const prefetchLive = () => {
    if (!adapter.capabilities.live) return;
    void queryClient.prefetchQuery(prefetchLiveOptions(adapter, camera.id));
  };

  // Refresh only while this grid is actually on screen: not behind a full-screen camera, on
  // another tab, or with the app in the background, where it would just compete with the
  // video being watched. Away from home (VPN), every refresh crosses the home internet's
  // upload, so tiles refresh more gently and at a smaller size.
  const focused = useIsFocused();
  const appActive = useAppActive();
  const away = useLinks((s) => s.links[adapter.config.id]?.mode) === 'tunnel';
  const running = active && focused && appActive;
  const every = away ? Math.max(intervalMs, AWAY_REFRESH_MS) : intervalMs;
  const height = away ? Math.min(requestHeight, AWAY_MAX_HEIGHT) : requestHeight;

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setTick((t) => t + 1), every);
    return () => clearInterval(id);
  }, [running, every]);

  // Only ask for stills from systems that have them; the others would just 404 every second.
  const base = adapter.capabilities.snapshots ? adapter.snapshot(camera.id, { height }).uri : '';
  // Cameras without a snapshot URL show a muted low-res live stream while visible.
  const liveTile = !base && adapter.capabilities.live;
  const live = useLive(adapter, camera.id, 'sub', liveTile && running);
  const next = base ? `${base}${base.includes('?') ? '&' : '?'}t=${tick}` : null;

  return (
    <View style={style}>
      <Pressable
        onPressIn={prefetchLive}
        onPress={() => onPress?.(shown ?? undefined)}
        onLongPress={onLongPress}
        accessibilityRole="button"
        accessibilityLabel={camera.enabled ? camera.name : t.home.tile.cameraOffA11y(camera.name)}
        accessibilityHint={t.home.tile.opensLive}
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
        {adapter.config.kind === 'demo' && (
          <View style={styles.sample} pointerEvents="none">
            <SamplePill />
          </View>
        )}
        {!camera.enabled && (
          <View style={[StyleSheet.absoluteFill, styles.center, { backgroundColor: palette.scrim }]}>
            <Text style={styles.disabled} maxFontSizeMultiplier={OVERLAY_MAX_SCALE}>
              {t.home.tile.cameraOff}
            </Text>
          </View>
        )}
        {labelStyle === 'overlay' && (
          <View style={styles.labelWrap}>
            <View style={[styles.labelPill, { backgroundColor: palette.scrim }]}>
              {camera.ptz && <SymbolView name="move.3d" tintColor="#fff" size={11} accessibilityLabel={t.home.tile.canMove} />}
              {/* Drawn over video: grows only a little with the text size, so it never covers the picture. */}
              <Text style={styles.label} numberOfLines={1} maxFontSizeMultiplier={OVERLAY_MAX_SCALE}>
                {camera.name}
              </Text>
            </View>
          </View>
        )}
      </Pressable>
      {labelStyle === 'below' && (
        <Text style={[styles.below, { color: palette.text }]} numberOfLines={1} maxFontSizeMultiplier={OVERLAY_MAX_SCALE}>
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
  sample: { position: 'absolute', top: 8, right: 8 },
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

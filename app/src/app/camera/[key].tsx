import { useQuery } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { ActionSheetIOS, FlatList, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { LiveView, useLive } from '@/components/live/live-view';
import { nextTimeOfDay } from '@/alerts/rules';
import { PtzPad } from '@/components/ptz-pad';
import { T } from '@/components/ui/primitives';
import { useApp } from '@/state/store';
import { useAdapter } from '@/systems/registry';
import { space } from '@/theme/tokens';
import { formatClock, formatRelative, nowSec, titleFor } from '@/util/format';

export default function CameraScreen() {
  const { key, poster: tilePoster } = useLocalSearchParams<{ key: string; poster?: string }>();
  const [openedAt] = useState(() => Math.round(nowSec() * 1000));
  const [systemId, cameraId] = splitKey(key);
  const adapter = useAdapter(systemId);
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const landscape = width > height;
  const [muted, setMuted] = useState(true);
  const [showPtz, setShowPtz] = useState(false);
  const radius = useApp((s) => s.appearance.radius);
  const snoozedUntil = useApp((s) => s.alerts.snoozed[key] ?? 0);
  const snooze = useApp((s) => s.snooze);
  const isSnoozed = snoozedUntil > nowSec();
  const toggleSnooze = () => {
    if (isSnoozed) return snooze(key, null);
    ActionSheetIOS.showActionSheetWithOptions(
      { title: 'Mute alerts from this camera', options: ['For 1 hour', 'Until 7 AM', 'For 24 hours', 'Cancel'], cancelButtonIndex: 3 },
      (i) => {
        const now = Math.floor(nowSec());
        const until = [now + 3600, nextTimeOfDay(7, 0), now + 86400][i];
        if (until) snooze(key, until);
      },
    );
  };

  const cameras = useQuery({
    queryKey: ['cameras-of', systemId, !!adapter],
    queryFn: () => adapter!.listCameras(),
    enabled: !!adapter,
    staleTime: 5 * 60_000,
  });
  const camera = cameras.data?.find((c) => c.id === cameraId);

  const live = useLive(adapter, cameraId);

  const recent = useQuery({
    queryKey: ['review', systemId, cameraId],
    queryFn: () => adapter!.listReview!({ cameras: [cameraId], after: nowSec() - 86400, limit: 30 }),
    enabled: !!adapter?.listReview,
  });

  if (!adapter) return <View style={styles.root} />;

  const videoH = landscape ? height : width / (camera?.aspect ?? 16 / 9);
  // Show the frame the tile already had (instant, from memory), then a sharper one once loaded.
  const poster = (
    <Image
      source={{ uri: adapter.snapshot(cameraId, { height: 720 }).uri }}
      placeholder={tilePoster ? { uri: tilePoster, cacheKey: tilePoster } : undefined}
      placeholderContentFit="contain"
      style={StyleSheet.absoluteFill}
      contentFit="contain"
      transition={150}
    />
  );

  return (
    <View style={styles.root}>
      <View style={{ height: videoH, marginTop: landscape ? 0 : insets.top + 52 }}>
        {live.data ? (
          <LiveView live={live.data} muted={muted} poster={poster} timingLabel={camera?.name ?? cameraId} openedAt={openedAt} />
        ) : (
          <View style={StyleSheet.absoluteFill}>{poster}</View>
        )}
      </View>

      <View style={[styles.topBar, { top: insets.top + 6 }]}>
        <RoundButton icon="xmark" onPress={() => router.back()} />
        <T v="heading" color="#fff" numberOfLines={1} style={{ flex: 1, textAlign: 'center' }}>
          {camera?.name ?? cameraId}
        </T>
        <RoundButton icon={muted ? 'speaker.slash.fill' : 'speaker.wave.2.fill'} onPress={() => setMuted((m) => !m)} />
      </View>

      {!landscape && (
        <View style={{ flex: 1, paddingTop: space.lg, gap: space.lg }}>
          <View style={styles.actions}>
            {adapter.capabilities.review && (
              <Action
                icon="clock.arrow.circlepath"
                label="Timeline"
                onPress={() =>
                  router.push({
                    pathname: '/playback',
                    params: { systemId, cameraId, start: String(Math.floor(nowSec() - 600)) },
                  })
                }
              />
            )}
            {camera?.ptz && <Action icon="move.3d" label="PTZ" active={showPtz} onPress={() => setShowPtz((v) => !v)} />}
            <Action
              icon={isSnoozed ? 'bell.slash.fill' : 'bell'}
              label={isSnoozed ? `Muted till ${formatClock(snoozedUntil)}` : 'Snooze'}
              active={isSnoozed}
              onPress={toggleSnooze}
            />
          </View>

          {showPtz && camera?.ptz ? (
            <PtzPad adapter={adapter} cameraId={cameraId} />
          ) : (
            <FlatList
              data={recent.data ?? []}
              keyExtractor={(r) => r.id}
              contentContainerStyle={{ paddingHorizontal: space.lg, gap: space.sm, paddingBottom: insets.bottom + 24 }}
              ListHeaderComponent={
                <T v="label" color="rgba(255,255,255,0.6)" style={{ marginBottom: 4 }}>
                  LAST 24 HOURS
                </T>
              }
              ListEmptyComponent={
                <T v="caption" color="rgba(255,255,255,0.5)">
                  {recent.isLoading ? 'Loading…' : 'No activity'}
                </T>
              }
              renderItem={({ item }) => (
                <Pressable
                  style={styles.event}
                  onPress={() =>
                    router.push({
                      pathname: '/playback',
                      params: { systemId, cameraId, start: String(Math.floor(item.startTime - 5)), reviewId: item.id },
                    })
                  }>
                  {item.thumbnailUrl ? (
                    <Image source={{ uri: item.thumbnailUrl }} style={[styles.thumb, { borderRadius: Math.min(radius, 10) }]} />
                  ) : (
                    <View style={styles.thumb} />
                  )}
                  <View style={{ flex: 1, gap: 2 }}>
                    <T v="label" color="#fff">
                      {titleFor(item)}
                    </T>
                    <T v="caption" color="rgba(255,255,255,0.6)">
                      {formatRelative(item.startTime)}
                      {item.zones.length ? ` · ${item.zones.join(', ')}` : ''}
                    </T>
                  </View>
                  {item.severity === 'alert' && <View style={styles.alertDot} />}
                </Pressable>
              )}
            />
          )}
        </View>
      )}
    </View>
  );
}

function splitKey(key: string): [string, string] {
  const i = key.indexOf(':');
  return [key.slice(0, i), key.slice(i + 1)];
}

function RoundButton({ icon, onPress }: { icon: React.ComponentProps<typeof SymbolView>['name']; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} hitSlop={8} style={styles.round}>
      <SymbolView name={icon} tintColor="#fff" size={18} />
    </Pressable>
  );
}

function Action({
  icon,
  label,
  onPress,
  active,
}: {
  icon: React.ComponentProps<typeof SymbolView>['name'];
  label: string;
  onPress: () => void;
  active?: boolean;
}) {
  return (
    <Pressable onPress={onPress} style={[styles.action, active && { backgroundColor: 'rgba(255,255,255,0.22)' }]}>
      <SymbolView name={icon} tintColor="#fff" size={20} />
      <T v="caption" color="#fff">
        {label}
      </T>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  topBar: { position: 'absolute', left: 12, right: 12, flexDirection: 'row', alignItems: 'center', gap: 12 },
  round: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  actions: { flexDirection: 'row', gap: 10, paddingHorizontal: space.lg },
  action: {
    flex: 1,
    alignItems: 'center',
    gap: 6,
    paddingVertical: 12,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  event: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  thumb: { width: 96, height: 54, backgroundColor: '#1a1a1a' },
  alertDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#FF453A' },
});

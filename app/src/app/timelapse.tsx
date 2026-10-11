import { useQuery } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { StreamTimelapse, VodTimelapse } from '@/components/playback/timelapse-player';
import { Chip, T } from '@/components/ui/primitives';
import { tr } from '@/i18n';
import { useT } from '@/i18n/use-t';
import { useAdapter } from '@/systems/registry';
import { space } from '@/theme/tokens';
import { formatDay, nowSec } from '@/util/format';
import { shareClip } from '@/util/share';
import { SHAREABLE_MAX_SEC } from '@/util/timelapse';

type Range = '1h' | '3h' | 'day';

function localMidnight(t: number) {
  const d = new Date(t * 1000);
  d.setHours(0, 0, 0, 0);
  return d.getTime() / 1000;
}

/**
 * Timelapse of a camera's recordings for a day or the last few hours. Works with any system
 * that can play recordings: fast/jumping playback when it's seekable, otherwise a few
 * seconds from each step.
 */
export default function TimelapseScreen() {
  const t = useT();
  const params = useLocalSearchParams<{ systemId: string; cameraId: string; day?: string }>();
  const adapter = useAdapter(params.systemId);
  const cameraId = params.cameraId;
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const [now] = useState(() => Math.floor(nowSec()));
  const today = localMidnight(now);
  const day = params.day ? localMidnight(Number(params.day)) : today;
  const pastDay = day < today;
  const [range, setRange] = useState<Range>('day');
  const [sharing, setSharing] = useState(false);

  // Just after midnight "today" is nearly empty, so show the last 24 hours instead.
  const dayWindow: [number, number] = pastDay ? [day, day + 86400] : now - today < 3600 ? [now - 86400, now] : [today, now];
  const [start, end] = range === '1h' ? [now - 3600, now] : range === '3h' ? [now - 3 * 3600, now] : dayWindow;
  const dayLabel = pastDay ? formatDay(day) : now - today < 3600 ? t.viewing.timelapse.last24h : t.common.today;

  const cameras = useQuery({
    queryKey: ['cameras-of', params.systemId, !!adapter],
    queryFn: () => adapter!.listCameras(),
    enabled: !!adapter,
    staleTime: 5 * 60_000,
  });
  const name = cameras.data?.find((c) => c.id === cameraId)?.name ?? cameraId;

  // One small request decides how this system plays recordings.
  const kind = useQuery({
    queryKey: ['timelapse-kind', params.systemId, cameraId],
    queryFn: async () => (await adapter!.playback!(cameraId, now - 600, now)).kind,
    enabled: !!adapter?.playback,
    staleTime: Infinity,
  });

  const events = useQuery({
    queryKey: ['timelapse-events', params.systemId, cameraId, start, end],
    queryFn: () => adapter!.listReview!({ cameras: [cameraId], after: start, before: end, limit: 500 }),
    enabled: !!adapter?.listReview,
    staleTime: 60_000,
  });

  const canShare = !!adapter?.clip && end - start <= SHAREABLE_MAX_SEC;
  const share = async () => {
    if (!adapter) return;
    setSharing(true);
    try {
      await shareClip(adapter, cameraId, name, start, end);
    } catch (e) {
      Alert.alert(tr().viewing.timelapse.exportFailed, e instanceof Error ? e.message : String(e));
    } finally {
      setSharing(false);
    }
  };

  const landscape = width > height;
  const videoHeight = landscape ? height * 0.6 : width * (9 / 16);
  const playerProps = adapter && {
    adapter,
    cameraId,
    start,
    end,
    events: events.data ?? [],
    videoHeight,
  };

  return (
    <View style={styles.root}>
      <View style={[styles.topBar, { paddingTop: insets.top + 6 }]}>
        <Pressable onPress={() => router.back()} hitSlop={8} style={styles.round} accessibilityLabel={t.common.close}>
          <SymbolView name="xmark" tintColor="#fff" size={18} />
        </Pressable>
        <View style={{ flex: 1, alignItems: 'center' }}>
          <T v="label" color="#fff" numberOfLines={2} style={{ textAlign: 'center' }}>
            {name}
          </T>
          <T v="caption" color="rgba(255,255,255,0.6)">
            {t.viewing.camera.timelapse}
          </T>
        </View>
        {canShare ? (
          <Pressable onPress={() => void share()} hitSlop={8} style={styles.round} disabled={sharing} accessibilityLabel={t.viewing.clip.shareVideo}>
            {sharing ? <ActivityIndicator color="#fff" /> : <SymbolView name="square.and.arrow.up" tintColor="#fff" size={17} />}
          </Pressable>
        ) : (
          <View style={{ width: 40 }} />
        )}
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + space.xl, gap: space.lg }}>
        {!adapter?.playback ? (
          <Message text={t.viewing.timelapse.noPlayback} />
        ) : kind.isError ? (
          <Message text={t.viewing.timelapse.unreachable} />
        ) : !kind.data || !playerProps ? (
          <View style={{ height: videoHeight, alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator color="#fff" />
          </View>
        ) : kind.data === 'vod' ? (
          <VodTimelapse key={`${start}-${end}`} {...playerProps} />
        ) : (
          <StreamTimelapse key={`${start}-${end}`} {...playerProps} />
        )}

        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          <Chip label={dayLabel} selected={range === 'day'} onPress={() => setRange('day')} />
          {!pastDay && <Chip label={t.viewing.timelapse.last3h} selected={range === '3h'} onPress={() => setRange('3h')} />}
          {!pastDay && <Chip label={t.viewing.timelapse.lastHour} selected={range === '1h'} onPress={() => setRange('1h')} />}
        </ScrollView>

        {canShare && (
          <T v="caption" color="rgba(255,255,255,0.5)" style={{ paddingHorizontal: 24, textAlign: 'center' }}>
            {t.viewing.timelapse.shareNote}
          </T>
        )}
      </ScrollView>
    </View>
  );
}

function Message({ text }: { text: string }) {
  return (
    <View style={{ padding: space.xl, alignItems: 'center' }}>
      <T color="#fff" style={{ textAlign: 'center' }}>
        {text}
      </T>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  topBar: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingBottom: 10 },
  round: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  chips: { gap: 6, paddingHorizontal: 16 },
});

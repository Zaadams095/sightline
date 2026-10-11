import { useQuery } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SymbolView } from 'expo-symbols';
import { useEffect, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { setDoorbellScreenOpen } from '@/alerts/doorbell';
import { LiveView, useLive } from '@/components/live/live-view';
import { T } from '@/components/ui/primitives';
import { useAdapter } from '@/systems/registry';
import { usePalette } from '@/theme/use-palette';
import { formatClock, nowSec } from '@/util/format';

const GREEN = '#30D158';
const RED = '#FF453A';

/**
 * Full-screen "Someone's at the door", like an incoming call: live video behind, Answer
 * (live view with sound) and Dismiss. Opened by a doorbell ring from any system.
 */
export default function DoorbellScreen() {
  const { systemId, cameraId, at } = useLocalSearchParams<{ systemId: string; cameraId: string; at?: string; reviewId?: string }>();
  const adapter = useAdapter(systemId);
  const insets = useSafeAreaInsets();
  const accent = usePalette().accent;
  const key = `${systemId}:${cameraId}`;
  const ringAt = at ? Number(at) : null;
  const [openedAt] = useState(() => nowSec());

  const cameras = useQuery({
    queryKey: ['cameras-of', systemId, !!adapter],
    queryFn: () => adapter!.listCameras(),
    enabled: !!adapter,
    staleTime: 5 * 60_000,
  });
  const name = cameras.data?.find((c) => c.id === cameraId)?.name ?? cameraId;
  const live = useLive(adapter, cameraId);

  useEffect(() => {
    setDoorbellScreenOpen(true);
    // A few "ring" taps, like an incoming call, then quiet.
    let n = 0;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    const t = setInterval(() => {
      if (++n >= 3) clearInterval(t);
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    }, 1200);
    return () => {
      clearInterval(t);
      setDoorbellScreenOpen(false);
    };
  }, []);

  const [pulse] = useState(() => new Animated.Value(0));
  useEffect(() => {
    const loop = Animated.loop(Animated.timing(pulse, { toValue: 1, duration: 1600, easing: Easing.out(Easing.quad), useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  const close = () => (router.canGoBack() ? router.back() : router.replace('/'));
  const answer = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    router.replace({ pathname: '/camera/[key]', params: { key, unmuted: '1' } });
  };
  const replay = () =>
    router.replace({ pathname: '/playback', params: { systemId, cameraId, start: String(Math.floor((ringAt ?? openedAt) - 10)) } });

  const ago = ringAt != null ? openedAt - ringAt : 0;
  const when = ringAt == null || ago < 60 ? 'Just now' : `Rang at ${formatClock(ringAt)}`;

  const poster = adapter ? (
    <Image source={{ uri: adapter.snapshot(cameraId, { height: 720 }).uri }} style={StyleSheet.absoluteFill} contentFit="cover" transition={150} />
  ) : null;

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <View style={StyleSheet.absoluteFill}>
        {live.data ? <LiveView live={live.data} fit="cover" poster={poster} /> : poster}
      </View>
      <View style={[styles.shade, { top: 0, height: insets.top + 220 }]} pointerEvents="none" />
      <View style={[styles.shade, { bottom: 0, height: insets.bottom + 260 }]} pointerEvents="none" />

      <View style={[styles.header, { paddingTop: insets.top + 28 }]}>
        <View style={styles.bellWrap}>
          <Animated.View
            style={[
              styles.ring,
              {
                backgroundColor: accent,
                opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.6, 0] }),
                transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.9] }) }],
              },
            ]}
          />
          <View style={[styles.bell, { backgroundColor: accent }]}>
            <SymbolView name="bell.fill" tintColor="#fff" size={26} />
          </View>
        </View>
        <T v="title" color="#fff" style={styles.center}>
          Someone’s at the door
        </T>
        <T color="rgba(255,255,255,0.85)" style={styles.center}>
          {name} · {when}
        </T>
      </View>

      <View style={[styles.footer, { paddingBottom: insets.bottom + 28 }]}>
        <View style={styles.buttons}>
          <CallButton label="Dismiss" color={RED} icon="xmark" onPress={close} />
          <CallButton label="Answer" color={GREEN} icon="video.fill" onPress={answer} />
        </View>
        {adapter?.playback && (
          <Pressable onPress={replay} hitSlop={10} style={styles.replay}>
            <SymbolView name="clock.arrow.circlepath" tintColor="rgba(255,255,255,0.85)" size={15} />
            <T v="label" color="rgba(255,255,255,0.85)">
              See what happened
            </T>
          </Pressable>
        )}
      </View>
    </View>
  );
}

function CallButton({
  label,
  color,
  icon,
  onPress,
}: {
  label: string;
  color: string;
  icon: React.ComponentProps<typeof SymbolView>['name'];
  onPress: () => void;
}) {
  return (
    <View style={styles.callItem}>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={label}
        style={({ pressed }) => [styles.callBtn, { backgroundColor: color, opacity: pressed ? 0.8 : 1 }]}>
        <SymbolView name={icon} tintColor="#fff" size={30} />
      </Pressable>
      <T v="label" color="#fff">
        {label}
      </T>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  shade: { position: 'absolute', left: 0, right: 0, backgroundColor: 'rgba(0,0,0,0.45)' },
  header: { alignItems: 'center', gap: 10, paddingHorizontal: 24 },
  center: { textAlign: 'center' },
  bellWrap: { width: 64, height: 64, alignItems: 'center', justifyContent: 'center', marginBottom: 6 },
  ring: { position: 'absolute', width: 64, height: 64, borderRadius: 32 },
  bell: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center' },
  footer: { position: 'absolute', left: 0, right: 0, bottom: 0, alignItems: 'center', gap: 24 },
  buttons: { flexDirection: 'row', justifyContent: 'space-around', alignSelf: 'stretch', paddingHorizontal: 40 },
  callItem: { alignItems: 'center', gap: 10 },
  callBtn: { width: 78, height: 78, borderRadius: 39, alignItems: 'center', justifyContent: 'center' },
  replay: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.14)' },
});

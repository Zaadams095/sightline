import { router, useLocalSearchParams } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useVideoPlayer, VideoView } from 'expo-video';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { T } from '@/components/ui/primitives';
import { useApp } from '@/state/store';
import { formatClock, formatDay } from '@/util/format';
import { shareLocalFile } from '@/util/share';

/** Plays a downloaded clip from the phone's storage; works with no connection to home. */
export default function OfflineClip() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const clip = useApp((s) => s.savedClips.find((c) => c.id === id));
  const insets = useSafeAreaInsets();
  const player = useVideoPlayer(clip?.localUri ?? null, (p) => p.play());

  return (
    <View style={styles.root}>
      <VideoView player={player} style={StyleSheet.absoluteFill} contentFit="contain" nativeControls allowsPictureInPicture />
      <View style={[styles.top, { top: insets.top + 6 }]}>
        <Pressable onPress={() => router.back()} hitSlop={8} accessibilityRole="button" accessibilityLabel="Close" style={styles.round}>
          <SymbolView name="xmark" tintColor="#fff" size={18} />
        </Pressable>
        <View style={{ flex: 1, alignItems: 'center' }}>
          <T v="label" color="#fff" numberOfLines={1}>
            {clip?.title ?? 'Clip'}
          </T>
          {clip && (
            <T v="caption" color="rgba(255,255,255,0.7)">
              {clip.cameraName} · {formatDay(clip.start)} {formatClock(clip.start)}
            </T>
          )}
        </View>
        {clip?.localUri && (
          <Pressable
            onPress={() => shareLocalFile(clip.localUri!, clip.cameraName)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Share video"
            style={styles.round}>
            <SymbolView name="square.and.arrow.up" tintColor="#fff" size={17} />
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  top: { position: 'absolute', left: 12, right: 12, flexDirection: 'row', alignItems: 'center', gap: 10 },
  round: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.14)', alignItems: 'center', justifyContent: 'center' },
});

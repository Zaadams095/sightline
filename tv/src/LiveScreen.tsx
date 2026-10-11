import { useEvent } from 'expo';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect, useState } from 'react';
import { Image, StyleSheet, Text, View, useTVEventHandler } from 'react-native';

import { liveUrl, snapshotUrl, type HubCamera } from './hub';
import { colors } from './theme';

/**
 * Full-screen live view: the Hub's HLS stream in AVPlayer (tvOS has no WebView, so no MSE).
 * If the stream can't play, a snapshot refreshing every two seconds stands in. Left/right on
 * the remote switches cameras; Menu goes back (handled by the caller).
 */
export function LiveScreen({
  base,
  token,
  cameras,
  index,
  onIndex,
}: {
  base: string;
  token: string;
  cameras: HubCamera[];
  index: number;
  onIndex: (i: number) => void;
}) {
  const camera = cameras[index];
  const player = useVideoPlayer(liveUrl(base, token, camera.id), (p) => {
    p.muted = false;
    p.play();
  });
  const { status } = useEvent(player, 'statusChange', { status: player.status });
  const failed = status === 'error';

  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (!failed) return;
    const t = setInterval(() => setTick(Date.now()), 2000);
    return () => clearInterval(t);
  }, [failed]);

  useTVEventHandler((evt) => {
    if (evt.eventType === 'right') onIndex((index + 1) % cameras.length);
    else if (evt.eventType === 'left') onIndex((index - 1 + cameras.length) % cameras.length);
  });

  return (
    <View style={styles.root}>
      {failed ? (
        <Image source={{ uri: snapshotUrl(base, token, camera.id, 1080, tick) }} style={StyleSheet.absoluteFill} resizeMode="contain" />
      ) : (
        <VideoView player={player} style={StyleSheet.absoluteFill} contentFit="contain" nativeControls={false} />
      )}
      <View style={styles.label}>
        <Text style={styles.name}>{camera.name}</Text>
        <Text style={styles.hint}>
          {failed ? 'Live video unavailable — showing snapshots' : status === 'loading' ? 'Connecting…' : 'Live'}
          {cameras.length > 1 ? '   ◀ ▶ other cameras' : ''}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  label: { position: 'absolute', left: 64, bottom: 56, paddingHorizontal: 28, paddingVertical: 16, borderRadius: 18, backgroundColor: 'rgba(0,0,0,0.55)' },
  name: { color: colors.text, fontSize: 40, fontWeight: '700' },
  hint: { color: colors.textMuted, fontSize: 24, marginTop: 4 },
});

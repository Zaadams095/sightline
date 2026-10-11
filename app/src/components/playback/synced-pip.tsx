import { useQuery } from '@tanstack/react-query';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect, useMemo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { T } from '@/components/ui/primitives';
import type { CameraSystemAdapter } from '@/systems/types';
import { seekPlayer, setPlayerRate } from '@/util/player';
import { clipSegments, playerToWall, wallToPlayer } from '@/util/vod-time';

const MAX_DRIFT_SEC = 1.2;

interface Props {
  adapter: CameraSystemAdapter;
  cameraId: string;
  name: string;
  winStart: number;
  winEnd: number;
  /** Wall-clock time of the main player. */
  wall: number;
  playing: boolean;
  rate: number;
  width: number;
  onPress: () => void;
}

/**
 * A neighbor camera playing the same moment as the main player. It loads the same
 * window and corrects itself whenever it drifts more than ~1 s from the main wall clock.
 */
export function SyncedPip({ adapter, cameraId, name, winStart, winEnd, wall, playing, rate, width, onPress }: Props) {
  const segQuery = useQuery({
    queryKey: ['segments', adapter.config.id, cameraId, winStart, winEnd],
    queryFn: () => adapter.recordingSegments!(cameraId, winStart, winEnd),
    enabled: !!adapter.recordingSegments,
  });
  const segments = useMemo(() => clipSegments(segQuery.data ?? [], winStart, winEnd), [segQuery.data, winStart, winEnd]);

  const source = adapter.playback?.(cameraId, winStart, winEnd).uri ?? null;
  const player = useVideoPlayer(source, (p) => {
    p.muted = true;
  });

  const covered = segments.some((s) => wall >= s.start && wall <= s.end);

  useEffect(() => {
    if (!segments.length || player.status !== 'readyToPlay') return;
    if (!covered) {
      player.pause();
      return;
    }
    const target = wallToPlayer(segments, wall);
    if (Math.abs(playerToWall(segments, player.currentTime) - wall) > MAX_DRIFT_SEC) seekPlayer(player, target);
    setPlayerRate(player, rate);
    if (playing) player.play();
    else player.pause();
  }, [wall, playing, rate, segments, covered, player]);

  const h = width * (9 / 16);
  return (
    <Pressable onPress={onPress} style={[styles.root, { width, height: h }]}>
      <VideoView player={player} style={StyleSheet.absoluteFill} contentFit="cover" nativeControls={false} />
      {!covered && (
        <View style={[StyleSheet.absoluteFill, styles.center]}>
          <T v="caption" color="rgba(255,255,255,0.6)">
            No recording
          </T>
        </View>
      )}
      <View style={styles.label}>
        <T v="caption" color="#fff" numberOfLines={1}>
          {name}
        </T>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { borderRadius: 10, overflow: 'hidden', backgroundColor: '#111', borderWidth: 1, borderColor: 'rgba(255,255,255,0.25)' },
  center: { alignItems: 'center', justifyContent: 'center' },
  label: { position: 'absolute', left: 6, bottom: 4, right: 6 },
});

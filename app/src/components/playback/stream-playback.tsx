import { useQuery } from '@tanstack/react-query';
import { useEvent, useEventListener } from 'expo';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect, useRef } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { LiveView } from '@/components/live/live-view';
import { T } from '@/components/ui/primitives';
import { resolveLive } from '@/systems/live';
import type { CameraSystemAdapter } from '@/systems/types';
import { seekPlayer, setPlayerRate } from '@/util/player';

/** How long each stream request covers; seeking past it just asks for a new one. */
const STREAM_SPAN_SEC = 3600;

interface Props {
  adapter: CameraSystemAdapter;
  cameraId: string;
  /** Wall-clock time (unix s) the stream should start from. Changing it reopens the stream. */
  start: number;
  paused: boolean;
  rate: number;
  onWall: (t: number) => void;
  onPlaying: (playing: boolean) => void;
}

/**
 * Plays recordings from systems that stream forward from a start time (RTSP playback,
 * exported MP4s, HLS clips) rather than offering one seekable playlist. Seeking = new start.
 */
export function StreamPlayback({ adapter, cameraId, start, paused, rate, onWall, onPlaying }: Props) {
  const source = useQuery({
    queryKey: ['stream-playback', adapter.config.id, cameraId, Math.floor(start)],
    queryFn: async () => {
      const pb = await adapter.playback!(cameraId, start, start + STREAM_SPAN_SEC);
      if (pb.kind !== 'stream') throw new Error('Unexpected playback type');
      const s = pb.source;
      // Whole recorded files may begin before `start`; remember when, to seek and keep time.
      if (s.kind === 'file') return { kind: 'file' as const, uri: s.uri, fileStart: s.startTime ?? start };
      return { kind: 'live' as const, live: await resolveLive(s, adapter.config) };
    },
    staleTime: Infinity,
    retry: 1,
  });

  if (source.isError) {
    return (
      <View style={[StyleSheet.absoluteFill, styles.center]}>
        <T color="#fff">{source.error instanceof Error ? source.error.message : 'Couldn’t play this recording'}</T>
      </View>
    );
  }
  if (!source.data) {
    return (
      <View style={[StyleSheet.absoluteFill, styles.center]}>
        <ActivityIndicator color="#fff" />
      </View>
    );
  }
  if (source.data.kind === 'file') {
    return (
      <FileStream
        key={`${source.data.uri}@${start}`}
        uri={source.data.uri}
        fileStart={source.data.fileStart}
        start={start}
        paused={paused}
        rate={rate}
        onWall={onWall}
        onPlaying={onPlaying}
      />
    );
  }
  return <LiveStream key={`${start}`} live={source.data.live} start={start} onWall={onWall} onPlaying={onPlaying} />;
}

/** MP4/HLS file: wall clock = file start + position; opens at the requested moment. */
function FileStream({
  uri,
  fileStart,
  start,
  paused,
  rate,
  onWall,
  onPlaying,
}: { uri: string; fileStart: number } & Omit<Props, 'adapter' | 'cameraId'>) {
  const player = useVideoPlayer(uri, (p) => {
    p.timeUpdateEventInterval = 0.25;
    p.play();
  });
  const offset = Math.max(0, start - fileStart);
  const sought = useRef(false);
  useEventListener(player, 'statusChange', ({ status }) => {
    if (status === 'readyToPlay' && !sought.current && offset > 0) {
      sought.current = true;
      seekPlayer(player, offset);
    }
  });
  const { isPlaying } = useEvent(player, 'playingChange', { isPlaying: player.playing });
  useEventListener(player, 'timeUpdate', ({ currentTime }) => onWall(fileStart + currentTime));
  useEffect(() => onPlaying(isPlaying), [isPlaying, onPlaying]);
  useEffect(() => {
    if (paused) player.pause();
    else player.play();
  }, [paused, player]);
  useEffect(() => {
    setPlayerRate(player, rate);
  }, [rate, player]);
  return <VideoView player={player} style={StyleSheet.absoluteFill} contentFit="contain" nativeControls={false} />;
}

/** RTSP/MSE playback streams play in real time; wall clock advances from when video starts. */
function LiveStream({ live, start, onWall, onPlaying }: { live: Parameters<typeof LiveView>[0]['live'] } & Pick<Props, 'start' | 'onWall' | 'onPlaying'>) {
  const startedAt = useRef<number | null>(null);
  useEffect(() => {
    const id = setInterval(() => {
      if (startedAt.current != null) onWall(start + (Date.now() - startedAt.current) / 1000);
    }, 250);
    return () => clearInterval(id);
  }, [start, onWall]);
  return (
    <LiveView
      live={live}
      muted={false}
      onState={(s) => {
        if (s === 'playing' && startedAt.current == null) startedAt.current = Date.now();
        onPlaying(s === 'playing');
      }}
    />
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center', padding: 16 },
});

import { useQuery } from '@tanstack/react-query';
import { useEvent, useEventListener } from 'expo';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect, useRef } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { LiveView } from '@/components/live/live-view';
import { T } from '@/components/ui/primitives';
import { releaseLiveUrl, resolveLive } from '@/systems/live';
import type { CameraSystemAdapter } from '@/systems/types';
import { userMessage } from '@/util/errors';
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
    queryFn: async ({ signal }) => {
      const pb = await adapter.playback!(cameraId, start, start + STREAM_SPAN_SEC);
      if (pb.kind !== 'stream') throw new Error('Unexpected playback type');
      const s = pb.source;
      // Whole recorded files may begin before `start`; remember when, to seek and keep time.
      if (s.kind === 'file') return { kind: 'file' as const, uri: s.uri, fileStart: s.startTime ?? start };
      const live = await resolveLive(s, adapter.config);
      // Closed or seeked away while the restreamer was starting: nothing will ever show (or
      // release) this one, so stop it now.
      if (signal.aborted && s.kind === 'rtsp') {
        releaseLiveUrl(s.url);
        throw new Error('Cancelled');
      }
      return { kind: 'live' as const, live, begin: pb.startTime ?? start, rtspUrl: s.kind === 'rtsp' ? s.url : undefined };
    },
    staleTime: Infinity,
    // The restreamer is released on unmount, so never reuse a cached source afterwards.
    gcTime: 0,
    retry: 1,
  });

  // Each playback start is its own RTSP URL; free its restreamer when we move on.
  const rtspUrl = source.data?.kind === 'live' ? source.data.rtspUrl : undefined;
  useEffect(() => {
    if (!rtspUrl) return;
    return () => releaseLiveUrl(rtspUrl);
  }, [rtspUrl]);

  if (source.isError) {
    return (
      <View style={[StyleSheet.absoluteFill, styles.center]}>
        <T color="#fff" overlay style={{ textAlign: 'center' }}>
          {userMessage(source.error, adapter.config.name)}
        </T>
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
  return <LiveStream key={`${start}`} live={source.data.live} start={source.data.begin} onWall={onWall} onPlaying={onPlaying} />;
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

/**
 * RTSP/MSE playback streams play in real time; wall clock advances only while video is
 * actually playing, so time spent stalled or buffering doesn't run the clock ahead.
 */
function LiveStream({ live, start, onWall, onPlaying }: { live: Parameters<typeof LiveView>[0]['live'] } & Pick<Props, 'start' | 'onWall' | 'onPlaying'>) {
  // Milliseconds played before the current run, and when the current run began (null = stalled).
  const played = useRef(0);
  const runningSince = useRef<number | null>(null);
  const started = useRef(false);
  useEffect(() => {
    const id = setInterval(() => {
      if (!started.current) return;
      const run = runningSince.current != null ? Date.now() - runningSince.current : 0;
      onWall(start + (played.current + run) / 1000);
    }, 250);
    return () => clearInterval(id);
  }, [start, onWall]);
  return (
    <LiveView
      live={live}
      muted={false}
      onState={(s) => {
        if (s === 'playing') {
          started.current = true;
          runningSince.current ??= Date.now();
        } else if (runningSince.current != null) {
          played.current += Date.now() - runningSince.current;
          runningSince.current = null;
        }
        onPlaying(s === 'playing');
      }}
    />
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center', padding: 16 },
});

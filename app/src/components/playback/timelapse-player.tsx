import { useQuery } from '@tanstack/react-query';
import { useEventListener } from 'expo';
import { SymbolView } from 'expo-symbols';
import { useVideoPlayer, VideoView, type VideoPlayer } from 'expo-video';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { LiveView } from '@/components/live/live-view';
import { TimelapseScrubber } from '@/components/playback/timelapse-scrubber';
import { T } from '@/components/ui/primitives';
import { releaseLiveUrl, resolveLive, type ResolvedLive } from '@/systems/live';
import type { CameraSystemAdapter, RecordingSegment, ReviewItem } from '@/systems/types';
import { formatClock } from '@/util/format';
import { seekPlayer, setPlayerRate } from '@/util/player';
import {
  chunkAt,
  CHUNK_SEC,
  clipSpans,
  planVod,
  sampleIndexAt,
  spanPlayerToWall,
  spanWallToPlayer,
  streamSteps,
} from '@/util/timelapse';

interface Props {
  adapter: CameraSystemAdapter;
  cameraId: string;
  start: number;
  end: number;
  events: ReviewItem[];
  videoHeight: number;
}

/** Seconds each step is shown for forward-only recordings (enough for the stream to start). */
const STEP_DWELL_MS = 4500;

/**
 * Seekable recordings: short windows play straight through fast; long ones play a short
 * burst every few minutes of recorded time. Long windows load in CHUNK_SEC playlists.
 */
export function VodTimelapse({ adapter, cameraId, start, end, events, videoHeight }: Props) {
  const segQ = useQuery({
    queryKey: ['timelapse-segments', adapter.config.id, cameraId, start, end],
    queryFn: async (): Promise<RecordingSegment[]> =>
      adapter.recordingSegments ? adapter.recordingSegments(cameraId, start, end) : [{ start, end }],
    staleTime: 60_000,
  });
  const spans = useMemo(() => clipSpans(segQ.data ?? [], start, end), [segQ.data, start, end]);
  const plan = useMemo(() => planVod(spans, { straightThrough: end - start <= CHUNK_SEC }), [spans, start, end]);

  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [wall, setWall] = useState(start);
  const finished = plan?.mode === 'jump' && idx >= plan.samples.length;
  const sample = plan?.mode === 'jump' ? plan.samples[Math.min(idx, plan.samples.length - 1)] : undefined;
  const chunk = chunkAt(start, end, sample?.wall ?? start);
  const chunkSpans = useMemo(() => clipSpans(spans, chunk.start, chunk.end), [spans, chunk.start, chunk.end]);

  const src = useQuery({
    queryKey: ['timelapse-source', adapter.config.id, cameraId, chunk.start, chunk.end],
    queryFn: () => adapter.playback!(cameraId, chunk.start, chunk.end),
    enabled: !!plan,
    staleTime: Infinity,
  });
  const uri = src.data?.kind === 'vod' ? src.data.uri : null;
  const player = useVideoPlayer(uri, (p) => {
    p.muted = true;
    p.timeUpdateEventInterval = 0.25;
  });
  // A new chunk is a new player: only trust a "ready" that came from this one.
  const [readyPlayer, setReadyPlayer] = useState<VideoPlayer | null>(null);
  useEventListener(player, 'statusChange', ({ status }) => setReadyPlayer(status === 'readyToPlay' ? player : null));
  const ready = readyPlayer === player;

  useEventListener(player, 'timeUpdate', ({ currentTime }) => {
    if (chunkSpans.length) setWall(spanPlayerToWall(chunkSpans, currentTime));
  });
  useEventListener(player, 'playToEnd', () => {
    if (plan?.mode === 'rate') setPlaying(false);
  });

  // Straight through, fast.
  useEffect(() => {
    if (plan?.mode !== 'rate' || !ready) return;
    setPlayerRate(player, plan.rate);
    if (playing) player.play();
    else player.pause();
  }, [plan, ready, playing, player]);

  // Jumping: seek to each sample, play a burst, move on.
  useEffect(() => {
    if (plan?.mode !== 'jump' || !ready) return;
    if (!playing || !sample || finished) {
      player.pause();
      return;
    }
    seekPlayer(player, spanWallToPlayer(chunkSpans, sample.wall));
    setPlayerRate(player, plan.rate);
    player.play();
    const t = setTimeout(() => setIdx((i) => i + 1), plan.dwellSec * 1000);
    return () => clearTimeout(t);
  }, [plan, ready, playing, sample, finished, chunkSpans, player]);

  const seek = (t: number) => {
    setWall(t);
    if (plan?.mode === 'jump') setIdx(sampleIndexAt(plan.samples, t));
    else if (ready) seekPlayer(player, spanWallToPlayer(chunkSpans, t));
  };
  const toggle = () => {
    if (finished) {
      setIdx(0);
      setPlaying(true);
    } else if (plan?.mode === 'rate' && !playing && player.currentTime >= player.duration - 0.5) {
      seekPlayer(player, 0);
      setPlaying(true);
    } else {
      setPlaying((v) => !v);
    }
  };

  const empty = segQ.isSuccess && !plan;
  const caption = !plan
    ? ''
    : plan.mode === 'rate'
      ? `Playing ${plan.rate}× faster · about ${Math.max(1, Math.round(plan.durationSec / 60))} min`
      : `A moment from every ${everyLabel(plan.samples)} of recording · about ${Math.round(plan.durationSec)} s`;

  return (
    <Frame
      videoHeight={videoHeight}
      video={uri ? <VideoView player={player} style={StyleSheet.absoluteFill} contentFit="contain" nativeControls={false} /> : null}
      loading={!empty && (!ready || segQ.isLoading)}
      message={
        empty
          ? 'No recordings in this period'
          : segQ.isError || src.isError || (src.isSuccess && !uri)
            ? 'Couldn’t load the recording'
            : null
      }
      wall={wall}
      start={start}
      end={end}
      segments={spans}
      events={events}
      playing={playing && !finished}
      finished={finished}
      caption={caption}
      onSeek={seek}
      onToggle={toggle}
    />
  );
}

function everyLabel(samples: { player: number }[]): string {
  const every = samples.length > 1 ? samples[1].player - samples[0].player : 0;
  if (every < 90) return `${Math.max(1, Math.round(every))} seconds`;
  if (every < 5400) return `${Math.round(every / 60)} minutes`;
  return `${Math.round(every / 3600)} hours`;
}

type StepSource = { kind: 'live'; live: ResolvedLive; rtspUrl?: string } | { kind: 'file'; uri: string };

/**
 * Forward-only recordings (an RTSP playback URL, an exported file…): show a few seconds from
 * the start of each step (every 15 min for short windows, every hour for a day).
 */
export function StreamTimelapse({ adapter, cameraId, start, end, events, videoHeight }: Props) {
  const steps = useMemo(() => streamSteps(start, end), [start, end]);
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(true);
  const finished = idx >= steps.length;
  const step = steps[Math.min(idx, steps.length - 1)];

  const src = useQuery({
    queryKey: ['timelapse-step', adapter.config.id, cameraId, step.start, step.end],
    queryFn: async ({ signal }): Promise<StepSource> => {
      // Forward-only sources play from the start, so a minute is plenty (and keeps exports small).
      const pb = await adapter.playback!(cameraId, step.start, Math.min(step.end, step.start + 60));
      if (pb.kind === 'vod') return { kind: 'file', uri: pb.uri };
      if (pb.source.kind === 'file') return { kind: 'file', uri: pb.source.uri };
      const rtspUrl = pb.source.kind === 'rtsp' ? pb.source.url : undefined;
      const live = await resolveLive(pb.source, adapter.config);
      // Moved to another step (or closed) while it started: nothing else would release it.
      if (signal.aborted && rtspUrl) {
        releaseLiveUrl(rtspUrl);
        throw new Error('Cancelled');
      }
      return { kind: 'live', live, rtspUrl };
    },
    staleTime: 0,
    gcTime: 0,
    retry: 0,
  });

  // Drop the previous step's restreamer once we've moved on.
  const rtspUrl = src.data?.kind === 'live' ? src.data.rtspUrl : undefined;
  useEffect(() => () => {
    if (rtspUrl) releaseLiveUrl(rtspUrl);
  }, [rtspUrl]);

  const settled = src.isSuccess || src.isError;
  useEffect(() => {
    if (!playing || finished || !settled) return;
    const t = setTimeout(() => setIdx((i) => i + 1), src.isError ? 800 : STEP_DWELL_MS);
    return () => clearTimeout(t);
  }, [playing, finished, settled, src.isError, idx]);

  const seek = (t: number) => {
    const i = steps.findIndex((s) => t >= s.start && t < s.end);
    setIdx(i < 0 ? steps.length - 1 : i);
  };
  const toggle = () => {
    if (finished) {
      setIdx(0);
      setPlaying(true);
    } else setPlaying((v) => !v);
  };

  const stepMin = Math.round((steps[0]?.end - steps[0]?.start) / 60);
  return (
    <Frame
      videoHeight={videoHeight}
      video={
        finished ? null : src.data?.kind === 'live' ? (
          <LiveView live={src.data.live} />
        ) : src.data?.kind === 'file' ? (
          <FileClip uri={src.data.uri} />
        ) : null
      }
      loading={!finished && !settled}
      message={src.isError ? `No video at ${formatClock(step.start)}` : null}
      wall={finished ? end : step.start}
      start={start}
      end={end}
      segments={[]}
      events={events}
      playing={playing && !finished}
      finished={finished}
      caption={`A few seconds from every ${stepMin >= 60 ? 'hour' : `${stepMin} minutes`} · this recorder can’t fast-forward`}
      onSeek={seek}
      onToggle={toggle}
    />
  );
}

function FileClip({ uri }: { uri: string }) {
  const player = useVideoPlayer(uri, (p) => {
    p.muted = true;
    p.play();
  });
  return <VideoView player={player} style={StyleSheet.absoluteFill} contentFit="contain" nativeControls={false} />;
}

function Frame({
  videoHeight,
  video,
  loading,
  message,
  wall,
  start,
  end,
  segments,
  events,
  playing,
  finished,
  caption,
  onSeek,
  onToggle,
}: {
  videoHeight: number;
  video: React.ReactNode;
  loading: boolean;
  message: string | null;
  wall: number;
  start: number;
  end: number;
  segments: RecordingSegment[];
  events: ReviewItem[];
  playing: boolean;
  finished: boolean;
  caption: string;
  onSeek: (t: number) => void;
  onToggle: () => void;
}) {
  return (
    <View style={{ gap: 14 }}>
      <View style={{ height: videoHeight, backgroundColor: '#000' }}>
        {video}
        {(loading || message) && (
          <View style={[StyleSheet.absoluteFill, styles.center]} pointerEvents="none">
            {message ? <T color="#fff">{message}</T> : <ActivityIndicator color="#fff" />}
          </View>
        )}
      </View>
      <View style={styles.clockRow}>
        <T v="title" color="#fff">
          {formatClock(wall)}
        </T>
        <Pressable onPress={onToggle} hitSlop={8} style={styles.play} accessibilityLabel={finished ? 'Play again' : playing ? 'Pause' : 'Play'}>
          <SymbolView name={finished ? 'arrow.counterclockwise' : playing ? 'pause.fill' : 'play.fill'} tintColor="#fff" size={24} />
        </Pressable>
      </View>
      <TimelapseScrubber start={start} end={end} time={wall} segments={segments} events={events} onSeek={onSeek} />
      {!!caption && (
        <T v="caption" color="rgba(255,255,255,0.6)" style={{ textAlign: 'center', paddingHorizontal: 24 }}>
          {caption}
        </T>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
  clockRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20 },
  play: { width: 56, height: 56, borderRadius: 28, backgroundColor: 'rgba(255,255,255,0.16)', alignItems: 'center', justifyContent: 'center' },
});

import { useQuery } from '@tanstack/react-query';
import { useEventListener } from 'expo';
import { Image } from 'expo-image';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect, useMemo, useRef } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { StreamPlayback } from '@/components/playback/stream-playback';
import { T } from '@/components/ui/primitives';
import type { CameraSystemAdapter } from '@/systems/types';
import { seekPlayer } from '@/util/player';
import { clipSegments, playerToWall, wallToPlayer } from '@/util/vod-time';

/** Extra seconds of recording requested around a step, so seeking has room. */
const PAD = 30;
/** How long a step with no playable video shows its picture. */
const STILL_SEC = 3;

interface Props {
  adapter: CameraSystemAdapter | null;
  cameraId: string;
  /** Wall-clock span of the step to play (unix s). */
  from: number;
  to: number;
  playing: boolean;
  thumbnailUrl?: string;
  onWall: (t: number) => void;
  /** Called once when the step has played through (or can't be played). */
  onDone: () => void;
}

/**
 * Plays one camera's part of a story with the app's usual sources (seekable vod or forward
 * streams), whatever the brand. Steps it can't play show their picture briefly instead.
 */
export function StepPlayer(props: Props) {
  const { adapter, cameraId, from, to } = props;
  // A stable callback for children whose effects depend on it.
  const doneRef = useRef(false);
  const onDoneRef = useRef(props.onDone);
  const onWallRef = useRef(props.onWall);
  useEffect(() => {
    onDoneRef.current = props.onDone;
    onWallRef.current = props.onWall;
  });
  const handlers = useMemo(
    () => ({
      done: () => {
        if (doneRef.current) return;
        doneRef.current = true;
        onDoneRef.current();
      },
      wall: (t: number) => {
        onWallRef.current(t);
        if (t >= to) {
          if (!doneRef.current) {
            doneRef.current = true;
            onDoneRef.current();
          }
        }
      },
    }),
    [to],
  );

  const source = useQuery({
    queryKey: ['story-playback', adapter?.config.id, cameraId, from - PAD, to + PAD],
    queryFn: () => adapter!.playback!(cameraId, from - PAD, to + PAD),
    enabled: !!adapter?.playback,
    staleTime: Infinity,
    retry: 1,
  });

  if (!adapter?.playback || source.isError) {
    return <Still {...props} onDone={handlers.done} message={!adapter ? 'Can’t reach this recorder right now' : 'This recording can’t be played here'} />;
  }
  if (!source.data) {
    return (
      <View style={[StyleSheet.absoluteFill, styles.center]}>
        <ActivityIndicator color="#fff" />
      </View>
    );
  }
  if (source.data.kind === 'vod') {
    return <VodStep adapter={adapter} cameraId={cameraId} uri={source.data.uri} from={from} to={to} playing={props.playing} onWall={handlers.wall} onDone={handlers.done} />;
  }
  return (
    <StreamPlayback adapter={adapter} cameraId={cameraId} start={from} paused={!props.playing} rate={1} onWall={handlers.wall} onPlaying={noop} />
  );
}

function noop() {}

function VodStep({
  adapter,
  cameraId,
  uri,
  from,
  to,
  playing,
  onWall,
  onDone,
}: {
  adapter: CameraSystemAdapter;
  cameraId: string;
  uri: string;
  from: number;
  to: number;
  playing: boolean;
  onWall: (t: number) => void;
  onDone: () => void;
}) {
  const winStart = from - PAD;
  const winEnd = to + PAD;
  const segQuery = useQuery({
    queryKey: ['segments', adapter.config.id, cameraId, winStart, winEnd],
    queryFn: () => adapter.recordingSegments!(cameraId, winStart, winEnd),
    enabled: !!adapter.recordingSegments,
  });
  // Without a recording list, assume the playlist covers the window without gaps.
  const segments = useMemo(
    () => (segQuery.data ? clipSegments(segQuery.data, winStart, winEnd) : [{ start: winStart, end: winEnd }]),
    [segQuery.data, winStart, winEnd],
  );
  const known = !adapter.recordingSegments || segQuery.isFetched;
  const empty = !!segQuery.data && segments.length === 0;
  const player = useVideoPlayer(uri, (p) => {
    p.timeUpdateEventInterval = 0.25;
  });
  const sought = useRef(false);

  const start = () => {
    if (sought.current || !known || player.status !== 'readyToPlay') return;
    sought.current = true;
    seekPlayer(player, wallToPlayer(segments, from));
    if (playing) player.play();
  };
  useEventListener(player, 'statusChange', start);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(start, [known, segments, player]);
  useEffect(() => {
    if (!sought.current) return;
    if (playing) player.play();
    else player.pause();
  }, [playing, player]);
  useEventListener(player, 'timeUpdate', ({ currentTime }) => {
    if (sought.current) onWall(playerToWall(segments, currentTime));
  });
  useEventListener(player, 'playToEnd', onDone);
  useEffect(() => {
    if (!empty || !playing) return;
    const t = setTimeout(onDone, STILL_SEC * 1000);
    return () => clearTimeout(t);
  }, [empty, playing, onDone]);

  return (
    <>
      <VideoView player={player} style={StyleSheet.absoluteFill} contentFit="contain" nativeControls={false} />
      {empty && (
        <View style={[StyleSheet.absoluteFill, styles.center]}>
          <T color="#fff">No recording from this camera at that time</T>
        </View>
      )}
    </>
  );
}

function Still({ thumbnailUrl, playing, onDone, message }: Props & { message: string }) {
  useEffect(() => {
    if (!playing) return;
    const t = setTimeout(onDone, STILL_SEC * 1000);
    return () => clearTimeout(t);
  }, [playing, onDone]);
  return (
    <View style={[StyleSheet.absoluteFill, styles.center]}>
      {thumbnailUrl ? <Image source={{ uri: thumbnailUrl }} style={StyleSheet.absoluteFill} contentFit="contain" /> : null}
      <View style={styles.badge}>
        <T v="caption" color="#fff">
          {message}
        </T>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center', padding: 16 },
  badge: { position: 'absolute', bottom: 10, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8, backgroundColor: 'rgba(0,0,0,0.55)' },
});

import { useEventListener } from 'expo';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import type { LiveState } from '@/components/live/live-player';
import { DEFAULT_VIEW, useDemoPtz } from '@/systems/demo/ptz';

interface Props {
  uri: string;
  /** A wide video the camera's move controls pan across (sample cameras). */
  pan?: { key: string; aspect: number };
  fit: 'contain' | 'cover';
  poster?: React.ReactNode;
  onState?: (s: LiveState) => void;
}

/** A short video on repeat, used as the "live" view of the built-in sample cameras. */
export function LoopLive({ uri, pan, fit, poster, onState }: Props) {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = true;
    p.muted = true;
    p.play();
  });
  const [playing, setPlaying] = useState(false);
  const last = useRef<LiveState | null>(null);
  const report = (s: LiveState) => {
    if (last.current === s) return;
    last.current = s;
    onState?.(s);
  };
  useEventListener(player, 'statusChange', ({ status }) => {
    if (status === 'error') report('error');
    else if (status === 'loading' && !playing) report('connecting');
  });
  useEventListener(player, 'playingChange', ({ isPlaying }) => {
    if (isPlaying) setPlaying(true);
    // Looping briefly reports "not playing" at the seam; that isn't a stall.
    if (isPlaying) report('playing');
  });

  const view = useDemoPtz((s) => (pan ? s.views[pan.key] : undefined)) ?? DEFAULT_VIEW;
  const [box, setBox] = useState({ w: 0, h: 0 });

  let video: React.ReactNode;
  if (!pan) {
    video = <VideoView player={player} style={StyleSheet.absoluteFill} contentFit={fit} nativeControls={false} />;
  } else if (box.w > 0) {
    // Cover the view, scaled by zoom, then slide the window across the wide picture.
    const baseH = Math.max(box.h, box.w / pan.aspect);
    const h = baseH * view.zoom;
    const w = h * pan.aspect;
    const left = -(w - box.w) * ((view.pan + 1) / 2);
    const top = -(h - box.h) * ((view.tilt + 1) / 2);
    video = (
      <View style={{ position: 'absolute', left, top, width: w, height: h }}>
        <VideoView player={player} style={StyleSheet.absoluteFill} contentFit="fill" nativeControls={false} />
      </View>
    );
  }

  return (
    <View
      style={[StyleSheet.absoluteFill, styles.root]}
      onLayout={pan ? (e) => setBox({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height }) : undefined}>
      {video}
      {!playing && poster && (
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          {poster}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { overflow: 'hidden', backgroundColor: '#000' },
});

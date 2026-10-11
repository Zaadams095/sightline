import { useQuery } from '@tanstack/react-query';
import { useEventListener } from 'expo';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';

import { LivePlayer, type LiveState } from '@/components/live/live-player';
import { noteProblem } from '@/diagnostics/log';
import { useLinks, type LinkMode } from '@/net/connection';
import { resolveLive, type ResolvedLive } from '@/systems/live';
import type { CameraSystemAdapter } from '@/systems/types';
import { setPlayerMuted } from '@/util/player';

/** Resolves a live source, recording a failure (by brand) for diagnostics. */
async function resolveFor(adapter: CameraSystemAdapter, cameraId: string, quality: 'main' | 'sub'): Promise<ResolvedLive> {
  try {
    return { ...(await resolveLive(await adapter.liveStream(cameraId, { quality }), adapter.config)), brand: adapter.config.kind };
  } catch (e) {
    noteProblem('player', e, { brand: adapter.config.kind, feature: 'live-start' });
    throw e;
  }
}

/** Resolves a camera's live source (any brand) into something playable. Shared cache key. */
export function useLive(adapter: CameraSystemAdapter | null, cameraId: string, quality: 'main' | 'sub' = 'main', enabled = true) {
  return useQuery({
    queryKey: ['live', adapter?.config.id, cameraId, quality],
    queryFn: () => resolveFor(adapter!, cameraId, quality),
    enabled: enabled && !!adapter?.capabilities.live,
    staleTime: Infinity,
    retry: 1,
  });
}

/** Full quality on the home network; the lighter stream away (VPN, cellular) starts much faster. */
export function defaultLiveQuality(mode: LinkMode | undefined): 'main' | 'sub' {
  return mode === 'lan' ? 'main' : 'sub';
}

export function prefetchLiveOptions(adapter: CameraSystemAdapter, cameraId: string) {
  // Same choice the camera screen makes, so the prefetched stream is the one it opens.
  const quality = defaultLiveQuality(useLinks.getState().links[adapter.config.id]?.mode);
  return {
    queryKey: ['live', adapter.config.id, cameraId, quality],
    queryFn: () => resolveFor(adapter, cameraId, quality),
    staleTime: Infinity,
  };
}

interface Props {
  live: ResolvedLive;
  muted?: boolean;
  fit?: 'contain' | 'cover';
  poster?: React.ReactNode;
  onState?: (s: LiveState) => void;
  timingLabel?: string;
  openedAt?: number;
}

/** Plays any resolved live source: go2rtc MSE, HLS, or MJPEG. All report `onState`. */
export function LiveView({ live, muted = true, fit = 'contain', onState, ...rest }: Props) {
  if (live.kind === 'mse') return <LivePlayer wsUrl={live.wsUrl} muted={muted} fit={fit} onState={onState} brand={live.brand} {...rest} />;
  // HLS and MJPEG report no reason, only that playback failed.
  const report = (s: LiveState) => {
    if (s === 'error') noteProblem('player', 'playback failed', { brand: live.brand, feature: `live-${live.kind}`, category: 'player-error' });
    onState?.(s);
  };
  if (live.kind === 'hls') return <HlsLive uri={live.uri} muted={muted} fit={fit} onState={report} />;
  return <MjpegLive uri={live.uri} fit={fit} onState={report} />;
}

/** Reports a state only when it changes (callers often pass a fresh callback each render). */
function useReporter(onState?: (s: LiveState) => void) {
  const last = useRef<LiveState | null>(null);
  return (s: LiveState) => {
    if (last.current === s) return;
    last.current = s;
    onState?.(s);
  };
}

function HlsLive({ uri, muted, fit, onState }: { uri: string; muted: boolean; fit: 'contain' | 'cover'; onState?: (s: LiveState) => void }) {
  const player = useVideoPlayer(uri, (p) => {
    p.muted = muted;
    p.play();
  });
  // The setup callback only runs once; later mute/unmute taps are applied here.
  useEffect(() => {
    setPlayerMuted(player, muted);
  }, [player, muted]);

  const report = useReporter(onState);
  const playedOnce = useRef(false);
  useEventListener(player, 'statusChange', ({ status }) => {
    if (status === 'error') report('error');
    else if (status === 'loading') report(playedOnce.current ? 'stalled' : 'connecting');
  });
  useEventListener(player, 'playingChange', ({ isPlaying }) => {
    if (isPlaying) playedOnce.current = true;
    report(isPlaying ? 'playing' : 'stalled');
  });
  return <VideoView player={player} style={StyleSheet.absoluteFill} contentFit={fit} nativeControls={false} />;
}

/** Motion-JPEG (older systems): WebKit renders it natively in an <img>. */
function MjpegLive({ uri, fit, onState }: { uri: string; fit: 'contain' | 'cover'; onState?: (s: LiveState) => void }) {
  const report = useReporter(onState);
  // The page reports the first decoded frame (playing) or a failed load (error).
  const html = `<html><body style="margin:0;background:#000"><img src="${uri.replace(/"/g, '&quot;')}" style="width:100%;height:100%;object-fit:${fit}"
    onload="window.ReactNativeWebView.postMessage('playing')" onerror="window.ReactNativeWebView.postMessage('error')"></body></html>`;
  return (
    <View style={StyleSheet.absoluteFill}>
      <WebView
        source={{ html }}
        style={{ flex: 1, backgroundColor: '#000' }}
        scrollEnabled={false}
        originWhitelist={['*']}
        onLoadStart={() => report('connecting')}
        onMessage={(e) => report(e.nativeEvent.data === 'error' ? 'error' : 'playing')}
      />
    </View>
  );
}

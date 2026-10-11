import { useQuery } from '@tanstack/react-query';
import { useVideoPlayer, VideoView } from 'expo-video';
import { StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';

import { LivePlayer, type LiveState } from '@/components/live/live-player';
import { resolveLive, type ResolvedLive } from '@/systems/live';
import type { CameraSystemAdapter } from '@/systems/types';

/** Resolves a camera's live source (any brand) into something playable. Shared cache key. */
export function useLive(adapter: CameraSystemAdapter | null, cameraId: string, quality: 'main' | 'sub' = 'main', enabled = true) {
  return useQuery({
    queryKey: ['live', adapter?.config.id, cameraId, quality],
    queryFn: async () => resolveLive(await adapter!.liveStream(cameraId, { quality }), adapter!.config),
    enabled: enabled && !!adapter?.capabilities.live,
    staleTime: Infinity,
    retry: 1,
  });
}

export function prefetchLiveOptions(adapter: CameraSystemAdapter, cameraId: string) {
  return {
    queryKey: ['live', adapter.config.id, cameraId, 'main'],
    queryFn: async () => resolveLive(await adapter.liveStream(cameraId, { quality: 'main' }), adapter.config),
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

/** Plays any resolved live source: go2rtc MSE, HLS, or MJPEG. */
export function LiveView({ live, muted = true, fit = 'contain', ...rest }: Props) {
  if (live.kind === 'mse') return <LivePlayer wsUrl={live.wsUrl} muted={muted} fit={fit} {...rest} />;
  if (live.kind === 'hls') return <HlsLive uri={live.uri} muted={muted} fit={fit} />;
  return <MjpegLive uri={live.uri} fit={fit} />;
}

function HlsLive({ uri, muted, fit }: { uri: string; muted: boolean; fit: 'contain' | 'cover' }) {
  const player = useVideoPlayer(uri, (p) => {
    p.muted = muted;
    p.play();
  });
  return <VideoView player={player} style={StyleSheet.absoluteFill} contentFit={fit} nativeControls={false} />;
}

/** Motion-JPEG (older systems): WebKit renders it natively in an <img>. */
function MjpegLive({ uri, fit }: { uri: string; fit: 'contain' | 'cover' }) {
  const html = `<html><body style="margin:0;background:#000"><img src="${uri.replace(/"/g, '&quot;')}" style="width:100%;height:100%;object-fit:${fit}"></body></html>`;
  return (
    <View style={StyleSheet.absoluteFill}>
      <WebView source={{ html }} style={{ flex: 1, backgroundColor: '#000' }} scrollEnabled={false} originWhitelist={['*']} />
    </View>
  );
}

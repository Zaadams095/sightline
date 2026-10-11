import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';

import { msePlayerHtml } from '@/components/live/mse-player-html';
import { noteProblem } from '@/diagnostics/log';
import { tr } from '@/i18n';
import { rememberPlayerCodecs, useLiveStats } from '@/state/live-stats';
import { acceptsCodecsInUrl, parseHubLiveStart } from '@/systems/hub-links';

export type LiveState = 'connecting' | 'playing' | 'stalled' | 'error';

interface Props {
  /** ws(s)://host:port/live/mse/api/ws?src=… from the adapter. */
  wsUrl: string;
  muted?: boolean;
  fit?: 'contain' | 'cover';
  /** Still image shown until the first frame arrives (instant perceived load). */
  poster?: React.ReactNode;
  /** For startup timing: camera label and when the user opened it (Date.now()). */
  timingLabel?: string;
  openedAt?: number;
  onState?: (s: LiveState) => void;
  /** System kind, for diagnostics. */
  brand?: string;
}

/** Low-latency live view via go2rtc MSE in a WKWebView. */
export function LivePlayer({ wsUrl, muted = true, fit = 'contain', poster, onState, timingLabel, openedAt, brand }: Props) {
  const setStats = useLiveStats((s) => s.set);
  const web = useRef<WebView>(null);
  const [state, setState] = useState<LiveState>('connecting');
  const [detail, setDetail] = useState<string>();

  const { origin, path } = useMemo(() => {
    const u = new URL(wsUrl);
    const httpOrigin = `${u.protocol === 'wss:' ? 'https' : 'http'}://${u.host}`;
    return { origin: httpOrigin, path: `${u.pathname}${u.search}` };
  }, [wsUrl]);

  // Muting changes are applied in place; rebuilding the page would reconnect the stream.
  const [initialMuted] = useState(muted);
  const html = useMemo(
    () => msePlayerHtml(path, { muted: initialMuted, fit, codecsInUrl: acceptsCodecsInUrl(path) }),
    [path, fit, initialMuted],
  );

  useEffect(() => {
    web.current?.injectJavaScript(`window.__setMuted && window.__setMuted(${muted}); true;`);
  }, [muted]);

  useEffect(
    () => () => {
      web.current?.injectJavaScript('window.__stop && window.__stop(); true;');
    },
    [],
  );

  return (
    <View style={styles.root}>
      <WebView
        ref={web}
        source={{ html, baseUrl: origin }}
        style={styles.web}
        originWhitelist={['*']}
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        allowsAirPlayForMediaPlayback={false}
        scrollEnabled={false}
        bounces={false}
        javaScriptEnabled
        // WebKit's own cache only adds latency for live media.
        cacheEnabled={false}
        onMessage={(e) => {
          try {
            const msg = JSON.parse(e.nativeEvent.data) as { type: string; value: LiveState; detail?: string };
            if (msg.type === ('codecs' as string)) {
              rememberPlayerCodecs(msg.value);
            } else if (msg.type === ('timing' as string) && openedAt && timingLabel) {
              const m = JSON.parse(msg.value) as Record<string, number> & { hub?: string };
              const page = m.t0 - openedAt;
              const at = (k: string) => (m[k] != null ? page + m[k] : undefined);
              setStats({
                camera: timingLabel,
                page,
                wsOpen: at('wsOpen'),
                codecs: at('codecs'),
                firstData: at('firstData'),
                playing: at('playing'),
                hub: parseHubLiveStart(m.hub),
              });
            } else if (msg.type === 'state') {
              if (msg.value === 'error' && state !== 'error') noteProblem('player', msg.detail ?? 'error', { brand, feature: 'live-mse' });
              setState(msg.value);
              setDetail(msg.detail);
              onState?.(msg.value);
            }
          } catch {}
        }}
      />
      {state !== 'playing' && (
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          {poster}
          <View style={styles.overlay}>
            {state === 'error' ? (
              <Text style={styles.msg} maxFontSizeMultiplier={1.3}>
                {liveErrorText(detail)}
              </Text>
            ) : (
              <ActivityIndicator color="#fff" />
            )}
          </View>
        </View>
      )}
    </View>
  );
}

/** The player's raw failure (go2rtc, WebKit) as something anyone can act on. */
export function liveErrorText(detail: string | undefined): string {
  const d = detail ?? '';
  const t = tr().viewing.live;
  if (/401|unauthori|wrong user|pass/i.test(d)) return t.badPassword;
  if (/codec|not supported|MSE/i.test(d)) return t.badFormat;
  if (/timeout|refused|no route|unreachable|EOF|closed/i.test(d)) return t.unreachable;
  return t.unavailable;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  web: { flex: 1, backgroundColor: '#000' },
  overlay: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center', justifyContent: 'center' },
  msg: { color: '#fff', fontSize: 13, fontWeight: '600', paddingHorizontal: 16, textAlign: 'center' },
});

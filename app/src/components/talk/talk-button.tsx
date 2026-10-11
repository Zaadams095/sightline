import * as Haptics from 'expo-haptics';
import { SymbolView } from 'expo-symbols';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Linking, Pressable, StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';

import { T } from '@/components/ui/primitives';
import { closeTalk, openTalk, type TalkRoute } from '@/talk/talk';
import { pressIn, pressOut, talkErrorText, talkLabel, type TalkPress, type TalkState } from '@/talk/talk-core';
import { talkPageHtml } from '@/talk/talk-page';

const RED = '#FF453A';

/**
 * Push-to-talk: hold to talk and let go to stop, or tap once to keep talking and tap again to
 * stop. The microphone runs in an invisible WebView on the tunnel library's loopback talk
 * endpoint, which sends the voice to the camera (or the Hub). Shown only for cameras that
 * said they take audio (useTalkRoute).
 */
export function TalkButton({
  route,
  variant = 'bar',
  onActiveChange,
}: {
  route: TalkRoute;
  variant?: 'bar' | 'call';
  /** Called when talking starts or stops (e.g. to turn the camera's sound on for a conversation). */
  onActiveChange?: (active: boolean) => void;
}) {
  const web = useRef<WebView>(null);
  const [port, setPort] = useState<number | null>(null);
  const [state, setState] = useState<TalkState>('idle');
  const [mode, setModeState] = useState<TalkPress>('idle');
  const [error, setError] = useState<string>();
  // Handlers run outside render, so they keep the latest values in refs.
  const modeRef = useRef<TalkPress>('idle');
  const portRef = useRef<number | null>(null);
  const loaded = useRef(false);
  const want = useRef(false);
  const pressedAt = useRef(0);
  const html = useMemo(() => talkPageHtml(), []);

  const setMode = (m: TalkPress) => {
    modeRef.current = m;
    setModeState(m);
  };
  const inject = (js: string) => web.current?.injectJavaScript(`${js}; true;`);

  // A different camera (or route) gets its own endpoint; leaving hangs up.
  const routeKey = `${route.kind}|${route.url}|${route.viaTunnel}`;
  useEffect(() => {
    return () => {
      // Closing the endpoint hangs up; unmounting the page (port → null) ends the microphone.
      want.current = false;
      if (portRef.current != null) closeTalk(portRef.current);
      portRef.current = null;
      loaded.current = false;
      setPort(null);
      setState('idle');
      modeRef.current = 'idle';
      setModeState('idle');
    };
  }, [routeKey]);

  const start = async () => {
    want.current = true;
    setError(undefined);
    setState('connecting');
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (portRef.current == null) {
      try {
        const p = await openTalk(route);
        portRef.current = p;
        setPort(p);
      } catch {
        want.current = false;
        setState('idle');
        setMode('idle');
        setError(talkErrorText('unreachable'));
        return;
      }
    }
    // The page may still be loading; it starts as soon as it reports in.
    if (want.current && loaded.current) inject('window.__start && window.__start()');
  };

  const stop = () => {
    want.current = false;
    inject('window.__stop && window.__stop()');
    setState('idle');
  };

  const onPressIn = () => {
    pressedAt.current = Date.now();
    const r = pressIn(modeRef.current);
    setMode(r.mode);
    if (r.action === 'start') void start();
    else if (r.action === 'stop') stop();
  };
  const onPressOut = () => {
    const r = pressOut(modeRef.current, Date.now() - pressedAt.current);
    setMode(r.mode);
    if (r.action === 'stop') stop();
  };

  const onMessage = (data: string) => {
    let msg: { type: string; value?: string };
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.type === 'loaded') {
      loaded.current = true;
      if (want.current) inject('window.__start && window.__start()');
    } else if (msg.type === 'state') {
      const s = (msg.value ?? 'idle') as TalkState;
      // A late "idle" from the previous press while a new one is starting (failures arrive as
      // "error" first, so a real hang-up is never missed).
      if (s === 'idle' && want.current) return;
      if (s === 'talking' && !want.current) {
        inject('window.__stop && window.__stop()');
        return;
      }
      setState(s);
      if (s === 'talking') void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      if (s === 'idle') {
        want.current = false;
        setMode('idle');
      }
    } else if (msg.type === 'error') {
      want.current = false;
      setMode('idle');
      setState('idle');
      if (msg.value === 'mic-denied') {
        Alert.alert('Microphone is off for Sightline', talkErrorText('mic-denied'), [
          { text: 'Not now', style: 'cancel' },
          { text: 'Open Settings', onPress: () => void Linking.openSettings() },
        ]);
      } else {
        setError(talkErrorText(msg.value ?? ''));
      }
    }
  };

  const active = state !== 'idle' || mode !== 'idle';
  useEffect(() => {
    onActiveChange?.(active);
  }, [active, onActiveChange]);
  const { title, hint } = talkLabel(state, mode);
  const a11y = active ? `${title} ${hint}` : 'Talk. Hold to talk through the camera, or tap to start and tap again to stop.';

  const mic =
    port != null ? (
      <WebView
        ref={web}
        source={{ html, baseUrl: `http://127.0.0.1:${port}/` }}
        style={styles.hidden}
        originWhitelist={['*']}
        javaScriptEnabled
        // Our own page on loopback: WebKit shouldn't ask again after iOS's microphone prompt.
        mediaCapturePermissionGrantType="grant"
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        onMessage={(e) => onMessage(e.nativeEvent.data)}
      />
    ) : null;

  if (variant === 'call') {
    return (
      <View style={styles.callItem}>
        {mic}
        <Pressable
          onPressIn={onPressIn}
          onPressOut={onPressOut}
          accessibilityRole="button"
          accessibilityLabel={a11y}
          accessibilityState={{ selected: active }}
          style={[styles.callBtn, { backgroundColor: active ? RED : 'rgba(255,255,255,0.22)' }]}>
          <SymbolView name={active ? 'waveform' : 'mic.fill'} tintColor="#fff" size={30} />
        </Pressable>
        <T v="label" color="#fff">
          {active ? title : 'Hold to talk'}
        </T>
        {error && !active && (
          <T v="caption" color="rgba(255,255,255,0.8)" style={styles.callError}>
            {error}
          </T>
        )}
      </View>
    );
  }

  return (
    <View style={styles.barWrap}>
      {mic}
      <Pressable
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        accessibilityRole="button"
        accessibilityLabel={a11y}
        accessibilityState={{ selected: active }}
        style={[styles.bar, active && { backgroundColor: RED }]}>
        <SymbolView name={active ? 'waveform' : 'mic.fill'} tintColor="#fff" size={22} />
        <View style={{ flex: 1 }}>
          <T v="label" color="#fff">
            {title}
          </T>
          <T v="caption" color="rgba(255,255,255,0.75)">
            {hint}
          </T>
        </View>
      </Pressable>
      {error && !active && (
        <T v="caption" color="rgba(255,255,255,0.7)">
          {error}
        </T>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  hidden: { position: 'absolute', width: 1, height: 1, opacity: 0, backgroundColor: 'transparent' },
  barWrap: { gap: 6 },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 56,
    paddingHorizontal: 16,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.14)',
  },
  callItem: { alignItems: 'center', gap: 10 },
  callBtn: { width: 78, height: 78, borderRadius: 39, alignItems: 'center', justifyContent: 'center' },
  callError: { maxWidth: 140, textAlign: 'center' },
});

import { useEvent } from 'expo';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect, useRef, useState } from 'react';
import { Image, StyleSheet, Text, View, useTVEventHandler } from 'react-native';

import { HubError, liveUrl, pollRings, snapshotUrl, type HubCamera } from './hub';
import { lang, locale, t } from './i18n';
import { colors } from './theme';
import { advance, clockText, dimOpacity, onRings, pixelShift, shownIndex, TOUR_INTERVAL_MS, type TourState } from './tour';

/**
 * Tour: the TV goes through the cameras full screen, one every 15 seconds, and switches to
 * the doorbell when someone rings (the Hub's /v1/rings long poll), then carries on. Dims at
 * night and drifts slightly each minute so the picture doesn't burn in. Left/right skip;
 * Menu leaves (handled by the caller).
 */
export function TourScreen({ base, token, cameras }: { base: string; token: string; cameras: HubCamera[] }) {
  const [state, setState] = useState<TourState>({ index: 0, ring: null });
  const [now, setNow] = useState(() => Date.now());
  const ids = useRef(cameras.map((c) => c.id));
  ids.current = cameras.map((c) => c.id);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const t = setInterval(() => setState((s) => advance(s, cameras.length, Date.now())), TOUR_INTERVAL_MS);
    return () => clearInterval(t);
  }, [cameras.length]);

  // Doorbell rings. The first call only learns the Hub's clock (older rings are ignored).
  const [ringsOff, setRingsOff] = useState(false);
  useEffect(() => {
    let alive = true;
    const loop = async () => {
      let after: number | null = null;
      while (alive) {
        try {
          const r = await pollRings(base, token, after ?? 0, after == null ? 0 : 25);
          if (!alive) return;
          if (after != null && r.rings.length) setState((s) => onRings(s, r.rings, ids.current, Date.now()));
          after = r.now;
        } catch (e) {
          if (e instanceof HubError && e.status === 404) {
            setRingsOff(true); // a Hub from before rings existed
            return;
          }
          await new Promise((res) => setTimeout(res, 5000));
        }
      }
    };
    void loop();
    return () => {
      alive = false;
    };
  }, [base, token]);

  useTVEventHandler((evt) => {
    if (evt.eventType === 'right') setState((s) => ({ index: (shownIndex(s, Date.now()) + 1) % cameras.length, ring: null }));
    else if (evt.eventType === 'left') setState((s) => ({ index: (shownIndex(s, Date.now()) - 1 + cameras.length) % cameras.length, ring: null }));
  });

  const index = Math.min(shownIndex(state, now), cameras.length - 1);
  const camera = cameras[index];
  const ringing = !!state.ring && now < state.ring.until;
  const shift = pixelShift(now);
  const dim = dimOpacity(new Date(now));
  if (!camera) return null;

  return (
    <View style={styles.root}>
      <View style={[StyleSheet.absoluteFill, { transform: [{ translateX: shift.x }, { translateY: shift.y }] }]}>
        <TourCamera key={camera.id} base={base} token={token} camera={camera} />
      </View>
      {ringing && (
        <View style={styles.ring}>
          <Text style={styles.ringText}>{t.atTheDoor}</Text>
        </View>
      )}
      <View style={[styles.label, { left: 64 + shift.x, bottom: 56 + shift.y }]}>
        <Text style={styles.name}>{camera.name}</Text>
        <Text style={styles.hint}>
          {timeText(new Date(now))} · {t.tour}
          {ringsOff ? '' : ` · ${t.tourDoorbell}`}   ◀ ▶
        </Text>
      </View>
      {dim > 0 && <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: '#000', opacity: dim }]} />}
    </View>
  );
}

/** "9:05 PM" in English; other languages get the TV's own clock format ("21:05"). */
function timeText(at: Date): string {
  if (lang === 'en') return clockText(at);
  try {
    return at.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  } catch {
    return clockText(at);
  }
}

/** One camera: HLS live over a refreshing snapshot (which shows while video connects). */
function TourCamera({ base, token, camera }: { base: string; token: string; camera: HubCamera }) {
  const player = useVideoPlayer(liveUrl(base, token, camera.id), (p) => {
    p.muted = true;
    p.play();
  });
  const { status } = useEvent(player, 'statusChange', { status: player.status });
  const [tick, setTick] = useState(() => Date.now());
  const playing = status === 'readyToPlay';
  useEffect(() => {
    if (playing) return;
    const t = setInterval(() => setTick(Date.now()), 2000);
    return () => clearInterval(t);
  }, [playing]);
  return (
    <View style={StyleSheet.absoluteFill}>
      <Image source={{ uri: snapshotUrl(base, token, camera.id, 1080, tick) }} style={StyleSheet.absoluteFill} resizeMode="contain" />
      {status !== 'error' && <VideoView player={player} style={StyleSheet.absoluteFill} contentFit="contain" nativeControls={false} />}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  label: { position: 'absolute', paddingHorizontal: 28, paddingVertical: 16, borderRadius: 18, backgroundColor: 'rgba(0,0,0,0.55)' },
  name: { color: colors.text, fontSize: 40, fontWeight: '700' },
  hint: { color: colors.textMuted, fontSize: 24, marginTop: 4 },
  ring: { position: 'absolute', top: 56, alignSelf: 'center', paddingHorizontal: 40, paddingVertical: 20, borderRadius: 999, backgroundColor: 'rgba(48,209,88,0.92)' },
  ringText: { color: '#fff', fontSize: 40, fontWeight: '700' },
});

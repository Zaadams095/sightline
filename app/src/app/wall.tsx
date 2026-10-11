import { useKeepAwake } from 'expo-keep-awake';
import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { setRingHandler, type RingParams } from '@/alerts/doorbell';
import { isDoorbell, selectNotifications } from '@/alerts/rules';
import { CameraTile } from '@/components/camera-tile';
import { LiveView, useLive } from '@/components/live/live-view';
import { fmtTime, tr } from '@/i18n';
import { useT } from '@/i18n/use-t';
import { useLinks } from '@/net/connection';
import { LockScreen } from '@/security/app-lock';
import { useApp } from '@/state/store';
import { useWall } from '@/state/wall';
import { getAdapter, useAllCameras, type CameraEntry } from '@/systems/registry';
import { OVERLAY_MAX_SCALE } from '@/theme/tokens';
import { titleFor } from '@/util/format';
import {
  activeTakeover,
  addTakeover,
  clockCorner,
  clockText,
  dateLine,
  dimOpacity,
  gridPageSize,
  gridShape,
  pixelShift,
  rotateForBurnIn,
  statusLine,
  tourPages,
  type Takeover,
} from '@/wall/schedule';

const ALERT_POLL_MS = 10_000;
const CONTROLS_MS = 6000;

/**
 * Wall display: a full-screen, always-on camera wall for an iPad on the wall or the counter.
 * Tours the cameras (a grid, or one at a time), jumps to the doorbell when someone rings and
 * to a camera with a new alert, then goes back. Dims at night and drifts slightly over time
 * so the screen doesn't burn in. Tap to show the exit button (Face ID / PIN if the app is
 * locked).
 */
export default function WallDisplay() {
  useKeepAwake();
  const t = useT();
  const { width, height } = useWindowDimensions();
  const { entries } = useAllCameras();
  const wall = useWall();
  const lockEnabled = useApp((s) => s.security.lockEnabled);
  const systems = useApp((s) => s.systems);
  const links = useLinks((s) => s.links);

  // Slow tick: tour pages, takeovers ending, dimming and burn-in shifts.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);

  const byKey = useMemo(() => new Map(entries.map((e) => [e.camera.key, e])), [entries]);
  const keys = useMemo(() => {
    const chosen = wall.cameraKeys.length ? wall.cameraKeys.filter((k) => byKey.has(k)) : entries.map((e) => e.camera.key);
    return chosen.length ? chosen : entries.map((e) => e.camera.key);
  }, [wall.cameraKeys, entries, byKey]);
  const burnSlot = Math.floor(now / (15 * 60_000));
  const pages = useMemo(
    () => tourPages(wall.mode === 'grid' ? rotateForBurnIn(keys, burnSlot * 15 * 60_000) : keys, wall.mode, gridPageSize(width, height)),
    [keys, wall.mode, width, height, burnSlot],
  );

  // Takeovers (doorbell rings, alerts).
  const [takeovers, setTakeovers] = useState<Takeover[]>([]);
  const takeover = activeTakeover(takeovers, now);
  const nameOf = useCallback((key: string) => byKey.get(key)?.camera.name ?? tr().wall.display.camera, [byKey]);

  useEffect(() => {
    if (!wall.jumpToDoorbell) return;
    setRingHandler((p: RingParams) => {
      const key = `${p.systemId}:${p.cameraId}`;
      const t = Date.now();
      setTakeovers((list) => addTakeover(list, { kind: 'ring', cameraKey: key, at: t, title: tr().wall.display.ring }, t));
      return true;
    });
    return () => setRingHandler(null);
  }, [wall.jumpToDoorbell]);

  // New alerts, picked with the user's own alert settings.
  const lastSeen = useRef<Record<string, number>>({});
  const lastByCamera = useRef<Record<string, number>>({});
  useEffect(() => {
    if (!wall.jumpToAlerts) return;
    const since = Date.now() / 1000 - 30;
    let busy = false;
    const poll = async () => {
      if (busy) return;
      busy = true;
      try {
        const { alerts } = useApp.getState();
        const curLinks = useLinks.getState().links;
        for (const s of useApp.getState().systems) {
          const link = curLinks[s.id];
          if (link?.mode !== 'lan' && link?.mode !== 'tunnel') continue;
          const adapter = getAdapter(s, link);
          if (!adapter?.listReview || !adapter.capabilities.events) continue;
          const after = lastSeen.current[s.id] ?? since;
          const items = await adapter.listReview({ after, limit: 20 }).catch(() => []);
          const fresh = items.filter((i) => i.startTime > after);
          if (!fresh.length) continue;
          lastSeen.current[s.id] = Math.max(after, ...fresh.map((i) => i.startTime));
          // Rings come through the doorbell path; here only other alerts.
          const picked = selectNotifications(fresh.filter((i) => !isDoorbell(i)), alerts, lastByCamera.current);
          const item = picked[picked.length - 1];
          if (!item) continue;
          const key = `${item.systemId}:${item.cameraId}`;
          const t = Date.now();
          setTakeovers((list) => addTakeover(list, { kind: 'alert', cameraKey: key, at: t, title: `${titleFor(item)} · ${nameOf(key)}` }, t));
        }
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(() => void poll(), ALERT_POLL_MS);
    return () => clearInterval(timer);
  }, [wall.jumpToAlerts, nameOf]);

  // The tour pauses while a takeover is showing, then carries on.
  const [page, setPage] = useState(0);
  const paused = !!takeover;
  useEffect(() => {
    if (paused || pages.length < 2) return;
    const t = setInterval(() => setPage((p) => p + 1), Math.max(5, wall.intervalSec) * 1000);
    return () => clearInterval(t);
  }, [paused, pages.length, wall.intervalSec]);
  const current = pages.length ? pages[page % pages.length] : [];

  // Exit.
  const [controls, setControls] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  useEffect(() => {
    if (!controls) return;
    const t = setTimeout(() => setControls(false), CONTROLS_MS);
    return () => clearTimeout(t);
  }, [controls]);
  const exit = () => (lockEnabled ? setUnlocking(true) : router.back());

  const shift = pixelShift(now);
  const at = new Date(now);
  const dim = dimOpacity(wall.night, at);
  const offlineSystems = systems.filter((s) => links[s.id]?.mode === 'offline').map((s) => s.name);
  const disabled = keys.filter((k) => byKey.get(k)?.camera.enabled === false).length;
  const status = statusLine(keys.length, disabled) + (offlineSystems.length ? ` · ${t.wall.display.notReachable(offlineSystems.join(', '))}` : '');
  // 24-hour clock when the language/region writes 13:00 rather than 1:00 PM.
  const h24 = fmtTime(new Date(2000, 0, 1, 13, 0)).includes('13');
  const focusEntry = takeover ? byKey.get(takeover.cameraKey) : undefined;

  return (
    <View style={styles.root}>
      <StatusBar hidden />
      <Pressable style={StyleSheet.absoluteFill} onPress={() => setControls((c) => !c)} accessibilityLabel={t.wall.display.showControls}>
        <View style={[StyleSheet.absoluteFill, { transform: [{ translateX: shift.x }, { translateY: shift.y }] }]} pointerEvents="none">
          {focusEntry ? (
            <Focus entry={focusEntry} />
          ) : wall.mode === 'single' && current[0] && byKey.get(current[0]) ? (
            <Focus entry={byKey.get(current[0])!} />
          ) : (
            <Grid entries={current.map((k) => byKey.get(k)).filter((e): e is CameraEntry => !!e)} width={width} height={height} />
          )}
          {!entries.length && (
            <View style={[StyleSheet.absoluteFill, styles.center]}>
              <Text style={styles.empty} maxFontSizeMultiplier={OVERLAY_MAX_SCALE}>
                {t.wall.display.connecting}
              </Text>
            </View>
          )}
        </View>
      </Pressable>

      {takeover && (
        <Pressable
          style={[styles.banner, takeover.kind === 'ring' && styles.ring]}
          accessibilityRole="button"
          onPress={() => {
            if (takeover.kind !== 'ring') return;
            const e = byKey.get(takeover.cameraKey);
            if (e) router.push({ pathname: '/doorbell', params: { systemId: e.adapter.config.id, cameraId: e.camera.id } });
          }}>
          <SymbolView name={takeover.kind === 'ring' ? 'bell.fill' : 'exclamationmark.circle.fill'} tintColor="#fff" size={26} />
          <View style={{ flexShrink: 1 }}>
            <Text style={styles.bannerTitle} maxFontSizeMultiplier={OVERLAY_MAX_SCALE}>
              {takeover.title}
            </Text>
            {takeover.kind === 'ring' && (
              <Text style={styles.bannerSub} maxFontSizeMultiplier={OVERLAY_MAX_SCALE}>
                {t.wall.display.tapToAnswer(nameOf(takeover.cameraKey))}
              </Text>
            )}
          </View>
        </Pressable>
      )}

      {wall.showClock && (
        <View
          pointerEvents="none"
          style={[styles.clock, clockCorner(now) === 'left' ? { left: 32 + shift.x } : { right: 32 - shift.x }, { bottom: 28 + shift.y }]}>
          <Text style={styles.time} maxFontSizeMultiplier={OVERLAY_MAX_SCALE}>
            {clockText(at, h24)}
          </Text>
          <Text style={styles.date} maxFontSizeMultiplier={OVERLAY_MAX_SCALE}>
            {dateLine(at)}
          </Text>
          <Text style={styles.status} maxFontSizeMultiplier={OVERLAY_MAX_SCALE}>
            {status}
          </Text>
        </View>
      )}

      {dim > 0 && <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: '#000', opacity: dim }]} />}

      {controls && (
        <View style={styles.controls}>
          <Pressable onPress={() => setPage((p) => p + 1)} style={styles.control} accessibilityRole="button">
            <SymbolView name="forward.fill" tintColor="#fff" size={18} />
            <Text style={styles.controlText} maxFontSizeMultiplier={OVERLAY_MAX_SCALE}>
              {t.common.next}
            </Text>
          </Pressable>
          <Pressable onPress={exit} style={styles.control} accessibilityRole="button">
            <SymbolView name="xmark" tintColor="#fff" size={18} />
            <Text style={styles.controlText} maxFontSizeMultiplier={OVERLAY_MAX_SCALE}>
              {t.wall.display.exit}
            </Text>
          </Pressable>
        </View>
      )}

      <Modal visible={unlocking} animationType="fade" presentationStyle="overFullScreen" transparent>
        <LockScreen
          onUnlock={() => {
            setUnlocking(false);
            router.back();
          }}
        />
        <Pressable onPress={() => setUnlocking(false)} style={styles.cancelUnlock} accessibilityRole="button">
          <Text style={styles.cancelText} maxFontSizeMultiplier={OVERLAY_MAX_SCALE}>
            {t.common.cancel}
          </Text>
        </Pressable>
      </Modal>
    </View>
  );
}

/** One camera, full screen: live video when it connects, refreshing snapshots until then. */
function Focus({ entry }: { entry: CameraEntry }) {
  const live = useLive(entry.adapter, entry.camera.id, 'main');
  return (
    <View style={StyleSheet.absoluteFill}>
      <CameraTile camera={entry.camera} adapter={entry.adapter} active requestHeight={1080} intervalMs={1000} style={StyleSheet.absoluteFill} />
      {live.data && (
        <View style={StyleSheet.absoluteFill}>
          <LiveView live={live.data} fit="contain" />
        </View>
      )}
      <View style={styles.focusLabel}>
        <Text style={styles.focusName} numberOfLines={1} maxFontSizeMultiplier={OVERLAY_MAX_SCALE}>
          {entry.camera.name}
        </Text>
      </View>
    </View>
  );
}

function Grid({ entries, width, height }: { entries: CameraEntry[]; width: number; height: number }) {
  const { cols, rows } = gridShape(entries.length, width, height);
  const gap = 4;
  const w = (width - gap * (cols + 1)) / cols;
  const h = (height - gap * (rows + 1)) / rows;
  return (
    <View style={StyleSheet.absoluteFill}>
      {entries.map((e, i) => (
        <CameraTile
          key={e.camera.key}
          camera={e.camera}
          adapter={e.adapter}
          active
          requestHeight={rows <= 2 ? 540 : 360}
          intervalMs={rows <= 2 ? 1000 : 1500}
          style={{ position: 'absolute', left: gap + (i % cols) * (w + gap), top: gap + Math.floor(i / cols) * (h + gap), width: w, height: h }}
        />
      ))}
    </View>
  );
}

const shadow = { textShadowColor: 'rgba(0,0,0,0.8)', textShadowRadius: 6, textShadowOffset: { width: 0, height: 1 } };

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  center: { alignItems: 'center', justifyContent: 'center' },
  empty: { color: 'rgba(255,255,255,0.7)', fontSize: 20 },
  clock: { position: 'absolute' },
  time: { color: '#fff', fontSize: 64, fontWeight: '200', fontVariant: ['tabular-nums'], ...shadow },
  date: { color: 'rgba(255,255,255,0.9)', fontSize: 20, fontWeight: '500', ...shadow },
  status: { color: 'rgba(255,255,255,0.7)', fontSize: 15, marginTop: 4, ...shadow },
  banner: {
    position: 'absolute',
    top: 28,
    alignSelf: 'center',
    maxWidth: '90%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.7)',
  },
  ring: { backgroundColor: 'rgba(48,209,88,0.9)' },
  bannerTitle: { color: '#fff', fontSize: 24, fontWeight: '700' },
  bannerSub: { color: 'rgba(255,255,255,0.9)', fontSize: 16 },
  focusLabel: { position: 'absolute', top: 28, left: 32, paddingHorizontal: 14, paddingVertical: 6, borderRadius: 999, backgroundColor: 'rgba(0,0,0,0.5)' },
  focusName: { color: '#fff', fontSize: 18, fontWeight: '600' },
  controls: { position: 'absolute', top: 28, right: 28, flexDirection: 'row', gap: 12 },
  control: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 18,
    minHeight: 48,
    borderRadius: 24,
    backgroundColor: 'rgba(0,0,0,0.7)',
  },
  controlText: { color: '#fff', fontSize: 17, fontWeight: '600' },
  cancelUnlock: { position: 'absolute', top: 40, left: 24, minHeight: 44, justifyContent: 'center', paddingHorizontal: 12 },
  cancelText: { color: '#7C5CFF', fontSize: 17, fontWeight: '600' },
});

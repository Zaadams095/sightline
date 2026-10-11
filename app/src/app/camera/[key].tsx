import { useQuery } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useEffect, useState } from 'react';
import { ActionSheetIOS, ActivityIndicator, FlatList, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SamplePill } from '@/components/demo-banner';
import type { LiveState } from '@/components/live/live-player';
import { defaultLiveQuality, LiveView, useLive } from '@/components/live/live-view';
import { useLinks } from '@/net/connection';
import { nextTimeOfDay } from '@/alerts/rules';
import { zoneSupportFor } from '@/alerts/zones';
import { PtzPad } from '@/components/ptz-pad';
import { DeterControls } from '@/components/talk/deter-controls';
import { TalkButton } from '@/components/talk/talk-button';
import { useTalkRoute } from '@/talk/talk';
import { T } from '@/components/ui/primitives';
import { useT } from '@/i18n/use-t';
import { useApp } from '@/state/store';
import { useAdapter } from '@/systems/registry';
import { useLargeText } from '@/theme/text-scale';
import { space } from '@/theme/tokens';
import { formatClock, formatRelative, nowSec, titleFor } from '@/util/format';

export default function CameraScreen() {
  const t = useT();
  const large = useLargeText();
  const { key, poster: tilePoster, unmuted } = useLocalSearchParams<{ key: string; poster?: string; unmuted?: string }>();
  const [openedAt] = useState(() => Math.round(nowSec() * 1000));
  const [systemId, cameraId] = splitKey(key);
  const adapter = useAdapter(systemId);
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const landscape = width > height;
  // Answering a doorbell opens with sound on.
  const [muted, setMuted] = useState(unmuted !== '1');
  const [showPtz, setShowPtz] = useState(false);
  const [liveState, setLiveState] = useState<LiveState>();
  const [attempt, setAttempt] = useState(0);
  const systemExists = useApp((s) => s.systems.some((x) => x.id === systemId));
  const linkMode = useLinks((s) => s.links[systemId]?.mode);
  const linkError = useLinks((s) => s.links[systemId]?.error);
  // Full quality at home; away (VPN, cellular) the lighter stream starts far faster. The HD
  // button overrides, and full quality that hasn't started in 8 s steps down by itself.
  const [quality, setQuality] = useState<'main' | 'sub' | null>(null);
  const [steppedDown, setSteppedDown] = useState(false);
  const effectiveQuality = quality ?? defaultLiveQuality(linkMode);
  const radius = useApp((s) => s.appearance.radius);
  const snoozedUntil = useApp((s) => s.alerts.snoozed[key] ?? 0);
  const snooze = useApp((s) => s.snooze);
  const isSnoozed = snoozedUntil > nowSec();
  const toggleSnooze = () => {
    if (isSnoozed) return snooze(key, null);
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: t.viewing.camera.muteTitle,
        options: [t.viewing.camera.muteFor1h, t.viewing.camera.muteUntil7, t.viewing.camera.muteFor24h, t.common.cancel],
        cancelButtonIndex: 3,
      },
      (i) => {
        const now = Math.floor(nowSec());
        const until = [now + 3600, nextTimeOfDay(7, 0), now + 86400][i];
        if (until) snooze(key, until);
      },
    );
  };

  const cameras = useQuery({
    queryKey: ['cameras-of', systemId, !!adapter],
    queryFn: () => adapter!.listCameras(),
    enabled: !!adapter,
    staleTime: 5 * 60_000,
  });
  const camera = cameras.data?.find((c) => c.id === cameraId);

  const live = useLive(adapter, cameraId, effectiveQuality);
  useEffect(() => {
    if (effectiveQuality !== 'main' || quality === 'main' || liveState === 'playing') return;
    const t = setTimeout(() => {
      setQuality('sub');
      setSteppedDown(true);
    }, 8000);
    return () => clearTimeout(t);
  }, [effectiveQuality, quality, liveState]);
  const talkRoute = useTalkRoute(adapter, systemId, cameraId);

  const recent = useQuery({
    queryKey: ['review', systemId, cameraId],
    queryFn: () => adapter!.listReview!({ cameras: [cameraId], after: nowSec() - 86400, limit: 30 }),
    enabled: !!adapter?.listReview,
  });

  if (!adapter) {
    const waiting = systemExists && (linkMode === undefined || linkMode === 'connecting');
    return (
      <View style={[styles.root, styles.center, { padding: space.xl, gap: space.md }]}>
        {waiting ? (
          <>
            <ActivityIndicator color="#fff" />
            <T color="rgba(255,255,255,0.7)">{t.viewing.camera.connecting}</T>
          </>
        ) : (
          <>
            <SymbolView name="video.slash" tintColor="rgba(255,255,255,0.6)" size={40} />
            <T v="heading" color="#fff" style={{ textAlign: 'center' }}>
              {systemExists ? t.viewing.camera.cantReach : t.viewing.camera.notAvailable}
            </T>
            <T color="rgba(255,255,255,0.7)" style={{ textAlign: 'center' }}>
              {systemExists
                ? (linkError ?? t.viewing.camera.checkRecorder)
                : t.viewing.camera.removed}
            </T>
          </>
        )}
        <Pressable onPress={() => router.back()} accessibilityRole="button" style={styles.pillBtn}>
          <T v="label" color="#fff">
            {t.common.close}
          </T>
        </Pressable>
      </View>
    );
  }

  const liveFailed = live.isError || cameras.isError || liveState === 'error';
  const retryLive = () => {
    setLiveState(undefined);
    setAttempt((n) => n + 1);
    void cameras.refetch();
    void live.refetch();
  };

  const videoH = landscape ? height : width / (camera?.aspect ?? 16 / 9);
  // Show the frame the tile already had (instant, from memory), then a sharper one once loaded.
  const poster = (
    <Image
      source={{ uri: adapter.snapshot(cameraId, { height: 720 }).uri }}
      placeholder={tilePoster ? { uri: tilePoster, cacheKey: tilePoster } : undefined}
      placeholderContentFit="contain"
      style={StyleSheet.absoluteFill}
      contentFit="contain"
      transition={150}
    />
  );

  return (
    <View style={styles.root}>
      <View style={{ height: videoH, marginTop: landscape ? 0 : insets.top + 52 }}>
        {live.data ? (
          <LiveView
            key={attempt}
            live={live.data}
            muted={muted}
            poster={poster}
            timingLabel={camera?.name ?? cameraId}
            openedAt={openedAt}
            onState={setLiveState}
          />
        ) : (
          <View style={StyleSheet.absoluteFill}>{poster}</View>
        )}
        {!live.data && !liveFailed && adapter.capabilities.live && (
          <View style={[StyleSheet.absoluteFill, styles.center]} pointerEvents="none">
            <ActivityIndicator color="#fff" accessibilityLabel={t.viewing.camera.loadingLive} />
          </View>
        )}
        {steppedDown && liveState === 'playing' && (
          <View style={styles.qualityNote} pointerEvents="none">
            <T v="caption" color="#fff" overlay>
              {t.viewing.camera.fasterVideo}
            </T>
          </View>
        )}
        {(liveFailed || !adapter.capabilities.live) && (
          <View style={[StyleSheet.absoluteFill, styles.center, styles.scrim]}>
            <T color="#fff" style={{ textAlign: 'center', paddingHorizontal: space.xl }}>
              {!adapter.capabilities.live
                ? t.viewing.camera.liveUnsupported
                : t.viewing.camera.liveFailed}
            </T>
            {liveFailed && (
              <Pressable
                onPress={retryLive}
                accessibilityRole="button"
                style={styles.pillBtn}>
                <T v="label" color="#fff">
                  {t.common.retry}
                </T>
              </Pressable>
            )}
          </View>
        )}
      </View>

      <View style={[styles.topBar, { top: insets.top + 6 }]}>
        <RoundButton icon="xmark" label={t.common.close} onPress={() => router.back()} />
        <View style={{ flex: 1, alignItems: 'center', gap: 4 }}>
          <T v="heading" color="#fff" numberOfLines={1} overlay style={{ textAlign: 'center' }}>
            {camera?.name ?? cameraId}
          </T>
          {adapter.config.kind === 'demo' && <SamplePill dark />}
        </View>
        <Pressable
          onPress={() => {
            setSteppedDown(false);
            setLiveState(undefined);
            setQuality(effectiveQuality === 'main' ? 'sub' : 'main');
          }}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={effectiveQuality === 'main' ? t.viewing.camera.hdOn : t.viewing.camera.hdOff}
          style={[styles.round, effectiveQuality === 'main' && styles.hdOn]}>
          <T v="label" color="#fff" overlay style={{ fontSize: 12 }}>
            HD
          </T>
        </Pressable>
        <RoundButton icon={muted ? 'speaker.slash.fill' : 'speaker.wave.2.fill'} label={muted ? t.viewing.camera.soundOn : t.viewing.camera.soundOff} onPress={() => setMuted((m) => !m)} />
      </View>

      {!landscape && (
        <View style={{ flex: 1, paddingTop: space.lg, gap: space.lg }}>
          <View style={[styles.actions, large && { flexWrap: 'wrap' }]}>
            {adapter.capabilities.review && (
              <Action
                icon="clock.arrow.circlepath"
                label={t.viewing.camera.recordings}
                large={large}
                onPress={() =>
                  router.push({
                    pathname: '/playback',
                    params: { systemId, cameraId, start: String(Math.floor(nowSec() - 600)) },
                  })
                }
              />
            )}
            {adapter.playback && (
              <Action
                icon="timelapse"
                label={t.viewing.camera.timelapse}
                large={large}
                onPress={() => router.push({ pathname: '/timelapse', params: { systemId, cameraId } })}
              />
            )}
            {camera?.ptz && <Action icon="move.3d" label={t.viewing.camera.moveCamera} large={large} active={showPtz} onPress={() => setShowPtz((v) => !v)} />}
            {camera && zoneSupportFor(adapter, camera) && (
              <Action
                icon="square.dashed"
                label={t.viewing.camera.zones}
                large={large}
                accessibilityLabel={t.viewing.camera.alertZones}
                onPress={() => router.push({ pathname: '/settings/zones', params: { key } })}
              />
            )}
            <Action
              icon={isSnoozed ? 'bell.slash.fill' : 'bell'}
              label={isSnoozed ? t.viewing.camera.mutedTill(formatClock(snoozedUntil)) : t.viewing.camera.snooze}
              large={large}
              active={isSnoozed}
              onPress={toggleSnooze}
            />
          </View>

          {(talkRoute || adapter.capabilities.deter) && (
            <View style={{ paddingHorizontal: space.lg, gap: 10 }}>
              {talkRoute && <TalkButton route={talkRoute} />}
              <DeterControls adapter={adapter} systemId={systemId} cameraId={cameraId} />
            </View>
          )}

          {showPtz && camera?.ptz ? (
            <PtzPad adapter={adapter} cameraId={cameraId} />
          ) : !adapter.listReview ? (
            <T v="caption" color="rgba(255,255,255,0.5)" style={{ paddingHorizontal: space.lg }}>
              {t.viewing.camera.recentUnavailable}
            </T>
          ) : (
            <FlatList
              data={recent.data ?? []}
              keyExtractor={(r) => r.id}
              contentContainerStyle={{ paddingHorizontal: space.lg, gap: space.sm, paddingBottom: insets.bottom + 24 }}
              ListHeaderComponent={
                <T v="label" color="rgba(255,255,255,0.6)" style={{ marginBottom: 4 }}>
                  {t.viewing.camera.last24h}
                </T>
              }
              ListEmptyComponent={
                recent.isLoading ? (
                  <ActivityIndicator color="rgba(255,255,255,0.6)" style={{ alignSelf: 'flex-start' }} />
                ) : (
                  <T v="caption" color="rgba(255,255,255,0.5)">
                    {recent.isError ? t.viewing.camera.recentError : t.viewing.camera.recentEmpty}
                  </T>
                )
              }
              renderItem={({ item }) => (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t.viewing.camera.eventA11y(titleFor(item), formatRelative(item.startTime))}
                  style={styles.event}
                  onPress={() =>
                    router.push({
                      pathname: '/playback',
                      params: { systemId, cameraId, start: String(Math.floor(item.startTime - 5)), reviewId: item.id },
                    })
                  }>
                  {item.thumbnailUrl ? (
                    <Image source={{ uri: item.thumbnailUrl }} style={[styles.thumb, { borderRadius: Math.min(radius, 10) }]} />
                  ) : (
                    <View style={styles.thumb} />
                  )}
                  <View style={{ flex: 1, gap: 2 }}>
                    <T v="label" color="#fff">
                      {titleFor(item)}
                    </T>
                    <T v="caption" color="rgba(255,255,255,0.6)">
                      {formatRelative(item.startTime)}
                      {item.zones.length ? ` · ${item.zones.join(', ')}` : ''}
                    </T>
                  </View>
                  {item.severity === 'alert' && <View style={styles.alertDot} />}
                </Pressable>
              )}
            />
          )}
        </View>
      )}
    </View>
  );
}

function splitKey(key: string): [string, string] {
  const i = key.indexOf(':');
  return [key.slice(0, i), key.slice(i + 1)];
}

function RoundButton({ icon, label, onPress }: { icon: React.ComponentProps<typeof SymbolView>['name']; label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} hitSlop={8} accessibilityRole="button" accessibilityLabel={label} style={styles.round}>
      <SymbolView name={icon} tintColor="#fff" size={18} />
    </Pressable>
  );
}

function Action({
  icon,
  label,
  onPress,
  active,
  accessibilityLabel,
  large,
}: {
  icon: React.ComponentProps<typeof SymbolView>['name'];
  label: string;
  onPress: () => void;
  active?: boolean;
  accessibilityLabel?: string;
  large?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ selected: !!active }}
      style={[styles.action, large && { minWidth: '45%' }, active && { backgroundColor: 'rgba(255,255,255,0.22)' }]}>
      <SymbolView name={icon} tintColor="#fff" size={20} />
      <T v="caption" color="#fff" style={{ textAlign: 'center' }}>
        {label}
      </T>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  center: { alignItems: 'center', justifyContent: 'center', gap: space.md },
  scrim: { backgroundColor: 'rgba(0,0,0,0.6)' },
  pillBtn: { paddingHorizontal: 20, minHeight: 44, justifyContent: 'center', borderRadius: 22, backgroundColor: 'rgba(255,255,255,0.18)' },
  topBar: { position: 'absolute', left: 12, right: 12, flexDirection: 'row', alignItems: 'center', gap: 12 },
  round: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  hdOn: { backgroundColor: 'rgba(124,92,255,0.85)' },
  qualityNote: {
    position: 'absolute',
    bottom: 10,
    alignSelf: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  actions: { flexDirection: 'row', gap: 10, paddingHorizontal: space.lg },
  action: {
    flex: 1,
    alignItems: 'center',
    gap: 6,
    paddingVertical: 12,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  event: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  thumb: { width: 96, height: 54, backgroundColor: '#1a1a1a' },
  alertDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#FF453A' },
});

import { useQuery } from '@tanstack/react-query';
import { useEvent, useEventListener } from 'expo';
import { router, useLocalSearchParams } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActionSheetIOS, ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DayOverview } from '@/components/playback/day-overview';
import { StreamPlayback } from '@/components/playback/stream-playback';
import { SyncedPip } from '@/components/playback/synced-pip';
import { Timeline } from '@/components/timeline';
import { Chip, T } from '@/components/ui/primitives';
import { neighborsOf, tracePath } from '@/map/graph';
import { useApp } from '@/state/store';
import { useAdapter } from '@/systems/registry';
import type { ReviewItem } from '@/systems/types';
import { space } from '@/theme/tokens';
import { formatClock, formatDay, labelFor, titleFor, nowSec } from '@/util/format';
import { seekPlayer, setPlayerRate } from '@/util/player';
import { shareClip } from '@/util/share';
import { clipSegments, playerToWall, wallToPlayer } from '@/util/vod-time';

const HALF_WINDOW = 30 * 60;
const SPEEDS = [1, 2, 4, 8];
const ZOOMS = [0.4, 1.5, 4];
const MOTION_SCALE = 30;

function localMidnight(t: number) {
  const d = new Date(t * 1000);
  d.setHours(0, 0, 0, 0);
  return d.getTime() / 1000;
}

function dayKey(t: number) {
  const d = new Date(t * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function PlaybackScreen() {
  const params = useLocalSearchParams<{ systemId: string; cameraId: string; start: string; reviewId?: string }>();
  const adapter = useAdapter(params.systemId);
  const cameraId = params.cameraId;
  const cameraKey = `${params.systemId}:${cameraId}`;
  const cameraMap = useApp((s) => s.cameraMap);
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const landscape = width > height;

  // The playlist window is re-centered when the user scrubs near its edges.
  const [now, setNow] = useState(() => Math.floor(nowSec()));
  const [anchor, setAnchor] = useState(() => Number(params.start));
  const winStart = anchor - HALF_WINDOW;
  const winEnd = Math.min(now, anchor + HALF_WINDOW);

  const [wall, setWall] = useState(anchor);
  const [scrubWall, setScrubWall] = useState<number | null>(null);
  const [speed, setSpeed] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [labelFilter, setLabelFilter] = useState<string | null>(null);
  const [showPip, setShowPip] = useState(true);
  const [sharing, setSharing] = useState(false);
  const pendingSeek = useRef<number | null>(anchor);

  const dayStart = localMidnight(scrubWall ?? wall);
  const dayEnd = Math.min(dayStart + 86400, now);

  const names = useQuery({
    queryKey: ['cameras-of', params.systemId, !!adapter],
    queryFn: () => adapter!.listCameras(),
    enabled: !!adapter,
    staleTime: 5 * 60_000,
  });
  const nameOf = (id: string) => names.data?.find((c) => c.id === id)?.name ?? id;

  const days = useQuery({
    queryKey: ['rec-days', params.systemId, cameraId],
    queryFn: () => adapter!.recordingDays!(cameraId),
    enabled: !!adapter?.recordingDays,
    staleTime: 10 * 60_000,
  });

  const segQuery = useQuery({
    queryKey: ['segments', params.systemId, cameraId, winStart, winEnd],
    queryFn: () => adapter!.recordingSegments!(cameraId, winStart, winEnd),
    enabled: !!adapter?.recordingSegments,
  });
  const segments = useMemo(() => clipSegments(segQuery.data ?? [], winStart, winEnd), [segQuery.data, winStart, winEnd]);

  const daySegs = useQuery({
    queryKey: ['segments-day', params.systemId, cameraId, dayStart, dayEnd],
    queryFn: () => adapter!.recordingSegments!(cameraId, dayStart, dayEnd),
    enabled: !!adapter?.recordingSegments,
    staleTime: 60_000,
  });

  const dayEvents = useQuery({
    queryKey: ['review-day', params.systemId, cameraId, dayStart, dayEnd],
    queryFn: () => adapter!.listReview!({ cameras: [cameraId], after: dayStart, before: dayEnd, limit: 500 }),
    enabled: !!adapter?.listReview,
    staleTime: 60_000,
  });

  const motion = useQuery({
    queryKey: ['motion', params.systemId, cameraId, winStart, winEnd],
    queryFn: () => adapter!.motionActivity!(cameraId, winStart, winEnd, MOTION_SCALE),
    enabled: !!adapter?.motionActivity,
  });

  const labels = useMemo(() => [...new Set((dayEvents.data ?? []).flatMap((e) => e.objects))].sort(), [dayEvents.data]);
  const events = useMemo(
    () =>
      [...(dayEvents.data ?? [])]
        .filter((e) => !labelFilter || e.objects.includes(labelFilter))
        .sort((a, b) => a.startTime - b.startTime),
    [dayEvents.data, labelFilter],
  );

  // Nearby cameras on the same system (from the property map): synced PiP + path following.
  const neighbors = useMemo(
    () => neighborsOf(cameraMap, cameraKey, 2).filter((n) => n.key.startsWith(`${params.systemId}:`)),
    [cameraMap, cameraKey, params.systemId],
  );
  const neighborIds = neighbors.map((n) => n.key.slice(params.systemId.length + 1));
  const neighborEvents = useQuery({
    queryKey: ['review-neighbors', params.systemId, neighborIds.join(','), winStart, winEnd],
    queryFn: () => adapter!.listReview!({ cameras: neighborIds, after: winStart, before: winEnd, limit: 200 }),
    enabled: !!adapter?.listReview && neighborIds.length > 0,
  });

  const playbackSource = useQuery({
    queryKey: ['playback-source', params.systemId, cameraId, winStart, winEnd],
    queryFn: () => adapter!.playback!(cameraId, winStart, winEnd),
    enabled: !!adapter?.playback,
    staleTime: Infinity,
  });
  const source = playbackSource.data?.kind === 'vod' ? playbackSource.data.uri : null;
  // Systems without one seekable playlist stream forward from a start time; seeking reopens.
  const streamMode = playbackSource.data?.kind === 'stream';
  const [streamStart, setStreamStart] = useState(anchor);
  const [streamStopped, setStreamStopped] = useState(false);
  const [streamPlaying, setStreamPlaying] = useState(false);
  const player = useVideoPlayer(source, (p) => {
    p.timeUpdateEventInterval = 0.25;
    p.muted = false;
  });
  const { isPlaying } = useEvent(player, 'playingChange', { isPlaying: player.playing });
  const { status: playerStatus } = useEvent(player, 'statusChange', { status: player.status });

  // Seek to the requested moment once the recording list is known. Systems without one (or
  // when it fails to load) still play, from the start of the window.
  const segmentsKnown = !!segQuery.data || !adapter?.recordingSegments || segQuery.isError;
  const applyPendingSeek = () => {
    if (pendingSeek.current != null && segmentsKnown && player.status === 'readyToPlay') {
      if (segQuery.data) seekPlayer(player, wallToPlayer(segments, pendingSeek.current));
      pendingSeek.current = null;
      player.play();
    }
  };
  useEventListener(player, 'statusChange', applyPendingSeek);
   
  useEffect(applyPendingSeek, [segQuery.data, segments, player, segmentsKnown]);

  useEventListener(player, 'timeUpdate', ({ currentTime }) => {
    if (segments.length) setWall(playerToWall(segments, currentTime));
  });

  useEffect(() => {
    setPlayerRate(player, speed);
  }, [speed, player]);

  const seekTo = (t: number) => {
    setScrubWall(null);
    if (streamMode) {
      setStreamStart(t);
      setStreamStopped(false);
      setWall(t);
      // Keep the timeline's data window around the new position.
      if (t < winStart + 60 || t > winEnd - 60) {
        const fresh = Math.floor(nowSec());
        setNow(fresh);
        setAnchor(Math.min(fresh, Math.round(t)));
      }
      return;
    }
    if (t < winStart + 60 || (t > winEnd - 60 && winEnd < now - 60)) {
      const fresh = Math.floor(nowSec());
      pendingSeek.current = t;
      setNow(fresh);
      setAnchor(Math.min(fresh, Math.round(t)));
      setWall(t);
      return;
    }
    seekPlayer(player, wallToPlayer(segments, t));
    setWall(t);
  };

  const jumpEvent = (dir: 1 | -1) => {
    const ev =
      dir === 1
        ? events.find((e) => e.startTime > wall + 2)
        : [...events].reverse().find((e) => e.startTime < wall - 5);
    if (ev) seekTo(ev.startTime - 3);
  };
  const current = events.find((e) => wall >= e.startTime - 3 && wall <= (e.endTime ?? now));

  // "Where did they go next?": follow the current event across neighboring cameras.
  const nextStop = useMemo(() => {
    if (!current) return null;
    type Keyed = ReviewItem & { key: string };
    const all: Keyed[] = [
      { ...current, key: cameraKey },
      ...(neighborEvents.data ?? []).map((e) => ({ ...e, key: `${e.systemId}:${e.cameraId}` })),
    ];
    const path = tracePath(cameraMap, all[0], all, 1);
    return path[1]?.item ?? null;
  }, [current, neighborEvents.data, cameraMap, cameraKey]);

  const openCamera = (otherId: string, at: number) =>
    router.replace({ pathname: '/playback', params: { systemId: params.systemId, cameraId: otherId, start: String(Math.floor(at)) } });

  // Bookmark: the current event (or 30 s either side), kept forever on the recorder.
  const savedClips = useApp((s) => s.savedClips);
  const saveClip = useApp((s) => s.saveClip);
  const removeClip = useApp((s) => s.removeClip);
  const bookmarkRange: [number, number] = current
    ? [current.startTime - 3, Math.min(now, (current.endTime ?? wall + 15) + 3)]
    : [wall - 30, Math.min(now, wall + 30)];
  const existing = savedClips.find(
    (c) => c.systemId === params.systemId && c.cameraId === cameraId && Math.abs(c.start - bookmarkRange[0]) < 5,
  );
  const toggleSaved = async () => {
    if (existing) {
      await Promise.allSettled(existing.retainedEvents.map((id) => adapter?.retain?.(id, false)));
      removeClip(existing.id);
      return;
    }
    const retained = adapter?.retain ? (current?.detections ?? []) : [];
    await Promise.allSettled(retained.map((id) => adapter?.retain?.(id, true)));
    if (!adapter?.retain) {
      Alert.alert(
        'Bookmarked',
        adapter?.clip
          ? 'Your recorder may delete old video over time. To keep this for good, download it from Review → Saved.'
          : 'Your recorder may delete old video over time.',
      );
    }
    saveClip({
      id: `${params.systemId}-${cameraId}-${Math.floor(bookmarkRange[0])}`,
      systemId: params.systemId,
      cameraId,
      cameraName: nameOf(cameraId),
      title: current ? titleFor(current) : 'Saved moment',
      start: bookmarkRange[0],
      end: bookmarkRange[1],
      savedAt: Math.floor(nowSec()),
      retainedEvents: retained,
    });
  };

  const share = () => {
    if (!adapter?.clip) return;
    const options: { label: string; range: [number, number] }[] = [];
    if (current) options.push({ label: `This event (${titleFor(current)})`, range: [current.startTime - 3, (current.endTime ?? wall + 15) + 3] });
    options.push({ label: '30 seconds around here', range: [wall - 15, wall + 15] });
    options.push({ label: '2 minutes around here', range: [wall - 60, wall + 60] });
    ActionSheetIOS.showActionSheetWithOptions(
      { options: [...options.map((o) => o.label), 'Cancel'], cancelButtonIndex: options.length, title: 'Share clip' },
      async (i) => {
        const o = options[i];
        if (!o) return;
        setSharing(true);
        try {
          await shareClip(adapter, cameraId, nameOf(cameraId), o.range[0], Math.min(o.range[1], now));
        } catch (e) {
          Alert.alert('Could not export clip', e instanceof Error ? e.message : String(e));
        } finally {
          setSharing(false);
        }
      },
    );
  };

  const shown = scrubWall ?? wall;
  const noRecordings = segQuery.isSuccess && segments.length === 0;
  // Plain-language states for the video area; raw player/HTTP errors are never shown.
  const vodMessage = !adapter
    ? null
    : !adapter.playback
      ? 'Recordings from this camera can’t be played in Sightline.'
      : playbackSource.isError
        ? 'Couldn’t load recordings. Check the connection and try again.'
        : source && playerStatus === 'error'
          ? 'This recording couldn’t be played. Try another time on the timeline.'
          : null;
  const vodLoading = !vodMessage && (!adapter || playbackSource.isLoading || (!!source && playerStatus === 'loading'));
  const pipW = Math.min(150, width * 0.32);
  const dayChips = (days.data ?? [dayKey(now)]).slice(0, 30);

  return (
    <View style={styles.root}>
      <View style={{ flex: landscape ? 1 : undefined, height: landscape ? undefined : width * (9 / 16), marginTop: landscape ? 0 : insets.top + 52 }}>
        {source && <VideoView player={player} style={StyleSheet.absoluteFill} contentFit="contain" nativeControls={false} allowsPictureInPicture />}
        {streamMode && adapter && !streamStopped && (
          <StreamPlayback
            adapter={adapter}
            cameraId={cameraId}
            start={streamStart}
            paused={false}
            rate={1}
            onWall={setWall}
            onPlaying={setStreamPlaying}
          />
        )}
        {noRecordings ? (
          <View style={[StyleSheet.absoluteFill, styles.center]}>
            <T color="#fff">No recordings in this period</T>
          </View>
        ) : vodMessage ? (
          <View style={[StyleSheet.absoluteFill, styles.center]}>
            <T color="#fff" style={{ textAlign: 'center' }}>
              {vodMessage}
            </T>
          </View>
        ) : (
          vodLoading &&
          !streamMode && (
            <View style={[StyleSheet.absoluteFill, styles.center]} pointerEvents="none">
              <ActivityIndicator color="#fff" />
            </View>
          )
        )}
      </View>

      <View style={[styles.topBar, { top: insets.top + 6 }]}>
        <Pressable onPress={() => router.back()} hitSlop={8} style={styles.round}>
          <SymbolView name="xmark" tintColor="#fff" size={18} />
        </Pressable>
        <View style={{ flex: 1, alignItems: 'center' }}>
          <T v="label" color="#fff" numberOfLines={1}>
            {nameOf(cameraId)} · {formatClock(shown, true)}
          </T>
          {current && (
            <T v="caption" color="rgba(255,255,255,0.7)" numberOfLines={1}>
              {titleFor(current)}
              {current.zones.length ? ` · ${current.zones.join(', ')}` : ''}
            </T>
          )}
        </View>
        <Pressable onPress={() => void toggleSaved()} hitSlop={8} style={styles.round}>
          <SymbolView name={existing ? 'star.fill' : 'star'} tintColor={existing ? '#FFD60A' : '#fff'} size={18} />
        </Pressable>
        {adapter?.clip && (
          <Pressable onPress={share} hitSlop={8} style={styles.round} disabled={sharing}>
            {sharing ? <ActivityIndicator color="#fff" /> : <SymbolView name="square.and.arrow.up" tintColor="#fff" size={17} />}
          </Pressable>
        )}
        <Pressable onPress={() => router.replace({ pathname: '/camera/[key]', params: { key: cameraKey } })} style={styles.liveBtn}>
          <View style={styles.liveDot} />
          <T v="caption" color="#fff">
            LIVE
          </T>
        </Pressable>
      </View>

      {showPip && !streamMode && neighborIds.length > 0 && adapter && (
        <View style={[styles.pips, { top: landscape ? insets.top + 56 : insets.top + 52 + width * (9 / 16) + 8 }]}>
          {neighborIds.map((id) => (
            <SyncedPip
              key={id}
              adapter={adapter}
              cameraId={id}
              name={nameOf(id)}
              winStart={winStart}
              winEnd={winEnd}
              wall={wall}
              playing={isPlaying}
              rate={speed}
              width={pipW}
              onPress={() => openCamera(id, wall)}
            />
          ))}
        </View>
      )}

      <View style={[styles.controls, { paddingBottom: insets.bottom + space.sm }]}>
        {nextStop && (
          <Pressable onPress={() => openCamera(nextStop.cameraId, nextStop.startTime - 3)} style={styles.nextStop}>
            <SymbolView name="figure.walk" tintColor="#fff" size={14} />
            <T v="caption" color="#fff">
              Next seen on {nameOf(nextStop.cameraId)} ·{' '}
              {Math.max(0, Math.round(nextStop.startTime - (current?.endTime ?? current?.startTime ?? 0)))}s later
            </T>
            <SymbolView name="chevron.right" tintColor="#fff" size={12} />
          </Pressable>
        )}

        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
          {dayChips.map((d) => {
            const [y, m, dd] = d.split('-').map(Number);
            const t = new Date(y, m - 1, dd).getTime() / 1000;
            return <Chip key={d} label={formatDay(t)} selected={dayKey(dayStart) === d} onPress={() => seekTo(Math.min(now - 300, t + 12 * 3600))} />;
          })}
        </ScrollView>

        <DayOverview
          dayStart={dayStart}
          dayEnd={dayStart + 86400}
          time={shown}
          segments={daySegs.data ?? []}
          events={events}
          window={[winStart, winEnd]}
          onSeek={seekTo}
        />

        <Timeline
          width={width}
          start={winStart}
          end={winEnd}
          time={wall}
          segments={segments}
          events={events}
          motion={motion.data ?? []}
          motionScaleSec={MOTION_SCALE}
          pxPerSec={ZOOMS[zoom]}
          onScrub={setScrubWall}
          onSeek={seekTo}
        />

        {labels.length > 0 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
            <Chip label="All activity" selected={!labelFilter} onPress={() => setLabelFilter(null)} />
            {labels.map((l) => (
              <Chip key={l} label={labelFor([l])} selected={labelFilter === l} onPress={() => setLabelFilter(labelFilter === l ? null : l)} />
            ))}
          </ScrollView>
        )}

        <View style={styles.buttons}>
          <Ctl icon="minus.magnifyingglass" small onPress={() => setZoom((z) => Math.max(0, z - 1))} />
          <Ctl icon="backward.end.fill" onPress={() => jumpEvent(-1)} />
          <Ctl icon="gobackward.10" onPress={() => seekTo(wall - 10)} />
          <Ctl
            icon={(streamMode ? streamPlaying && !streamStopped : isPlaying) ? 'pause.fill' : 'play.fill'}
            big
            onPress={() => {
              if (!streamMode) return isPlaying ? player.pause() : player.play();
              // Streams can't pause in place: stop, and resume from where we were.
              if (streamStopped) seekTo(wall);
              else setStreamStopped(true);
            }}
          />
          <Ctl icon="goforward.10" onPress={() => seekTo(wall + 10)} />
          <Ctl icon="forward.end.fill" onPress={() => jumpEvent(1)} />
          <Ctl icon="plus.magnifyingglass" small onPress={() => setZoom((z) => Math.min(ZOOMS.length - 1, z + 1))} />
        </View>
        <View style={styles.footerRow}>
          {!streamMode && (
            <Pressable onPress={() => setSpeed((s) => SPEEDS[(SPEEDS.indexOf(s) + 1) % SPEEDS.length])} style={styles.pill}>
              <T v="label" color="#fff">
                {speed}×
              </T>
            </Pressable>
          )}
          {adapter?.playback && (
            <Pressable
              onPress={() => {
                player.pause();
                setStreamStopped(true);
                router.push({ pathname: '/timelapse', params: { systemId: params.systemId, cameraId, day: String(dayStart) } });
              }}
              style={[styles.pill, styles.pillRow]}>
              <SymbolView name="timelapse" tintColor="#fff" size={13} />
              <T v="label" color="#fff">
                Timelapse
              </T>
            </Pressable>
          )}
          {neighborIds.length > 0 && (
            <Pressable onPress={() => setShowPip((v) => !v)} style={styles.pill}>
              <T v="label" color="#fff">
                {showPip ? 'Hide nearby' : 'Show nearby'}
              </T>
            </Pressable>
          )}
        </View>
      </View>
    </View>
  );
}

function Ctl({ icon, onPress, big, small }: { icon: React.ComponentProps<typeof SymbolView>['name']; onPress: () => void; big?: boolean; small?: boolean }) {
  return (
    <Pressable onPress={onPress} hitSlop={6} style={[styles.ctl, big && styles.ctlBig]}>
      <SymbolView name={icon} tintColor={small ? 'rgba(255,255,255,0.7)' : '#fff'} size={big ? 26 : small ? 16 : 20} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  center: { alignItems: 'center', justifyContent: 'center', padding: 16 },
  topBar: { position: 'absolute', left: 12, right: 12, flexDirection: 'row', alignItems: 'center', gap: 10 },
  round: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  liveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.14)',
  },
  liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#FF453A' },
  pips: { position: 'absolute', right: 10, gap: 8 },
  controls: { marginTop: 'auto', gap: space.sm, paddingTop: space.md, backgroundColor: 'rgba(10,10,12,0.92)' },
  nextStop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    alignSelf: 'center',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: 'rgba(124,92,255,0.5)',
  },
  chipRow: { gap: 6, paddingHorizontal: 16 },
  buttons: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
  ctl: { width: 42, height: 42, alignItems: 'center', justifyContent: 'center' },
  ctlBig: { width: 60, height: 60, borderRadius: 30, backgroundColor: 'rgba(255,255,255,0.16)' },
  footerRow: { flexDirection: 'row', justifyContent: 'center', gap: 10 },
  pill: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.12)' },
  pillRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
});

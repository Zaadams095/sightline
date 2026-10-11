import { useQuery } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SyncedPip } from '@/components/playback/synced-pip';
import { StepPlayer } from '@/components/stories/step-player';
import { placedSteps, StoryMap } from '@/components/stories/story-map';
import { T } from '@/components/ui/primitives';
import { withFamiliarNames } from '@/familiar/recognize';
import { useT } from '@/i18n/use-t';
import { useLinks } from '@/net/connection';
import { useApp } from '@/state/store';
import { formatSpan, groupStories, storyFromItems, storySummary, storyTitle, type Story } from '@/stories/group';
import { recallStory } from '@/stories/open';
import { getAdapter, useAllCameras } from '@/systems/registry';
import type { CameraSystemAdapter, ReviewItem } from '@/systems/types';
import { space } from '@/theme/tokens';
import { formatClock, formatDay, titleFor } from '@/util/format';

/** Seconds of lead-in before each step and after it. */
const LEAD = 3;

/**
 * One story across cameras: the steps with pictures, the path on the property map, and
 * "Play story", which plays each camera's part back to back with the next camera alongside.
 */
export default function StoryScreen() {
  const t = useT();
  const params = useLocalSearchParams<{ storyId?: string; systemId?: string; ids?: string; start?: string; end?: string }>();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const systems = useApp((s) => s.systems);
  const links = useLinks((s) => s.links);
  const cameraMap = useApp((s) => s.cameraMap);
  const { entries } = useAllCameras({ includeHidden: true });
  const names = useMemo(() => new Map(entries.map((e) => [e.camera.key, e.camera.name])), [entries]);
  const nameOf = useCallback((key: string) => names.get(key) ?? key.slice(key.indexOf(':') + 1), [names]);
  const adapterFor = (systemId: string): CameraSystemAdapter | null => {
    const s = systems.find((x) => x.id === systemId);
    return s ? getAdapter(s, links[s.id]) : null;
  };

  const cached = params.storyId ? recallStory(params.storyId) : null;
  const loaded = useQuery({
    queryKey: ['story', params.systemId, params.ids, params.start, params.end],
    enabled: !cached && !!params.ids,
    queryFn: async (): Promise<Story<ReviewItem> | null> => {
      const start = Number(params.start) || 0;
      const end = Number(params.end) || start + 900;
      const ids = new Set((params.ids ?? '').split(',').filter(Boolean));
      const pool = systems.filter((s) => !params.systemId || s.id === params.systemId);
      const lists = await Promise.allSettled(
        pool.map((s) => getAdapter(s, links[s.id])?.listReview?.({ after: start - 120, before: end + 120, limit: 300 }) ?? Promise.resolve([])),
      );
      const all = withFamiliarNames(lists.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])));
      const mine = all.filter((i) => ids.has(i.id));
      // Exactly what was notified when every event is still there; otherwise regroup.
      if (mine.length >= ids.size) return storyFromItems(mine);
      return groupStories(all, cameraMap).find((s) => s.steps.some((st) => st.items.some((i) => ids.has(i.id)))) ?? storyFromItems(mine);
    },
  });
  const story = cached ?? loaded.data ?? null;

  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  // A step player stays mounted while paused, so Play resumes where it was.
  const [started, setStarted] = useState(false);
  const [wall, setWall] = useState(0);
  const [demo, setDemo] = useState(0);

  const steps = story?.steps ?? [];
  const cur = steps[step];
  const next = steps[step + 1];

  // When not playing, the dot keeps walking the path so the route is easy to see.
  useEffect(() => {
    if (started || steps.length < 2) return;
    const id = setInterval(() => setDemo((d) => (d + 0.025) % (steps.length - 1 + 0.6)), 50);
    return () => clearInterval(id);
  }, [started, steps.length]);

  const progress = started && cur ? step + Math.max(0, Math.min(0.99, (wall - cur.start) / Math.max(1, cur.end - cur.start))) : Math.min(demo, steps.length - 1);

  // Each camera's part plays through, then the next; at the end it rewinds to the start.
  const onDone = useCallback(() => {
    if (step + 1 < steps.length) {
      setStep(step + 1);
    } else {
      setPlaying(false);
      setStarted(false);
      setStep(0);
    }
  }, [step, steps.length]);

  if (!story) {
    return (
      <View style={[styles.root, styles.center, { paddingTop: insets.top }]}>
        {loaded.isLoading ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <T color="#fff" style={{ textAlign: 'center', padding: space.xl }}>
            {t.viewing.story.unavailable}
          </T>
        )}
        <Pressable onPress={() => router.back()} style={[styles.round, { position: 'absolute', top: insets.top + 6, left: 12 }]} accessibilityLabel={t.common.close}>
          <SymbolView name="xmark" tintColor="#fff" size={18} />
        </Pressable>
      </View>
    );
  }

  const mapWidth = width - space.lg * 2;
  const showMap = placedSteps(cameraMap, story).length >= 2;
  const nextAdapter = next ? adapterFor(next.systemId) : null;
  const curAdapter = cur ? adapterFor(cur.systemId) : null;
  const pipW = Math.min(150, width * 0.34);

  const playFrom = (i: number) => {
    if (i !== step || !started) {
      setStep(i);
      setWall(steps[i].start);
    }
    setStarted(true);
    setPlaying(true);
  };

  return (
    <View style={styles.root}>
      <View style={[styles.topBar, { paddingTop: insets.top + 6 }]}>
        <Pressable onPress={() => router.back()} hitSlop={8} accessibilityRole="button" accessibilityLabel={t.common.close} style={styles.round}>
          <SymbolView name="xmark" tintColor="#fff" size={18} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <T v="label" color="#fff" numberOfLines={2}>
            {storyTitle(story)}
          </T>
          <T v="caption" color="rgba(255,255,255,0.7)">
            {formatDay(story.start)} · {formatClock(story.start)} · {formatSpan(story.end - story.start)}
          </T>
        </View>
      </View>

      <View style={{ width, height: width * (9 / 16), backgroundColor: '#000' }}>
        {started && cur ? (
          <StepPlayer
            key={`${step}:${cur.cameraKey}`}
            adapter={curAdapter}
            cameraId={cur.cameraId}
            from={cur.start - LEAD}
            to={cur.end + LEAD}
            playing={playing}
            thumbnailUrl={cur.items.find((i) => i.thumbnailUrl)?.thumbnailUrl}
            onWall={setWall}
            onDone={onDone}
          />
        ) : (
          <Pressable onPress={() => playFrom(step)} style={StyleSheet.absoluteFill} accessibilityRole="button" accessibilityLabel={t.viewing.story.play}>
            {cur?.items.find((i) => i.thumbnailUrl) && (
              <Image source={{ uri: cur.items.find((i) => i.thumbnailUrl)!.thumbnailUrl }} style={StyleSheet.absoluteFill} contentFit="contain" />
            )}
            <View style={[StyleSheet.absoluteFill, styles.center]}>
              <View style={styles.playBig}>
                <SymbolView name="play.fill" tintColor="#fff" size={30} />
              </View>
            </View>
          </Pressable>
        )}
        {cur && (
          <View style={styles.camLabel} pointerEvents="none">
            <T v="caption" color="#fff" overlay numberOfLines={1}>
              {step + 1}/{steps.length} · {nameOf(cur.cameraKey)}
              {playing && wall ? ` · ${formatClock(wall, true)}` : ''}
            </T>
          </View>
        )}
        {/* The next camera, at the same moment: often shows them arriving. */}
        {playing && next && nextAdapter?.recordingSegments && nextAdapter.playback && (
          <View style={styles.pip}>
            <SyncedPip
              adapter={nextAdapter}
              cameraId={next.cameraId}
              name={t.viewing.story.next(nameOf(next.cameraKey))}
              winStart={next.start - 60}
              winEnd={next.end + 30}
              wall={wall}
              playing={playing}
              rate={1}
              width={pipW}
              onPress={() => playFrom(step + 1)}
            />
          </View>
        )}
      </View>

      <View style={styles.controls}>
        <Ctl icon="backward.end.fill" label={t.viewing.story.prevCamera} disabled={step === 0} onPress={() => playFrom(Math.max(0, step - 1))} />
        <Pressable
          onPress={() => (playing ? setPlaying(false) : playFrom(step))}
          accessibilityRole="button"
          accessibilityLabel={playing ? t.viewing.story.pauseStory : t.viewing.story.play}
          style={styles.playPill}>
          <SymbolView name={playing ? 'pause.fill' : 'play.fill'} tintColor="#fff" size={16} />
          <T v="label" color="#fff">
            {playing ? t.viewing.playback.pause : t.viewing.story.play}
          </T>
        </Pressable>
        <Ctl icon="forward.end.fill" label={t.viewing.story.nextCamera} disabled={step >= steps.length - 1} onPress={() => playFrom(Math.min(steps.length - 1, step + 1))} />
      </View>

      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg, paddingBottom: insets.bottom + space.xxl }}>
        <T color="rgba(255,255,255,0.85)">{storySummary(story, nameOf)}</T>

        {showMap && <StoryMap map={cameraMap} story={story} names={names} width={mapWidth} progress={progress} />}

        <View style={{ gap: 2 }}>
          {steps.map((s, i) => {
            const thumb = s.items.find((x) => x.thumbnailUrl)?.thumbnailUrl;
            const gap = i > 0 ? Math.round(s.start - steps[i - 1].end) : null;
            return (
              <Pressable
                key={`${s.cameraKey}:${i}`}
                onPress={() => playFrom(i)}
                style={[styles.stepRow, i === step && { backgroundColor: 'rgba(255,255,255,0.08)' }]}
                accessibilityRole="button"
                accessibilityLabel={t.viewing.story.playCamera(nameOf(s.cameraKey))}>
                <View style={styles.rail}>
                  <View style={[styles.dot, i === step && styles.dotOn]} />
                  {i < steps.length - 1 && <View style={styles.line} />}
                </View>
                <View style={styles.thumb}>{thumb ? <Image source={{ uri: thumb }} style={StyleSheet.absoluteFill} contentFit="cover" /> : null}</View>
                <View style={{ flex: 1, gap: 2 }}>
                  <T v="label" color="#fff">
                    {nameOf(s.cameraKey)}
                  </T>
                  <T v="caption" color="rgba(255,255,255,0.65)">
                    {formatClock(s.start, true)} · {titleFor({ objects: s.objects, subLabels: s.names })}
                    {gap != null ? ` · ${gap <= 0 ? t.viewing.story.sameTime : t.viewing.story.later(formatSpan(gap))}` : ''}
                  </T>
                </View>
                <Pressable
                  onPress={() =>
                    router.push({ pathname: '/playback', params: { systemId: s.systemId, cameraId: s.cameraId, start: String(Math.floor(s.start - LEAD)), reviewId: s.items[0].id } })
                  }
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={t.viewing.story.openRecordings(nameOf(s.cameraKey))}>
                  <SymbolView name="arrow.up.forward.square" tintColor="rgba(255,255,255,0.7)" size={18} />
                </Pressable>
              </Pressable>
            );
          })}
        </View>
        {!story.mapped && (
          <T v="caption" color="rgba(255,255,255,0.5)">
            {t.viewing.story.unmapped}
          </T>
        )}
      </ScrollView>
    </View>
  );
}

function Ctl({ icon, label, onPress, disabled }: { icon: React.ComponentProps<typeof SymbolView>['name']; label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} hitSlop={6} accessibilityRole="button" accessibilityLabel={label} style={[styles.ctl, disabled && { opacity: 0.35 }]}>
      <SymbolView name={icon} tintColor="#fff" size={20} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0A0A0C' },
  center: { alignItems: 'center', justifyContent: 'center' },
  topBar: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingBottom: 8 },
  round: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.14)', alignItems: 'center', justifyContent: 'center' },
  playBig: { width: 64, height: 64, borderRadius: 32, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center' },
  camLabel: { position: 'absolute', left: 8, top: 8, maxWidth: '70%', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, backgroundColor: 'rgba(0,0,0,0.55)' },
  pip: { position: 'absolute', right: 8, bottom: 8 },
  controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 16, paddingVertical: 10, paddingHorizontal: 12 },
  ctl: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  playPill: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 18, minHeight: 44, borderRadius: 22, backgroundColor: 'rgba(124,92,255,0.75)' },
  stepRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: 6, paddingRight: 8, borderRadius: 10 },
  rail: { width: 14, alignItems: 'center', alignSelf: 'stretch', justifyContent: 'center' },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: 'rgba(255,255,255,0.4)' },
  dotOn: { backgroundColor: '#7C5CFF', transform: [{ scale: 1.3 }] },
  line: { position: 'absolute', top: '50%', bottom: -14, width: 2, backgroundColor: 'rgba(255,255,255,0.2)' },
  thumb: { width: 96, height: 54, borderRadius: 8, overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.08)' },
});

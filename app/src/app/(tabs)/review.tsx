import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, SectionList, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AskBar } from '@/components/review/ask-bar';
import { PackagesCard } from '@/components/review/packages-card';
import { SavedPanel } from '@/components/review/saved-panel';
import { SearchPanel } from '@/components/review/search-panel';
import { Button, Chip, T } from '@/components/ui/primitives';
import { useLinks } from '@/net/connection';
import { useApp } from '@/state/store';
import { useFeatureSupport } from '@/systems/caps';
import { getAdapter, useAllCameras } from '@/systems/registry';
import type { ReviewItem, Severity } from '@/systems/types';
import { space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';
import { formatClock, formatDay, titleFor } from '@/util/format';

type Filter = 'all' | Severity;
type Mode = 'events' | 'search' | 'saved';

export default function ReviewScreen() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const qc = useQueryClient();
  const systems = useApp((s) => s.systems);
  const links = useLinks((s) => s.links);
  const radius = useApp((s) => s.appearance.radius);
  const { entries } = useAllCameras({ includeHidden: true });
  const support = useFeatureSupport();
  const [mode, setMode] = useState<Mode>('events');
  const savedCount = useApp((s) => s.savedClips.length);
  const [filter, setFilter] = useState<Filter>('alert');
  const [unreviewedOnly, setUnreviewedOnly] = useState(false);
  const [camera, setCamera] = useState<string | null>(null);

  const reviewable = systems.filter((s) => {
    const a = getAdapter(s, links[s.id]);
    return a?.capabilities.review && (links[s.id]?.mode === 'lan' || links[s.id]?.mode === 'tunnel');
  });

  const query = useQuery({
    queryKey: ['review-all', reviewable.map((s) => `${s.id}@${links[s.id]?.baseUrl}`).join('|'), filter],
    enabled: reviewable.length > 0,
    queryFn: async () => {
      const after = Date.now() / 1000 - 7 * 86400;
      const res = await Promise.allSettled(
        reviewable.map((s) =>
          getAdapter(s, links[s.id])!.listReview!({ after, severity: filter === 'all' ? undefined : filter, limit: 300 }),
        ),
      );
      return {
        items: res.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])).sort((a, b) => b.startTime - a.startTime),
        // Name systems that failed so one bad recorder doesn't look like "nothing happened".
        failed: reviewable.filter((_, i) => res[i].status === 'rejected').map((s) => s.name),
      };
    },
  });

  const names = useMemo(() => new Map(entries.map((e) => [e.camera.key, e.camera.name])), [entries]);

  const sections = useMemo(() => {
    const items = (query.data?.items ?? []).filter(
      (r) => (!unreviewedOnly || !r.reviewed) && (!camera || `${r.systemId}:${r.cameraId}` === camera),
    );
    const byDay = new Map<string, ReviewItem[]>();
    for (const r of items) {
      const day = formatDay(r.startTime);
      byDay.set(day, [...(byDay.get(day) ?? []), r]);
    }
    return [...byDay].map(([title, data]) => ({ title, data }));
  }, [query.data, unreviewedOnly, camera]);

  const open = (r: ReviewItem) => {
    const s = systems.find((x) => x.id === r.systemId);
    const a = s && getAdapter(s, links[s.id]);
    if (a?.markReviewed && !r.reviewed) {
      a.markReviewed([r.id])
        .then(() => qc.invalidateQueries({ queryKey: ['review-all'] }))
        .catch(() => {});
    }
    router.push({
      pathname: '/playback',
      params: { systemId: r.systemId, cameraId: r.cameraId, start: String(Math.floor(r.startTime - 5)), reviewId: r.id },
    });
  };

  const modeTabs = (
    <View style={styles.modes}>
      {([
        ['events', 'Events'],
        ['search', 'Search'],
        ['saved', savedCount ? `Saved (${savedCount})` : 'Saved'],
      ] as [Mode, string][])
        // Search only appears when a connected system can do it.
        .filter(([m]) => m !== 'search' || support.search)
        .map(([m, label]) => (
          <Pressable key={m} onPress={() => setMode(m)} style={[styles.mode, mode === m && { backgroundColor: p.surfaceRaised }]}>
          <T v="label" color={mode === m ? p.text : p.textMuted}>
            {label}
          </T>
        </Pressable>
      ))}
    </View>
  );

  if (mode !== 'events') {
    return (
      <ScrollView
        style={{ backgroundColor: p.bg }}
        contentContainerStyle={{ paddingTop: insets.top + space.sm, paddingBottom: 120, gap: space.md }}
        keyboardShouldPersistTaps="handled">
        <T v="title" style={{ paddingHorizontal: space.lg }}>
          Recordings
        </T>
        <AskBar />
        {modeTabs}
        {mode === 'search' ? <SearchPanel /> : <SavedPanel />}
      </ScrollView>
    );
  }

  return (
    <SectionList
      style={{ backgroundColor: p.bg }}
      sections={sections}
      keyExtractor={(r) => `${r.systemId}:${r.id}`}
      stickySectionHeadersEnabled
      contentContainerStyle={{ paddingBottom: 120 }}
      refreshControl={<RefreshControl refreshing={query.isRefetching} onRefresh={() => query.refetch()} />}
      ListHeaderComponent={
        <View style={{ paddingTop: insets.top + space.sm, gap: space.md, paddingBottom: space.sm }}>
          <T v="title" style={{ paddingHorizontal: space.lg }}>
            Recordings
          </T>
          <AskBar />
          {modeTabs}
          <PackagesCard names={names} />
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
            <Chip label="Important" selected={filter === 'alert'} onPress={() => setFilter('alert')} />
            <Chip label="Other motion" selected={filter === 'detection'} onPress={() => setFilter('detection')} />
            <Chip label="Everything" selected={filter === 'all'} onPress={() => setFilter('all')} />
            <Chip label="Not seen yet" selected={unreviewedOnly} onPress={() => setUnreviewedOnly((v) => !v)} />
          </ScrollView>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
            <Chip label="All cameras" selected={!camera} onPress={() => setCamera(null)} />
            {entries.map((e) => (
              <Chip key={e.camera.key} label={e.camera.name} selected={camera === e.camera.key} onPress={() => setCamera(e.camera.key)} />
            ))}
          </ScrollView>
        </View>
      }
      ListEmptyComponent={
        <ReviewEmpty
          loading={query.isLoading}
          failed={query.data?.failed ?? []}
          hasReviewable={reviewable.length > 0}
          hasSystems={systems.length > 0}
          anyConnected={systems.some((s) => links[s.id]?.mode === 'lan' || links[s.id]?.mode === 'tunnel')}
        />
      }
      renderSectionHeader={({ section }) => (
        <View style={[styles.sectionHeader, { backgroundColor: p.bg }]}>
          <T v="label" muted>
            {section.title}
          </T>
        </View>
      )}
      renderItem={({ item }) => (
        <Pressable onPress={() => open(item)} style={({ pressed }) => [styles.item, pressed && { backgroundColor: p.surface }]}>
          <View style={[styles.thumbWrap, { borderRadius: Math.min(radius, 12), backgroundColor: p.surface }]}>
            {item.thumbnailUrl && <Image source={{ uri: item.thumbnailUrl }} style={StyleSheet.absoluteFill} contentFit="cover" />}
          </View>
          <View style={{ flex: 1, gap: 3 }}>
            <View style={styles.titleRow}>
              {!item.reviewed && <View style={[styles.dot, { backgroundColor: p.accent }]} />}
              <T v="label" numberOfLines={1}>
                {titleFor(item)}
              </T>
            </View>
            <T v="caption" muted numberOfLines={1}>
              {names.get(`${item.systemId}:${item.cameraId}`) ?? item.cameraId} · {formatClock(item.startTime)}
            </T>
            {item.zones.length > 0 && (
              <T v="caption" muted numberOfLines={1}>
                {item.zones.join(', ')}
              </T>
            )}
          </View>
          {item.severity === 'alert' && <View style={[styles.sev, { backgroundColor: p.danger }]} />}
        </Pressable>
      )}
    />
  );
}

/** Explains why there's nothing to show, and what to do about it. */
function ReviewEmpty({
  loading,
  failed,
  hasReviewable,
  hasSystems,
  anyConnected,
}: {
  loading: boolean;
  failed: string[];
  hasReviewable: boolean;
  hasSystems: boolean;
  anyConnected: boolean;
}) {
  let title = 'Nothing to review';
  let body = 'When something happens on your cameras, it shows up here.';
  let action: { label: string; onPress: () => void } | null = null;
  if (loading) {
    title = 'Loading…';
    body = '';
  } else if (failed.length) {
    title = `Couldn’t load events from ${failed.join(', ')}`;
    body = 'Pull down to try again.';
  } else if (!hasSystems) {
    title = 'No cameras yet';
    body = 'Add your recorder or cameras to see what happened.';
    action = { label: 'Add cameras', onPress: () => router.push('/onboarding') };
  } else if (!anyConnected) {
    title = 'Can’t reach your cameras right now';
    body = 'Pull down to try again, or check Settings → Diagnostics.';
  } else if (!hasReviewable) {
    title = 'Live view only';
    body = 'Your cameras are connected for live view. To look back at what happened, add the recorder or software that records them.';
    action = { label: 'Add a recorder', onPress: () => router.push('/onboarding') };
  }
  return (
    <View style={styles.empty}>
      <T v="heading" style={{ textAlign: 'center' }}>
        {title}
      </T>
      {!!body && (
        <T muted style={{ textAlign: 'center' }}>
          {body}
        </T>
      )}
      {action && <Button title={action.label} kind="secondary" onPress={action.onPress} style={{ alignSelf: 'stretch' }} />}
    </View>
  );
}

const styles = StyleSheet.create({
  chips: { gap: space.sm, paddingHorizontal: space.lg },
  modes: { flexDirection: 'row', marginHorizontal: space.lg, padding: 3, borderRadius: 12, gap: 3, backgroundColor: 'rgba(127,127,127,0.12)' },
  mode: { flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: 9 },
  sectionHeader: { paddingHorizontal: space.lg, paddingVertical: space.sm },
  item: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.sm },
  thumbWrap: { width: 128, height: 72, overflow: 'hidden' },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  sev: { width: 4, alignSelf: 'stretch', borderRadius: 2 },
  empty: { alignItems: 'center', padding: space.xxl, gap: space.sm },
});

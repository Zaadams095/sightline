import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, useWindowDimensions, View, type ViewToken } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { autoLayout, CameraGrid } from '@/components/camera-grid';
import { CameraTile } from '@/components/camera-tile';
import { ConnectionBadge } from '@/components/connection-badge';
import { DemoBanner } from '@/components/demo-banner';
import { Button, IconButton, T } from '@/components/ui/primitives';
import { useLinks } from '@/net/connection';
import { useApp } from '@/state/store';
import { usesGateway } from '@/systems/catalog';
import { useAllCameras, type CameraEntry } from '@/systems/registry';
import { space } from '@/theme/tokens';
import { syncWidgets } from '@/widgets/sync';
import { syncAssistant } from '@/ask/sync';
import { syncWatch } from '@/watch/sync';
import { usePalette } from '@/theme/use-palette';

const TABLET_MIN_WIDTH = 700;

export default function LiveScreen() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { entries: allEntries, isLoading, refetch, isRefetching } = useAllCameras();
  const groups = useApp((s) => s.cameraGroups);
  const systems = useApp((s) => s.systems);
  const hasSystems = systems.length > 0;
  // Still connecting to at least one system that goes through the gateway.
  const connecting = useLinks((st) =>
    systems.some((s) => usesGateway(s.kind) && (st.links[s.id]?.mode ?? 'connecting') === 'connecting'),
  );
  const activeGroupId = useApp((s) => s.activeGroupId);
  const setActiveGroup = useApp((s) => s.setActiveGroup);
  const activeGroup = groups.find((g) => g.id === activeGroupId);
  const entries = useMemo(
    () => (activeGroup ? allEntries.filter((e) => activeGroup.cameraKeys.includes(e.camera.key)) : allEntries),
    [allEntries, activeGroup],
  );
  // Keep Home Screen widget snapshots fresh while the app is open (throttled).
  useEffect(() => {
    void syncWidgets(allEntries);
    void syncWatch(allEntries);
    void syncAssistant(allEntries);
  }, [allEntries]);
  const { phoneColumns, density } = useApp((s) => s.appearance);
  const gridViews = useApp((s) => s.gridViews);
  const activeId = useApp((s) => s.activeGridViewId);
  const setActive = useApp((s) => s.setActiveGridView);
  const tablet = width >= TABLET_MIN_WIDTH;

  const open = useCallback((e: CameraEntry, poster?: string) => {
    router.push({ pathname: '/camera/[key]', params: { key: e.camera.key, poster: poster ?? '' } });
  }, []);

  // One chip row: All, camera groups, and (on iPad) custom grid layouts.
  const select = (kind: 'all' | 'group' | 'layout', id: string | null = null) => {
    setActiveGroup(kind === 'group' ? id : null);
    setActive(kind === 'layout' ? id : null);
  };
  const chips: { key: string; label: string; selected: boolean; onPress: () => void }[] = [
    { key: 'all', label: 'All', selected: !activeGroupId && !(tablet && activeId), onPress: () => select('all') },
    ...groups.map((g) => ({ key: g.id, label: g.name, selected: g.id === activeGroupId, onPress: () => select('group', g.id) })),
    ...(tablet
      ? gridViews.map((v) => ({ key: `layout-${v.id}`, label: `Layout: ${v.name}`, selected: v.id === activeId && !activeGroupId, onPress: () => select('layout', v.id) }))
      : []),
  ];
  const header = (
    <View style={{ paddingTop: insets.top + space.sm, paddingBottom: space.sm, gap: space.sm }}>
      <View style={styles.header}>
        <T v="title">Live</T>
        <View style={styles.headerRight}>
          {tablet && allEntries.length > 0 && (
            <IconButton icon="rectangle.on.rectangle" label="Wall display" onPress={() => router.push('/wall')} />
          )}
          <ConnectionBadge />
        </View>
      </View>
      <DemoBanner />
      {allEntries.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.viewTabs}>
          {chips.map((c) => (
            <Pressable
              key={c.key}
              onPress={c.onPress}
              accessibilityRole="button"
              accessibilityState={{ selected: c.selected }}
              hitSlop={{ top: 6, bottom: 6 }}
              style={[styles.viewTab, { backgroundColor: c.selected ? p.accent : p.surfaceRaised }]}>
              <T v="label" color={c.selected ? p.accentText : p.text}>
                {c.label}
              </T>
            </Pressable>
          ))}
          <Pressable
            onPress={() => router.push('/settings/groups')}
            accessibilityRole="button"
            accessibilityLabel={groups.length ? 'Edit groups' : 'Make a camera group'}
            hitSlop={{ top: 6, bottom: 6 }}
            style={[styles.viewTab, styles.viewTabRow, { backgroundColor: 'transparent', borderWidth: StyleSheet.hairlineWidth, borderColor: p.border }]}>
            {!groups.length && <SymbolView name="plus" tintColor={p.textMuted} size={12} weight="semibold" />}
            <T v="label" muted>
              {groups.length ? 'Edit groups' : 'Group'}
            </T>
          </Pressable>
        </ScrollView>
      )}
    </View>
  );

  if ((isLoading || connecting) && allEntries.length === 0) {
    return (
      <View style={{ flex: 1, backgroundColor: p.bg }}>
        {header}
        <View style={styles.empty}>
          <ActivityIndicator size="large" />
          <T muted>Connecting to your cameras…</T>
        </View>
      </View>
    );
  }

  if (allEntries.length === 0) {
    return (
      <View style={{ flex: 1, backgroundColor: p.bg }}>
        {header}
        {hasSystems ? (
          <View style={styles.empty}>
            <SymbolView name="video.slash" tintColor={p.textMuted} size={40} />
            <T v="heading">Can’t see your cameras</T>
            <T muted style={{ textAlign: 'center' }}>
              Your recorder or cameras didn’t answer. If you’re away from home, check Settings → Away from home.
            </T>
            <Button title="Try again" onPress={() => refetch()} style={{ alignSelf: 'stretch' }} />
            <Button title="Check the connection" kind="ghost" onPress={() => router.push('/settings/diagnostics')} style={{ alignSelf: 'stretch' }} />
          </View>
        ) : (
          <View style={styles.empty}>
            <SymbolView name="video.badge.plus" tintColor={p.accent} size={44} />
            <T v="heading">No cameras yet</T>
            <T muted style={{ textAlign: 'center' }}>
              Add your recorder, camera software or cameras to watch them here.
            </T>
            <Button title="Add cameras" onPress={() => router.push('/onboarding')} style={{ alignSelf: 'stretch' }} />
          </View>
        )}
      </View>
    );
  }

  if (tablet) {
    const view = activeGroupId ? undefined : gridViews.find((v) => v.id === activeId);
    const tiles = view?.tiles ?? autoLayout(entries.map((e) => e.camera.key), width);
    return (
      <View style={{ flex: 1, backgroundColor: p.bg }}>
        {header}
        <CameraGrid entries={entries} tiles={tiles} width={width - space.lg} onOpen={open} />
      </View>
    );
  }

  return <PhoneStack entries={entries} columns={phoneColumns} gap={density === 'compact' ? 6 : 12} header={header} onOpen={open} refreshing={isRefetching} onRefresh={refetch} />;
}

function PhoneStack({
  entries,
  columns,
  gap,
  header,
  onOpen,
  refreshing,
  onRefresh,
}: {
  entries: CameraEntry[];
  columns: 1 | 2;
  gap: number;
  header: React.ReactElement;
  onOpen: (e: CameraEntry, poster?: string) => void;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const p = usePalette();
  const { width } = useWindowDimensions();
  const [visible, setVisible] = useState<Set<string>>(new Set());
  const [onViewable] = useState(() => ({ viewableItems }: { viewableItems: ViewToken<CameraEntry>[] }) => {
    setVisible(new Set(viewableItems.map((v) => v.item.camera.key)));
  });
  const tileW = (width - space.lg * 2 - gap * (columns - 1)) / columns;

  return (
    <FlatList
      style={{ backgroundColor: p.bg }}
      data={entries}
      key={columns}
      numColumns={columns}
      keyExtractor={(e) => e.camera.key}
      ListHeaderComponent={<View style={{ marginHorizontal: -space.lg }}>{header}</View>}
      contentContainerStyle={{ paddingHorizontal: space.lg, paddingBottom: 120, gap }}
      columnWrapperStyle={columns > 1 ? { gap } : undefined}
      onViewableItemsChanged={onViewable}
      viewabilityConfig={{ itemVisiblePercentThreshold: 10 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      renderItem={({ item }) => (
        <CameraTile
          camera={item.camera}
          adapter={item.adapter}
          active={visible.has(item.camera.key)}
          requestHeight={columns === 1 ? 540 : 300}
          style={{ width: tileW, height: tileW / item.camera.aspect }}
          onPress={(poster) => onOpen(item, poster)}
        />
      )}
    />
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
  },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.md, padding: space.xl },
  viewTabs: { flexDirection: 'row', gap: space.sm, paddingHorizontal: space.lg, paddingBottom: space.md },
  viewTab: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999, minHeight: 34, justifyContent: 'center' },
  viewTabRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
});

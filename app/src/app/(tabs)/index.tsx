import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, useWindowDimensions, View, type ViewToken } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { autoLayout, CameraGrid } from '@/components/camera-grid';
import { CameraTile } from '@/components/camera-tile';
import { ConnectionBadge } from '@/components/connection-badge';
import { Button, T } from '@/components/ui/primitives';
import { useApp } from '@/state/store';
import { useAllCameras, type CameraEntry } from '@/systems/registry';
import { space } from '@/theme/tokens';
import { syncWidgets } from '@/widgets/sync';
import { usePalette } from '@/theme/use-palette';

const TABLET_MIN_WIDTH = 700;

export default function LiveScreen() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { entries: allEntries, isLoading, refetch, isRefetching } = useAllCameras();
  const groups = useApp((s) => s.cameraGroups);
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
      ? gridViews.map((v) => ({ key: `layout-${v.id}`, label: `⊞ ${v.name}`, selected: v.id === activeId && !activeGroupId, onPress: () => select('layout', v.id) }))
      : []),
  ];
  const header = (
    <View style={{ paddingTop: insets.top + space.sm, paddingBottom: space.sm, gap: space.sm }}>
      <View style={styles.header}>
        <T v="title">Live</T>
        <ConnectionBadge />
      </View>
      {allEntries.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.viewTabs}>
          {chips.map((c) => (
            <Pressable key={c.key} onPress={c.onPress} style={[styles.viewTab, { backgroundColor: c.selected ? p.accent : p.surfaceRaised }]}>
              <T v="label" color={c.selected ? p.accentText : p.text}>
                {c.label}
              </T>
            </Pressable>
          ))}
          <Pressable onPress={() => router.push('/settings/groups')} style={[styles.viewTab, { backgroundColor: 'transparent', borderWidth: StyleSheet.hairlineWidth, borderColor: p.border }]}>
            <T v="label" muted>
              {groups.length ? 'Edit groups' : '+ Group'}
            </T>
          </Pressable>
        </ScrollView>
      )}
    </View>
  );

  if (!isLoading && allEntries.length === 0) {
    return (
      <View style={{ flex: 1, backgroundColor: p.bg }}>
        {header}
        <View style={styles.empty}>
          <T v="heading">No cameras yet</T>
          <T muted style={{ textAlign: 'center' }}>
            If you&apos;re away from home, make sure your VPN is set up in Settings.
          </T>
          <Button title="Retry" kind="secondary" onPress={() => refetch()} style={{ alignSelf: 'stretch' }} />
        </View>
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
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.md, padding: space.xl },
  viewTabs: { flexDirection: 'row', gap: space.sm, paddingHorizontal: space.lg, paddingBottom: space.md },
  viewTab: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999 },
});

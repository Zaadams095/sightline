import { router } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, useWindowDimensions, View, type ViewToken } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { autoLayout, CameraGrid } from '@/components/camera-grid';
import { CameraTile } from '@/components/camera-tile';
import { ConnectionBadge } from '@/components/connection-badge';
import { Button, T } from '@/components/ui/primitives';
import { useApp } from '@/state/store';
import { useAllCameras, type CameraEntry } from '@/systems/registry';
import { space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';

const TABLET_MIN_WIDTH = 700;

export default function LiveScreen() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { entries, isLoading, refetch, isRefetching } = useAllCameras();
  const { phoneColumns, density } = useApp((s) => s.appearance);
  const gridViews = useApp((s) => s.gridViews);
  const activeId = useApp((s) => s.activeGridViewId);
  const setActive = useApp((s) => s.setActiveGridView);
  const tablet = width >= TABLET_MIN_WIDTH;

  const open = useCallback((e: CameraEntry) => {
    router.push({ pathname: '/camera/[key]', params: { key: e.camera.key } });
  }, []);

  const header = (
    <View style={[styles.header, { paddingTop: insets.top + space.sm }]}>
      <T v="title">Live</T>
      <ConnectionBadge />
    </View>
  );

  if (!isLoading && entries.length === 0) {
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
    const view = gridViews.find((v) => v.id === activeId);
    const tiles = view?.tiles ?? autoLayout(entries.map((e) => e.camera.key), width);
    return (
      <View style={{ flex: 1, backgroundColor: p.bg }}>
        {header}
        {gridViews.length > 0 && (
          <View style={styles.viewTabs}>
            {[{ id: null as string | null, name: 'All' }, ...gridViews].map((v) => (
              <Pressable
                key={v.id ?? 'all'}
                onPress={() => setActive(v.id)}
                style={[styles.viewTab, { backgroundColor: v.id === activeId ? p.accent : p.surfaceRaised }]}>
                <T v="label" color={v.id === activeId ? p.accentText : p.text}>
                  {v.name}
                </T>
              </Pressable>
            ))}
          </View>
        )}
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
  onOpen: (e: CameraEntry) => void;
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
          onPress={() => onOpen(item)}
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

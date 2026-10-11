import { useQuery } from '@tanstack/react-query';
import { Directory, File, Paths } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Image as RNImage, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CameraMapView } from '@/components/map/camera-map-view';
import { Button, Chip, T } from '@/components/ui/primitives';
import { useT } from '@/i18n/use-t';
import { neighborsOf } from '@/map/graph';
import { useLinks } from '@/net/connection';
import { useApp } from '@/state/store';
import { getAdapter, useAllCameras } from '@/systems/registry';
import { useLargeText } from '@/theme/text-scale';
import { space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';
import { nowSec } from '@/util/format';

type Mode = 'view' | 'place' | 'link';
const ACTIVE_WINDOW_SEC = 180;

export default function MapScreen() {
  const p = usePalette();
  const t = useT();
  const large = useLargeText();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const map = useApp((s) => s.cameraMap);
  const setMap = useApp((s) => s.setCameraMap);
  const systems = useApp((s) => s.systems);
  const links = useLinks((s) => s.links);
  const { entries } = useAllCameras({ includeHidden: true });
  const [mode, setMode] = useState<Mode>('view');
  const [selected, setSelected] = useState<string | null>(null);
  const [linkFrom, setLinkFrom] = useState<string | null>(null);

  const names = useMemo(() => new Map(entries.map((e) => [e.camera.key, e.camera.name])), [entries]);
  const unplaced = entries.filter((e) => !map.placements[e.camera.key]);
  const mapW = Math.min(width - space.lg * 2, 900);

  // Cameras with activity in the last few minutes light up on the map.
  const recent = useQuery({
    queryKey: ['map-activity', systems.map((s) => `${s.id}@${links[s.id]?.baseUrl}`).join('|')],
    refetchInterval: 15_000,
    enabled: mode === 'view',
    queryFn: async () => {
      const after = nowSec() - ACTIVE_WINDOW_SEC;
      const res = await Promise.allSettled(
        systems.map((s) => getAdapter(s, links[s.id])?.listReview?.({ after, limit: 50 }) ?? Promise.resolve([])),
      );
      return new Set(res.flatMap((r) => (r.status === 'fulfilled' ? r.value.map((i) => `${i.systemId}:${i.cameraId}`) : [])));
    },
  });

  const pickBackground = async () => {
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8 });
    if (res.canceled) return;
    const asset = res.assets[0];
    const dir = new Directory(Paths.document, 'map');
    if (!dir.exists) dir.create();
    const dest = new File(dir, `background-${Date.now()}.jpg`);
    new File(asset.uri).copy(dest);
    const aspect = asset.width && asset.height ? asset.width / asset.height : await sizeOf(dest.uri);
    setMap({ background: dest.uri, aspect });
  };

  const place = (key: string) => {
    setMap({ placements: { ...map.placements, [key]: { x: 0.5, y: 0.5, heading: 180, fov: 90 } } });
    setSelected(key);
  };

  const updateSelected = (patch: Partial<{ heading: number; fov: number }>) => {
    if (!selected || !map.placements[selected]) return;
    setMap({ placements: { ...map.placements, [selected]: { ...map.placements[selected], ...patch } } });
  };

  const onPressCamera = (key: string) => {
    if (mode === 'view') {
      router.push({ pathname: '/camera/[key]', params: { key } });
    } else if (mode === 'place') {
      setSelected(key);
    } else if (!linkFrom) {
      setLinkFrom(key);
    } else if (linkFrom !== key) {
      const exists = map.links.find((l) => (l.a === linkFrom && l.b === key) || (l.a === key && l.b === linkFrom));
      const transitSec = neighborsOf({ ...map, links: [] }, linkFrom, 50).find((n) => n.key === key)?.transitSec ?? 20;
      setMap({ links: exists ? map.links.filter((l) => l !== exists) : [...map.links, { a: linkFrom, b: key, transitSec }] });
      setLinkFrom(null);
    }
  };

  const sel = selected ? map.placements[selected] : null;

  return (
    <ScrollView style={{ backgroundColor: p.bg }} contentContainerStyle={{ paddingTop: insets.top + space.sm, paddingHorizontal: space.lg, paddingBottom: 140, gap: space.lg }}>
      <View style={styles.header}>
        <T v="title">{t.home.tabs.map}</T>
        <View style={styles.row}>
          <Chip label={t.home.map.view} selected={mode === 'view'} onPress={() => setMode('view')} accessibilityLabel={t.home.map.viewA11y} />
          <Chip label={t.home.map.place} selected={mode === 'place'} onPress={() => setMode('place')} accessibilityLabel={t.home.map.placeA11y} />
          <Chip
            label={t.home.map.connect}
            selected={mode === 'link'}
            onPress={() => {
              setMode('link');
              setLinkFrom(null);
            }}
            accessibilityLabel={t.home.map.connectA11y}
          />
        </View>
      </View>
      <T v="caption" muted>
        {mode === 'view'
          ? t.home.map.viewHelp
          : mode === 'place'
            ? t.home.map.placeHelp
            : t.home.map.connectHelp}
      </T>

      <CameraMapView
        map={map}
        width={mapW}
        names={names}
        active={mode === 'view' ? recent.data : undefined}
        selected={mode === 'link' ? linkFrom : selected}
        editable={mode === 'place'}
        onPressCamera={onPressCamera}
        onMoveCamera={(key, x, y) => setMap({ placements: { ...map.placements, [key]: { ...map.placements[key], x, y } } })}
      />

      {mode === 'view' && (
        <T muted>
          {Object.keys(map.placements).length === 0
            ? t.home.map.emptyHelp
            : t.home.map.glowHelp}
        </T>
      )}

      {mode === 'place' && (
        <View style={{ gap: space.md }}>
          <Button title={map.background ? t.home.map.changeImage : t.home.map.addImage} kind="secondary" onPress={pickBackground} />
          {sel && selected && (
            <View style={[styles.panel, { backgroundColor: p.surface, borderColor: p.border }]}>
              <T v="label">{names.get(selected)}</T>
              <T v="caption" muted>
                {t.home.map.aimHelp}
              </T>
              <View style={styles.row}>
                <Chip
                  label={t.home.map.turnLeft}
                  accessibilityLabel={t.home.map.turnLeftA11y}
                  selected={false}
                  onPress={() => updateSelected({ heading: (sel.heading + 345) % 360 })}
                />
                <Chip
                  label={t.home.map.turnRight}
                  accessibilityLabel={t.home.map.turnRightA11y}
                  selected={false}
                  onPress={() => updateSelected({ heading: (sel.heading + 15) % 360 })}
                />
                <Chip label={t.home.map.narrower} selected={false} onPress={() => updateSelected({ fov: Math.max(30, sel.fov - 15) })} />
                <Chip label={t.home.map.wider} selected={false} onPress={() => updateSelected({ fov: Math.min(180, sel.fov + 15) })} />
              </View>
              <Button
                title={t.home.map.removeFromMap}
                kind="ghost"
                onPress={() => {
                  const placements = { ...map.placements };
                  delete placements[selected];
                  setMap({ placements, links: map.links.filter((l) => l.a !== selected && l.b !== selected) });
                  setSelected(null);
                }}
              />
            </View>
          )}
          {unplaced.length > 0 && (
            <View style={{ gap: space.sm }}>
              <T v="label" muted>
                {t.home.map.tapToAdd}
              </T>
              <View style={styles.wrap}>
                {unplaced.map((e) => (
                  <Chip
                    key={e.camera.key}
                    label={e.camera.name}
                    accessibilityLabel={t.home.map.addToMap(e.camera.name)}
                    selected={false}
                    onPress={() => place(e.camera.key)}
                  />
                ))}
              </View>
            </View>
          )}
        </View>
      )}

      {mode === 'link' && (
        <View style={{ gap: space.sm }}>
          <T muted>
            {linkFrom
              ? t.home.map.nextFrom(names.get(linkFrom) ?? '')
              : t.home.map.linkHelp}
          </T>
          {map.links.length > 0 && (
            <T v="caption" muted>
              {t.home.map.walkTimeHelp}
            </T>
          )}
          {map.links.map((l) => (
            <View key={`${l.a}|${l.b}`} style={[styles.linkRow, { borderColor: p.border }, large && styles.linkRowStacked]}>
              <T style={large ? undefined : { flex: 1 }}>
                {t.home.map.pair(names.get(l.a) ?? '', names.get(l.b) ?? '')}
              </T>
              <Chip
                label={t.home.map.about(l.transitSec)}
                accessibilityLabel={t.home.map.walkTimeA11y(l.transitSec)}
                selected={false}
                onPress={() =>
                  setMap({
                    links: map.links.map((x) => (x === l ? { ...x, transitSec: l.transitSec >= 120 ? 5 : l.transitSec + 10 } : x)),
                  })
                }
              />
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

function sizeOf(uri: string): Promise<number> {
  return new Promise((resolve) => RNImage.getSize(uri, (w, h) => resolve(w / h), () => resolve(4 / 3)));
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: space.sm },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  panel: { padding: space.lg, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, gap: space.sm },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.sm, borderBottomWidth: StyleSheet.hairlineWidth },
  linkRowStacked: { flexDirection: 'column', alignItems: 'flex-start' },
});

import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';

import { autoLayout, CELL_ASPECT, gridHeight, tileRect } from '@/components/camera-grid';
import { Button, Chip, Field, Screen, T } from '@/components/ui/primitives';
import { tr } from '@/i18n';
import { useT } from '@/i18n/use-t';
import { GRID_COLUMNS, useApp, type GridTile, type GridView } from '@/state/store';
import { useAllCameras } from '@/systems/registry';
import { useLargeText } from '@/theme/text-scale';
import { space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';

const SIZES: { label: string; w: number; h: number }[] = [
  { label: 'S', w: 3, h: 3 },
  { label: 'M', w: 4, h: 4 },
  { label: 'L', w: 6, h: 6 },
  { label: 'XL', w: 8, h: 8 },
  {
    get label() {
      return tr().settings.grid.wide;
    },
    w: 12,
    h: 8,
  },
];

function overlaps(a: GridTile, b: GridTile) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function fits(t: GridTile, others: GridTile[]) {
  return t.x >= 0 && t.y >= 0 && t.x + t.w <= GRID_COLUMNS && !others.some((o) => o.cameraKey !== t.cameraKey && overlaps(t, o));
}

/** First free spot scanning row by row. */
function place(t: Omit<GridTile, 'x' | 'y'>, tiles: GridTile[]): GridTile {
  for (let y = 0; ; y++) {
    for (let x = 0; x + t.w <= GRID_COLUMNS; x++) {
      const c = { ...t, x, y };
      if (fits(c, tiles)) return c;
    }
  }
}

export default function GridEditor() {
  const p = usePalette();
  const t = useT();
  const g = t.settings.grid;
  const large = useLargeText();
  const { width } = useWindowDimensions();
  const { entries } = useAllCameras();
  const views = useApp((s) => s.gridViews);
  const save = useApp((s) => s.saveGridView);
  const remove = useApp((s) => s.deleteGridView);
  const setActive = useApp((s) => s.setActiveGridView);

  const [editing, setEditing] = useState<GridView | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ key: string; dx: number; dy: number } | null>(null);

  const canvasW = Math.min(width - space.lg * 2, 1000);
  const cell = canvasW / GRID_COLUMNS;
  const cellH = cell * CELL_ASPECT;
  const names = useMemo(() => new Map(entries.map((e) => [e.camera.key, e.camera.name])), [entries]);

  if (!editing) {
    return (
      <Screen>
        <T muted>{g.intro}</T>
        {views.map((v) => (
          <View key={v.id} style={[styles.viewRow, { backgroundColor: p.surface, borderColor: p.border }]}>
            <T v="label" style={large ? { width: '100%' } : { flex: 1 }}>
              {v.name}
            </T>
            <Chip label={t.common.edit} selected={false} onPress={() => setEditing(v)} />
            <Chip label={t.common.delete} selected={false} onPress={() => remove(v.id)} />
          </View>
        ))}
        <Button
          title={g.newLayout}
          onPress={() =>
            setEditing({
              id: Date.now().toString(36),
              name: g.layoutN(views.length + 1),
              tiles: autoLayout(entries.map((e) => e.camera.key), 1200),
            })
          }
        />
      </Screen>
    );
  }

  const tiles = editing.tiles;
  const update = (next: GridTile[]) => setEditing({ ...editing, tiles: next });
  const sel = tiles.find((t) => t.cameraKey === selected);
  const unused = entries.filter((e) => !tiles.some((t) => t.cameraKey === e.camera.key));

  const resize = (w: number, h: number) => {
    if (!sel) return;
    const others = tiles.filter((t) => t.cameraKey !== sel.cameraKey);
    let next = { ...sel, w, h, x: Math.min(sel.x, GRID_COLUMNS - w) };
    if (!fits(next, others)) next = place({ cameraKey: sel.cameraKey, w, h }, others);
    update([...others, next]);
  };

  const drop = (key: string, dx: number, dy: number) => {
    const t = tiles.find((x) => x.cameraKey === key)!;
    const moved = { ...t, x: Math.round(t.x + dx / cell), y: Math.max(0, Math.round(t.y + dy / cellH)) };
    if (fits(moved, tiles)) update(tiles.map((x) => (x.cameraKey === key ? moved : x)));
  };

  return (
    <ScrollView style={{ backgroundColor: p.bg }} contentContainerStyle={{ padding: space.lg, gap: space.lg, paddingBottom: 80 }}>
      <Field label={g.layoutName} value={editing.name} onChangeText={(name) => setEditing({ ...editing, name })} autoCapitalize="words" />
      <T v="caption" muted>
        {g.tapHint}
      </T>

      <View style={{ width: canvasW, height: Math.max(gridHeight(tiles, canvasW), cellH * 6) + cellH * 4, backgroundColor: p.surface, borderRadius: 12 }}>
        {tiles.map((t) => {
          const r = tileRect(t, canvasW);
          const d = drag?.key === t.cameraKey ? drag : null;
          const pan = Gesture.Pan()
            .runOnJS(true)
            .onStart(() => setSelected(t.cameraKey))
            .onUpdate((e) => setDrag({ key: t.cameraKey, dx: e.translationX, dy: e.translationY }))
            .onEnd((e) => {
              drop(t.cameraKey, e.translationX, e.translationY);
              setDrag(null);
            });
          return (
            <GestureDetector key={t.cameraKey} gesture={pan}>
              <Pressable
                onPress={() => setSelected(t.cameraKey)}
                style={[
                  styles.tile,
                  r,
                  {
                    transform: [{ translateX: d?.dx ?? 0 }, { translateY: d?.dy ?? 0 }],
                    backgroundColor: p.surfaceRaised,
                    borderColor: selected === t.cameraKey ? p.accent : p.border,
                    zIndex: d ? 10 : 1,
                  },
                ]}>
                <T v="caption" numberOfLines={1} overlay>
                  {names.get(t.cameraKey) ?? g.camera}
                </T>
                <T v="caption" muted overlay>
                  {t.w}×{t.h}
                </T>
              </Pressable>
            </GestureDetector>
          );
        })}
      </View>

      {sel && (
        <View style={{ gap: space.sm }}>
          <T v="label">{names.get(sel.cameraKey)}</T>
          <View style={styles.wrap}>
            {SIZES.map((s) => (
              <Chip key={s.label} label={s.label} selected={sel.w === s.w && sel.h === s.h} onPress={() => resize(s.w, s.h)} />
            ))}
            <Chip
              label={t.common.remove}
              selected={false}
              onPress={() => {
                update(tiles.filter((t) => t.cameraKey !== sel.cameraKey));
                setSelected(null);
              }}
            />
          </View>
        </View>
      )}

      {unused.length > 0 && (
        <View style={{ gap: space.sm }}>
          <T v="label" muted>
            {g.addCamera}
          </T>
          <View style={styles.wrap}>
            {unused.map((e) => (
              <Chip key={e.camera.key} label={`+ ${e.camera.name}`} selected={false} onPress={() => update([...tiles, place({ cameraKey: e.camera.key, w: 4, h: 4 }, tiles)])} />
            ))}
          </View>
        </View>
      )}

      <Button
        title={g.saveLayout}
        onPress={() => {
          save(editing);
          setActive(editing.id);
          setEditing(null);
          router.back();
        }}
      />
      <Button title={t.common.cancel} kind="ghost" onPress={() => setEditing(null)} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  viewRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.sm, padding: space.md, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth },
  tile: { position: 'absolute', borderRadius: 8, borderWidth: 2, padding: 6, justifyContent: 'space-between' },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
});

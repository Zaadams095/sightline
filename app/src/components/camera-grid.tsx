import { useMemo } from 'react';
import { ScrollView, View } from 'react-native';

import { CameraTile } from '@/components/camera-tile';
import { GRID_COLUMNS, type GridTile } from '@/state/store';
import type { CameraEntry } from '@/systems/registry';

/** Cell aspect is 16:9, so a tile spanning N×N cells is a 16:9 tile. */
export const CELL_ASPECT = 9 / 16;
const GAP = 8;

export function autoLayout(keys: string[], width: number): GridTile[] {
  const span = width >= 1100 ? 4 : 6; // 3 per row landscape, 2 per row portrait
  const perRow = GRID_COLUMNS / span;
  return keys.map((cameraKey, i) => ({
    cameraKey,
    x: (i % perRow) * span,
    y: Math.floor(i / perRow) * span,
    w: span,
    h: span,
  }));
}

export function tileRect(t: GridTile, width: number) {
  const cell = (width - GAP) / GRID_COLUMNS;
  const cellH = cell * CELL_ASPECT;
  return {
    left: t.x * cell + GAP / 2,
    top: t.y * cellH + GAP / 2,
    width: t.w * cell - GAP,
    height: t.h * cellH - GAP,
  };
}

export function gridHeight(tiles: GridTile[], width: number) {
  const cellH = ((width - GAP) / GRID_COLUMNS) * CELL_ASPECT;
  return Math.max(0, ...tiles.map((t) => (t.y + t.h) * cellH)) + GAP;
}

interface Props {
  entries: CameraEntry[];
  tiles: GridTile[];
  width: number;
  onOpen: (e: CameraEntry, poster?: string) => void;
}

/** Free-form iPad grid (tiles of any size), rendered with absolute positioning. */
export function CameraGrid({ entries, tiles, width, onOpen }: Props) {
  const byKey = useMemo(() => new Map(entries.map((e) => [e.camera.key, e])), [entries]);
  const height = gridHeight(tiles, width);

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ paddingBottom: 120 }}>
      <View style={{ width, height }}>
        {tiles.map((t) => {
          const e = byKey.get(t.cameraKey);
          if (!e) return null;
          const rect = tileRect(t, width);
          // Bigger tiles get sharper snapshots and faster refresh.
          const big = t.w >= 6;
          return (
            <CameraTile
              key={t.cameraKey}
              camera={e.camera}
              adapter={e.adapter}
              active
              requestHeight={big ? 720 : 360}
              intervalMs={big ? 700 : 1200}
              style={{ position: 'absolute', ...rect }}
              onPress={(poster) => onOpen(e, poster)}
            />
          );
        })}
      </View>
    </ScrollView>
  );
}

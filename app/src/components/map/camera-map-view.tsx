import { Image } from 'expo-image';
import { StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Svg, { Circle, Defs, Line, Path, Pattern, Rect } from 'react-native-svg';

import { T } from '@/components/ui/primitives';
import { useT } from '@/i18n/use-t';
import type { CameraMap, MapPlacement } from '@/state/store';
import { usePalette } from '@/theme/use-palette';

const CONE_LEN = 0.16; // of map width

interface Props {
  map: CameraMap;
  width: number;
  names: Map<string, string>;
  /** Cameras with recent activity pulse in the alert color. */
  active?: Set<string>;
  selected?: string | null;
  editable?: boolean;
  onPressCamera?: (key: string) => void;
  onMoveCamera?: (key: string, x: number, y: number) => void;
}

function conePath(p: MapPlacement, w: number, h: number) {
  const cx = p.x * w;
  const cy = p.y * h;
  const r = CONE_LEN * w;
  const a1 = ((p.heading - p.fov / 2 - 90) * Math.PI) / 180;
  const a2 = ((p.heading + p.fov / 2 - 90) * Math.PI) / 180;
  const large = p.fov > 180 ? 1 : 0;
  return `M ${cx} ${cy} L ${cx + r * Math.cos(a1)} ${cy + r * Math.sin(a1)} A ${r} ${r} 0 ${large} 1 ${cx + r * Math.cos(a2)} ${cy + r * Math.sin(a2)} Z`;
}

/** The property map: background, field-of-view cones, walking links, and camera pins. */
export function CameraMapView({ map, width, names, active, selected, editable, onPressCamera, onMoveCamera }: Props) {
  const p = usePalette();
  const t = useT();
  const height = width / map.aspect;
  const entries = Object.entries(map.placements);

  return (
    <View style={{ width, height, borderRadius: 16, overflow: 'hidden', backgroundColor: p.surface }}>
      {map.background ? (
        <Image source={{ uri: map.background }} style={StyleSheet.absoluteFill} contentFit="cover" />
      ) : null}
      <Svg width={width} height={height} style={StyleSheet.absoluteFill}>
        {!map.background && (
          <>
            <Defs>
              <Pattern id="grid" width={24} height={24} patternUnits="userSpaceOnUse">
                <Path d="M 24 0 L 0 0 0 24" fill="none" stroke={p.border} strokeWidth={1} />
              </Pattern>
            </Defs>
            <Rect width={width} height={height} fill="url(#grid)" />
          </>
        )}
        {map.links.map((l) => {
          const a = map.placements[l.a];
          const b = map.placements[l.b];
          if (!a || !b) return null;
          return (
            <Line
              key={`${l.a}|${l.b}`}
              x1={a.x * width}
              y1={a.y * height}
              x2={b.x * width}
              y2={b.y * height}
              stroke={p.accent}
              strokeOpacity={0.6}
              strokeWidth={2}
              strokeDasharray="6 5"
            />
          );
        })}
        {entries.map(([key, pl]) => (
          <Path
            key={key}
            d={conePath(pl, width, height)}
            fill={active?.has(key) ? p.danger : p.accent}
            fillOpacity={active?.has(key) ? 0.35 : selected === key ? 0.3 : 0.16}
          />
        ))}
        {entries.map(([key, pl]) => (
          <Circle key={key} cx={pl.x * width} cy={pl.y * height} r={selected === key ? 11 : 9} fill={active?.has(key) ? p.danger : p.accent} stroke="#fff" strokeWidth={2} />
        ))}
      </Svg>

      {entries.map(([key, pl]) => (
        <CameraPin
          key={key}
          cameraKey={key}
          placement={pl}
          width={width}
          height={height}
          name={names.get(key) ?? t.home.map.camera}
          editable={!!editable}
          onPress={onPressCamera}
          onMove={onMoveCamera}
        />
      ))}
    </View>
  );
}

function CameraPin({
  cameraKey,
  placement,
  width,
  height,
  name,
  editable,
  onPress,
  onMove,
}: {
  cameraKey: string;
  placement: MapPlacement;
  width: number;
  height: number;
  name: string;
  editable: boolean;
  onPress?: (key: string) => void;
  onMove?: (key: string, x: number, y: number) => void;
}) {
  const p = usePalette();
  const tap = Gesture.Tap().runOnJS(true).onEnd(() => onPress?.(cameraKey));
  const pan = Gesture.Pan()
    .runOnJS(true)
    .enabled(editable)
    .onEnd((e) => {
      const x = Math.min(1, Math.max(0, placement.x + e.translationX / width));
      const y = Math.min(1, Math.max(0, placement.y + e.translationY / height));
      onMove?.(cameraKey, x, y);
    });

  return (
    <GestureDetector gesture={Gesture.Exclusive(pan, tap)}>
      <View style={[styles.hit, { left: placement.x * width - 22, top: placement.y * height - 22 }]}>
        <View style={[styles.label, { backgroundColor: p.scrim }]}>
          {/* A small label on the map picture: grows only a little with the text size. */}
          <T v="caption" color="#fff" numberOfLines={1} overlay>
            {name}
          </T>
        </View>
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  hit: { position: 'absolute', width: 44, height: 44, alignItems: 'center' },
  label: { position: 'absolute', top: 34, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, maxWidth: 120 },
});

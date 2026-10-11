import { Image } from 'expo-image';
import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Svg, { Circle, Polygon, Polyline } from 'react-native-svg';

import type { Pt } from '@/alerts/masks';
import { Button, Screen, T } from '@/components/ui/primitives';
import { useApp } from '@/state/store';
import { useAdapter } from '@/systems/registry';
import { space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';

/** Draw areas to ignore for alerts on a camera's snapshot. Recording is unaffected. */
export default function MaskEditor() {
  const { key } = useLocalSearchParams<{ key: string }>();
  const p = usePalette();
  const { width } = useWindowDimensions();
  const [systemId, cameraId] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
  const adapter = useAdapter(systemId);
  const saved = useApp((s) => s.masks[key] ?? []);
  const setMasks = useApp((s) => s.setMasks);
  const [polys, setPolys] = useState<Pt[][]>(saved);
  const [draft, setDraft] = useState<Pt[]>([]);

  const w = width - space.lg * 2;
  const h = w * (9 / 16);
  const tap = Gesture.Tap()
    .runOnJS(true)
    .onEnd((e) => setDraft((d) => [...d, { x: Math.min(1, Math.max(0, e.x / w)), y: Math.min(1, Math.max(0, e.y / h)) }]));

  const toSvg = (pts: Pt[]) => pts.map((q) => `${q.x * w},${q.y * h}`).join(' ');

  return (
    <Screen>
      <T muted>
        Tap around an area to outline it, such as the street, a neighbor&apos;s driveway, or a tree that moves in the wind.
        You won&apos;t get alerts for objects that stay inside these areas. Everything is still recorded.
      </T>

      <GestureDetector gesture={tap}>
        <View style={{ width: w, height: h, borderRadius: 12, overflow: 'hidden', backgroundColor: p.surface }}>
          {adapter && <Image source={{ uri: adapter.snapshot(cameraId, { height: 540 }).uri }} style={StyleSheet.absoluteFill} contentFit="fill" />}
          <Svg width={w} height={h} style={StyleSheet.absoluteFill}>
            {polys.map((poly, i) => (
              <Polygon key={i} points={toSvg(poly)} fill={p.danger} fillOpacity={0.35} stroke={p.danger} strokeWidth={2} />
            ))}
            {draft.length > 1 && <Polyline points={toSvg(draft)} fill="none" stroke="#fff" strokeWidth={2} strokeDasharray="5 4" />}
            {draft.map((q, i) => (
              <Circle key={i} cx={q.x * w} cy={q.y * h} r={5} fill="#fff" stroke={p.danger} strokeWidth={2} />
            ))}
          </Svg>
        </View>
      </GestureDetector>

      <View style={styles.row}>
        <Button
          title="Finish shape"
          onPress={() => {
            setPolys((ps) => [...ps, draft]);
            setDraft([]);
          }}
          disabled={draft.length < 3}
          style={{ flex: 1 }}
        />
        <Button title="Undo point" kind="secondary" onPress={() => setDraft((d) => d.slice(0, -1))} disabled={!draft.length} style={{ flex: 1 }} />
      </View>
      {polys.length > 0 && <Button title="Remove last area" kind="secondary" onPress={() => setPolys((ps) => ps.slice(0, -1))} />}
      <Button title="Save" onPress={() => setMasks(key, polys)} />
      <T v="caption" muted>
        {polys.length} area{polys.length === 1 ? '' : 's'}. Masks apply to built-in alerts and to Instant Alerts after the next sync.
      </T>
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: space.sm },
});

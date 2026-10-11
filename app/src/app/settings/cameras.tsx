import { Pressable, StyleSheet, Switch, View } from 'react-native';

import { Screen, Section, T } from '@/components/ui/primitives';
import { useApp } from '@/state/store';
import { useAllCameras } from '@/systems/registry';
import { space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';

export default function CameraOrder() {
  const p = usePalette();
  const { entries } = useAllCameras({ includeHidden: true });
  const hidden = useApp((s) => s.hidden);
  const toggleHidden = useApp((s) => s.toggleHidden);
  const setOrder = useApp((s) => s.setPhoneOrder);
  const keys = entries.map((e) => e.camera.key);

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= keys.length) return;
    const next = [...keys];
    [next[i], next[j]] = [next[j], next[i]];
    setOrder(next);
  };

  return (
    <Screen>
      <Section footer="Hidden cameras still record and can still send alerts.">
        {entries.map((e, i) => (
          <View key={e.camera.key} style={[styles.row, { borderBottomColor: p.border, borderBottomWidth: i === entries.length - 1 ? 0 : StyleSheet.hairlineWidth }]}>
            <View style={styles.arrows}>
              <Pressable onPress={() => move(i, -1)} hitSlop={6} disabled={i === 0}>
                <T muted={i === 0} color={i === 0 ? undefined : p.accent}>
                  ▲
                </T>
              </Pressable>
              <Pressable onPress={() => move(i, 1)} hitSlop={6} disabled={i === entries.length - 1}>
                <T muted={i === entries.length - 1} color={i === entries.length - 1 ? undefined : p.accent}>
                  ▼
                </T>
              </Pressable>
            </View>
            <T style={{ flex: 1 }}>{e.camera.name}</T>
            <Switch value={!hidden.includes(e.camera.key)} onValueChange={() => toggleHidden(e.camera.key)} trackColor={{ true: p.accent }} />
          </View>
        ))}
      </Section>
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.sm, minHeight: 52 },
  arrows: { flexDirection: 'row', gap: space.md },
});

import { router, Stack } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { Button, Chip, Screen, Section, T, TimeStepper, ToggleRow } from '@/components/ui/primitives';
import { useT } from '@/i18n/use-t';
import { useWall } from '@/state/wall';
import { useAllCameras } from '@/systems/registry';
import { space } from '@/theme/tokens';

const INTERVALS = [10, 15, 30, 60];
const LEVELS: { key: string; level: number }[] = [
  { key: 'little', level: 0.4 },
  { key: 'more', level: 0.6 },
  { key: 'most', level: 0.8 },
];

/** Wall display settings and "Start wall display". */
export default function WallSettings() {
  const t = useT();
  const s = t.wall.settings;
  const wall = useWall();
  const set = useWall((s) => s.setWall);
  const { entries } = useAllCameras();
  const all = wall.cameraKeys.length === 0;
  const toggleCamera = (key: string, on: boolean) => {
    const base = all ? entries.map((e) => e.camera.key) : wall.cameraKeys;
    const next = on ? [...base.filter((k) => k !== key), key] : base.filter((k) => k !== key);
    // Turning every camera back on (or off) means "all cameras".
    set({ cameraKeys: next.length === entries.length || next.length === 0 ? [] : next });
  };

  return (
    <Screen>
      <Stack.Screen options={{ title: s.title }} />
      <T muted>{s.intro}</T>
      <Button title={s.start} onPress={() => router.push('/wall')} />

      <Section title={s.showCameras}>
        <View style={styles.chips}>
          <Chip label={s.grid} selected={wall.mode === 'grid'} onPress={() => set({ mode: 'grid' })} />
          <Chip label={s.single} selected={wall.mode === 'single'} onPress={() => set({ mode: 'single' })} />
        </View>
        <T v="caption" muted style={styles.inset}>
          {wall.mode === 'grid' ? s.gridEvery : s.singleEvery}
        </T>
        <View style={styles.chips}>
          {INTERVALS.map((sec) => (
            <Chip
              key={sec}
              label={sec < 60 ? t.common.seconds(sec) : t.common.minutesCount(1)}
              selected={wall.intervalSec === sec}
              onPress={() => set({ intervalSec: sec })}
            />
          ))}
        </View>
      </Section>

      <Section title={s.camerasOnWall}>
        <ToggleRow label={s.allCameras} value={all} onChange={(v) => set({ cameraKeys: v ? [] : entries.map((e) => e.camera.key) })} last={all} />
        {!all &&
          entries.map((e, i) => (
            <ToggleRow
              key={e.camera.key}
              label={e.camera.name}
              value={wall.cameraKeys.includes(e.camera.key)}
              onChange={(v) => toggleCamera(e.camera.key, v)}
              last={i === entries.length - 1}
            />
          ))}
      </Section>

      <Section title={s.whenSomething} footer={s.whenFooter}>
        <ToggleRow label={s.showDoorbell} value={wall.jumpToDoorbell} onChange={(v) => set({ jumpToDoorbell: v })} />
        <ToggleRow label={s.showAlert} value={wall.jumpToAlerts} onChange={(v) => set({ jumpToAlerts: v })} last />
      </Section>

      <Section title={s.night}>
        <ToggleRow label={s.dimAtNight} value={wall.night.enabled} onChange={(v) => set({ night: { ...wall.night, enabled: v } })} last={!wall.night.enabled} />
        {wall.night.enabled && (
          <>
            <TimeStepper label={s.from} value={wall.night.start} onChange={(start) => set({ night: { ...wall.night, start } })} />
            <TimeStepper label={s.until} value={wall.night.end} onChange={(end) => set({ night: { ...wall.night, end } })} />
            <View style={styles.chips}>
              {LEVELS.map((l) => (
                <Chip key={l.key} label={s.levels[l.key]} selected={Math.abs(wall.night.level - l.level) < 0.05} onPress={() => set({ night: { ...wall.night, level: l.level } })} />
              ))}
            </View>
          </>
        )}
      </Section>

      <Section>
        <ToggleRow label={s.clock} value={wall.showClock} onChange={(v) => set({ showClock: v })} last />
      </Section>

      <Section title={s.tablet}>
        <View style={[styles.inset, { gap: space.sm, paddingVertical: space.md }]}>
          <T v="caption" muted>
            {s.tipPower}
          </T>
          <T v="caption" muted>
            {s.tipGuided}
          </T>
          <T v="caption" muted>
            {s.tipBurnIn}
          </T>
          <T v="caption" muted>
            {s.tipLeave}
          </T>
        </View>
      </Section>
    </Screen>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.md },
  inset: { paddingHorizontal: space.lg },
});

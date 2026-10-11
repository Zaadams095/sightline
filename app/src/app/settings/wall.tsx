import { router } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { Button, Chip, Screen, Section, T, TimeStepper, ToggleRow } from '@/components/ui/primitives';
import { useWall } from '@/state/wall';
import { useAllCameras } from '@/systems/registry';
import { space } from '@/theme/tokens';

const INTERVALS = [10, 15, 30, 60];
const LEVELS: { label: string; level: number }[] = [
  { label: 'A little', level: 0.4 },
  { label: 'More', level: 0.6 },
  { label: 'Most', level: 0.8 },
];

/** Wall display settings and "Start wall display". */
export default function WallSettings() {
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
      <T muted>
        Turns this iPad into an always-on camera wall: it goes through your cameras, shows the doorbell when someone rings, and dims at night.
      </T>
      <Button title="Start wall display" onPress={() => router.push('/wall')} />

      <Section title="Show cameras">
        <View style={styles.chips}>
          <Chip label="All at once (grid)" selected={wall.mode === 'grid'} onPress={() => set({ mode: 'grid' })} />
          <Chip label="One at a time" selected={wall.mode === 'single'} onPress={() => set({ mode: 'single' })} />
        </View>
        <T v="caption" muted style={styles.inset}>
          {wall.mode === 'grid' ? 'With more cameras than fit, the next screenful shows every' : 'Next camera every'}
        </T>
        <View style={styles.chips}>
          {INTERVALS.map((s) => (
            <Chip key={s} label={s < 60 ? `${s} seconds` : '1 minute'} selected={wall.intervalSec === s} onPress={() => set({ intervalSec: s })} />
          ))}
        </View>
      </Section>

      <Section title="Cameras on the wall">
        <ToggleRow label="All cameras" value={all} onChange={(v) => set({ cameraKeys: v ? [] : entries.map((e) => e.camera.key) })} last={all} />
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

      <Section title="When something happens" footer="Alerts follow your alert settings. After a while the wall goes back to the tour.">
        <ToggleRow label="Show the doorbell when someone rings" value={wall.jumpToDoorbell} onChange={(v) => set({ jumpToDoorbell: v })} />
        <ToggleRow label="Show a camera with a new alert" value={wall.jumpToAlerts} onChange={(v) => set({ jumpToAlerts: v })} last />
      </Section>

      <Section title="Night">
        <ToggleRow label="Dim at night" value={wall.night.enabled} onChange={(v) => set({ night: { ...wall.night, enabled: v } })} last={!wall.night.enabled} />
        {wall.night.enabled && (
          <>
            <TimeStepper label="From" value={wall.night.start} onChange={(start) => set({ night: { ...wall.night, start } })} />
            <TimeStepper label="Until" value={wall.night.end} onChange={(end) => set({ night: { ...wall.night, end } })} />
            <View style={styles.chips}>
              {LEVELS.map((l) => (
                <Chip key={l.label} label={l.label} selected={Math.abs(wall.night.level - l.level) < 0.05} onPress={() => set({ night: { ...wall.night, level: l.level } })} />
              ))}
            </View>
          </>
        )}
      </Section>

      <Section>
        <ToggleRow label="Clock and date" value={wall.showClock} onChange={(v) => set({ showClock: v })} last />
      </Section>

      <Section title="For a tablet on the wall">
        <View style={[styles.inset, { gap: space.sm, paddingVertical: space.md }]}>
          <T v="caption" muted>
            • Keep it plugged in. The screen stays on while the wall display is open.
          </T>
          <T v="caption" muted>
            • To keep it on Sightline: Settings → Accessibility → Guided Access, turn it on, then open the wall display and press the top button three times.
          </T>
          <T v="caption" muted>
            • To protect the screen, the picture moves a tiny bit every minute and the cameras swap places every 15 minutes.
          </T>
          <T v="caption" muted>
            • Tap the screen to leave. If the app is locked, Face ID or your PIN is needed.
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

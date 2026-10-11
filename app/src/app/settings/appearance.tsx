import { Pressable, StyleSheet, View } from 'react-native';

import { Chip, Screen, Section, T, ToggleRow } from '@/components/ui/primitives';
import { useApp } from '@/state/store';
import { ACCENTS, type AccentName, type Density, type LabelStyle, type ThemeMode } from '@/theme/tokens';
import { space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';

const MODES: { v: ThemeMode; label: string }[] = [
  { v: 'system', label: 'System' },
  { v: 'light', label: 'Light' },
  { v: 'dark', label: 'Dark' },
  { v: 'oled', label: 'OLED Black' },
];
const RADII = [0, 6, 14, 22];
const LABELS: { v: LabelStyle; label: string }[] = [
  { v: 'overlay', label: 'On video' },
  { v: 'below', label: 'Below' },
  { v: 'hidden', label: 'Hidden' },
];
const DENSITY: { v: Density; label: string }[] = [
  { v: 'comfortable', label: 'Comfortable' },
  { v: 'compact', label: 'Compact' },
];

export default function AppearanceScreen() {
  const p = usePalette();
  const a = useApp((s) => s.appearance);
  const set = useApp((s) => s.setAppearance);

  return (
    <Screen>
      <Preview />

      <Group title="Theme">
        {MODES.map((m) => (
          <Chip key={m.v} label={m.label} selected={a.mode === m.v} onPress={() => set({ mode: m.v })} />
        ))}
      </Group>

      <Group title="Accent">
        {(Object.keys(ACCENTS) as AccentName[]).map((name) => (
          <Pressable
            key={name}
            onPress={() => set({ accent: name })}
            style={[styles.swatch, { backgroundColor: ACCENTS[name], borderColor: a.accent === name ? p.text : 'transparent' }]}
          />
        ))}
      </Group>

      <Group title="Tile corners">
        {RADII.map((r) => (
          <Chip key={r} label={r === 0 ? 'Square' : `${r}`} selected={a.radius === r} onPress={() => set({ radius: r })} />
        ))}
      </Group>

      <Group title="Camera names">
        {LABELS.map((l) => (
          <Chip key={l.v} label={l.label} selected={a.labelStyle === l.v} onPress={() => set({ labelStyle: l.v })} />
        ))}
      </Group>

      <Group title="Phone layout">
        <Chip label="1 column" selected={a.phoneColumns === 1} onPress={() => set({ phoneColumns: 1 })} />
        <Chip label="2 columns" selected={a.phoneColumns === 2} onPress={() => set({ phoneColumns: 2 })} />
        {DENSITY.map((d) => (
          <Chip key={d.v} label={d.label} selected={a.density === d.v} onPress={() => set({ density: d.v })} />
        ))}
      </Group>

      <Section>
        <ToggleRow label="Show timestamps" value={a.showTimestamps} onChange={(v) => set({ showTimestamps: v })} last />
      </Section>
    </Screen>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: space.sm }}>
      <T v="caption" muted style={{ textTransform: 'uppercase', letterSpacing: 0.6 }}>
        {title}
      </T>
      <View style={styles.wrap}>{children}</View>
    </View>
  );
}

/** Live preview of the tile style so changes are visible immediately. */
function Preview() {
  const p = usePalette();
  const a = useApp((s) => s.appearance);
  return (
    <View style={[styles.preview, { backgroundColor: p.bg, borderColor: p.border }]}>
      {[0, 1].map((i) => (
        <View key={i} style={{ flex: 1, gap: 6 }}>
          <View style={[styles.tile, { borderRadius: a.radius, backgroundColor: i ? '#2a3140' : '#3a3324' }]}>
            {a.labelStyle === 'overlay' && (
              <View style={[styles.pill, { backgroundColor: p.scrim }]}>
                <T v="caption" color="#fff">
                  {i ? 'Backyard' : 'Front Door'}
                </T>
              </View>
            )}
          </View>
          {a.labelStyle === 'below' && <T v="caption">{i ? 'Backyard' : 'Front Door'}</T>}
        </View>
      ))}
      <View style={[styles.accentBar, { backgroundColor: p.accent }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  swatch: { width: 36, height: 36, borderRadius: 18, borderWidth: 3 },
  preview: { flexDirection: 'row', gap: 10, padding: 14, borderRadius: 18, borderWidth: StyleSheet.hairlineWidth },
  tile: { aspectRatio: 16 / 9, overflow: 'hidden', justifyContent: 'flex-end', padding: 6 },
  pill: { alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  accentBar: { position: 'absolute', left: 14, right: 14, bottom: 6, height: 3, borderRadius: 2 },
});

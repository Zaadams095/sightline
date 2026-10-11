import { getLocales } from 'expo-localization';
import { Pressable, StyleSheet, View } from 'react-native';

import { Chip, Screen, Section, T, ToggleRow } from '@/components/ui/primitives';
import { LOCALE_NAMES, LOCALES, matchLocale, type LanguagePref } from '@/i18n';
import { useT } from '@/i18n/use-t';
import { useApp } from '@/state/store';
import { ACCENTS, type AccentName, type Density, type LabelStyle, type ThemeMode } from '@/theme/tokens';
import { space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';

const MODES: ThemeMode[] = ['system', 'light', 'dark', 'oled'];
const RADII = [0, 6, 14, 22];
const LABELS: LabelStyle[] = ['overlay', 'below', 'hidden'];
const DENSITY: Density[] = ['comfortable', 'compact'];

/** The iPhone's language, if Sightline speaks it (shown next to "Automatic"). */
function deviceLanguageName(): string {
  try {
    const l = matchLocale(getLocales().map((x) => x.languageTag));
    return LOCALE_NAMES[l ?? 'en'];
  } catch {
    return LOCALE_NAMES.en;
  }
}

export default function AppearanceScreen() {
  const p = usePalette();
  const t = useT();
  const s = t.common.appearance;
  const a = useApp((st) => st.appearance);
  const set = useApp((st) => st.setAppearance);

  const modeLabel: Record<ThemeMode, string> = { system: s.themeSystem, light: s.themeLight, dark: s.themeDark, oled: s.themeOled };
  const labelLabel: Record<LabelStyle, string> = { overlay: s.onVideo, below: s.below, hidden: s.hidden };
  const densityLabel: Record<Density, string> = { comfortable: s.comfortable, compact: s.compact };
  const languages: LanguagePref[] = ['auto', ...LOCALES];

  return (
    <Screen>
      <Preview />

      <Group title={s.language}>
        {languages.map((l) => (
          <Chip
            key={l}
            label={l === 'auto' ? s.languageAuto : LOCALE_NAMES[l]}
            accessibilityLabel={l === 'auto' ? `${s.languageAuto}. ${s.languageAutoDetail(deviceLanguageName())}` : undefined}
            selected={a.language === l}
            onPress={() => set({ language: l })}
          />
        ))}
      </Group>
      {a.language === 'auto' && (
        <T v="caption" muted style={{ marginTop: -space.sm, marginHorizontal: space.xs }}>
          {s.languageAutoDetail(deviceLanguageName())}
        </T>
      )}

      <Section title={s.text} footer={s.biggerTextDetail}>
        <ToggleRow label={s.biggerText} value={a.biggerText} onChange={(v) => set({ biggerText: v })} last />
      </Section>

      <Group title={s.theme}>
        {MODES.map((m) => (
          <Chip key={m} label={modeLabel[m]} selected={a.mode === m} onPress={() => set({ mode: m })} />
        ))}
      </Group>

      <Group title={s.accent}>
        {(Object.keys(ACCENTS) as AccentName[]).map((name) => (
          <Pressable
            key={name}
            onPress={() => set({ accent: name })}
            accessibilityRole="button"
            accessibilityLabel={s.accentNamed(s.accents[name] ?? name)}
            accessibilityState={{ selected: a.accent === name }}
            style={[styles.swatch, { backgroundColor: ACCENTS[name], borderColor: a.accent === name ? p.text : 'transparent' }]}
          />
        ))}
      </Group>

      <Group title={s.tileCorners}>
        {RADII.map((r) => (
          <Chip key={r} label={r === 0 ? s.square : `${r}`} selected={a.radius === r} onPress={() => set({ radius: r })} />
        ))}
      </Group>

      <Group title={s.cameraNames}>
        {LABELS.map((l) => (
          <Chip key={l} label={labelLabel[l]} selected={a.labelStyle === l} onPress={() => set({ labelStyle: l })} />
        ))}
      </Group>

      <Group title={s.phoneLayout}>
        <Chip label={s.oneColumn} selected={a.phoneColumns === 1} onPress={() => set({ phoneColumns: 1 })} />
        <Chip label={s.twoColumns} selected={a.phoneColumns === 2} onPress={() => set({ phoneColumns: 2 })} />
        {DENSITY.map((d) => (
          <Chip key={d} label={densityLabel[d]} selected={a.density === d} onPress={() => set({ density: d })} />
        ))}
      </Group>

      <Section>
        <ToggleRow label={s.showTimestamps} value={a.showTimestamps} onChange={(v) => set({ showTimestamps: v })} last />
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
  const t = useT();
  const a = useApp((s) => s.appearance);
  const names = [t.common.appearance.previewFront, t.common.appearance.previewBack];
  return (
    <View style={[styles.preview, { backgroundColor: p.bg, borderColor: p.border }]}>
      {[0, 1].map((i) => (
        <View key={i} style={{ flex: 1, gap: 6 }}>
          <View style={[styles.tile, { borderRadius: a.radius, backgroundColor: i ? '#2a3140' : '#3a3324' }]}>
            {a.labelStyle === 'overlay' && (
              <View style={[styles.pill, { backgroundColor: p.scrim }]}>
                <T v="caption" color="#fff" overlay numberOfLines={1}>
                  {names[i]}
                </T>
              </View>
            )}
          </View>
          {a.labelStyle === 'below' && <T v="caption">{names[i]}</T>}
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

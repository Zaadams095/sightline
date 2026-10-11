import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ChoiceRow } from '@/components/guide/parts';
import { Field, Screen, T } from '@/components/ui/primitives';
import { useT } from '@/i18n/use-t';
import { GROUP_TITLES, GUIDES, searchGuides, type BrandGuide, type GuideGroup } from '@/systems/guides';
import { useLargeText } from '@/theme/text-scale';
import { space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';

const GROUPS: GuideGroup[] = ['camera', 'recorder', 'cloud'];

/** "Pick your camera brand": plain name tiles (no logos), searchable, with an "I don't know" way out. */
export default function Brands() {
  const p = usePalette();
  const t = useT();
  const b = t.onboarding.brands;
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  const results = searchGuides(query);
  const open = (g: BrandGuide) => router.push({ pathname: '/onboarding/guide', params: { brand: g.id } });

  return (
    <Screen style={{ paddingTop: insets.top + 56 }}>
      <View style={{ gap: space.xs }}>
        <T v="title">{t.onboarding.welcome.pickBrand}</T>
        <T muted>{b.subtitle}</T>
      </View>

      <Field label={b.search} value={query} onChangeText={setQuery} placeholder={b.searchPlaceholder} autoCorrect={false} returnKeyType="search" clearButtonMode="while-editing" />

      <Pressable
        onPress={() => router.push('/onboarding/find-brand')}
        accessibilityRole="button"
        accessibilityLabel={b.dontKnowA11y}
        style={({ pressed }) => [styles.unknown, { backgroundColor: pressed ? p.surfaceRaised : p.surface, borderColor: p.accent }]}>
        <SymbolView name="questionmark.circle" tintColor={p.accent} size={26} />
        <View style={{ flex: 1 }}>
          <T v="label">{b.dontKnow}</T>
          <T v="caption" muted>
            {b.helpMeFind}
          </T>
        </View>
        <SymbolView name="chevron.right" tintColor={p.textMuted} size={13} weight="semibold" />
      </Pressable>

      {query.trim() ? (
        results.length ? (
          <Grid guides={results} onPick={open} />
        ) : (
          <T muted>{b.noMatch}</T>
        )
      ) : (
        GROUPS.map((group) => (
          <View key={group} style={{ gap: space.sm }}>
            <T v="caption" muted style={styles.sectionTitle}>
              {GROUP_TITLES[group]}
            </T>
            <Grid guides={GUIDES.filter((g) => g.group === group)} onPick={open} />
          </View>
        ))
      )}

      <View style={{ gap: space.sm }}>
        <T v="caption" muted style={styles.sectionTitle}>
          {b.notListed}
        </T>
        <ChoiceRow
          title={b.otherCamera}
          detail={b.otherCameraDetail}
          onPress={() => router.push({ pathname: '/onboarding/connect', params: { kind: 'onvif' } })}
        />
        <ChoiceRow title={b.findOnWifi} detail={b.findOnWifiDetail} onPress={() => router.push('/onboarding/discover')} />
        <ChoiceRow title={b.haveStreamLink} detail={b.haveStreamLinkDetail} onPress={() => router.push('/onboarding/rtsp')} />
      </View>
    </Screen>
  );
}

function Grid({ guides, onPick }: { guides: BrandGuide[]; onPick: (g: BrandGuide) => void }) {
  const p = usePalette();
  const t = useT();
  const large = useLargeText();
  return (
    <View style={styles.grid}>
      {guides.map((g) => {
        const cloud = g.group === 'cloud';
        const detail = cloud ? t.onboarding.brands.cloudOnly : g.app ? t.onboarding.brands.appName(g.app) : '';
        return (
          <Pressable
            key={g.id}
            onPress={() => onPick(g)}
            accessibilityRole="button"
            accessibilityLabel={`${g.name}. ${detail}`}
            style={({ pressed }) => [
              styles.tile,
              // Large text: one brand per line, names wrap instead of being cut off.
              large && styles.tileFull,
              { backgroundColor: pressed ? p.surfaceRaised : p.surface, borderColor: p.border },
            ]}>
            <T v="label" style={{ fontSize: 16 }} numberOfLines={large ? undefined : 1}>
              {g.name}
            </T>
            {!!detail && (
              <T v="caption" muted numberOfLines={large ? undefined : 1}>
                {detail}
              </T>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  sectionTitle: { textTransform: 'uppercase', letterSpacing: 0.6, marginLeft: space.xs },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  tile: { flexGrow: 1, flexBasis: '45%', minHeight: 64, padding: space.md, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, gap: 2, justifyContent: 'center' },
  tileFull: { flexBasis: '100%' },
  unknown: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.lg, borderRadius: 16, borderWidth: 1.5 },
});

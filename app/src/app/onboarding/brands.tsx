import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ChoiceRow } from '@/components/guide/parts';
import { Field, Screen, T } from '@/components/ui/primitives';
import { GROUP_TITLES, GUIDES, searchGuides, type BrandGuide, type GuideGroup } from '@/systems/guides';
import { space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';

const GROUPS: GuideGroup[] = ['camera', 'recorder', 'cloud'];

/** "Pick your camera brand": plain name tiles (no logos), searchable, with an "I don't know" way out. */
export default function Brands() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  const results = searchGuides(query);
  const open = (g: BrandGuide) => router.push({ pathname: '/onboarding/guide', params: { brand: g.id } });

  return (
    <Screen style={{ paddingTop: insets.top + 56 }}>
      <View style={{ gap: space.xs }}>
        <T v="title">Pick your camera brand</T>
        <T muted>We’ll walk you through it, one step at a time.</T>
      </View>

      <Field label="Search" value={query} onChangeText={setQuery} placeholder="Brand, app or model, e.g. Tapo" autoCorrect={false} returnKeyType="search" clearButtonMode="while-editing" />

      <Pressable
        onPress={() => router.push('/onboarding/find-brand')}
        accessibilityRole="button"
        accessibilityLabel="I don’t know my brand. Help me find out."
        style={({ pressed }) => [styles.unknown, { backgroundColor: pressed ? p.surfaceRaised : p.surface, borderColor: p.accent }]}>
        <SymbolView name="questionmark.circle" tintColor={p.accent} size={26} />
        <View style={{ flex: 1 }}>
          <T v="label">I don’t know</T>
          <T v="caption" muted>
            Help me find out
          </T>
        </View>
        <SymbolView name="chevron.right" tintColor={p.textMuted} size={13} weight="semibold" />
      </Pressable>

      {query.trim() ? (
        results.length ? (
          <Grid guides={results} onPick={open} />
        ) : (
          <T muted>No brand by that name yet. Try “I don’t know” above, or one of the options below.</T>
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
          Not listed?
        </T>
        <ChoiceRow
          title="Other network camera"
          detail="Most other cameras work with just their address and password"
          onPress={() => router.push({ pathname: '/onboarding/connect', params: { kind: 'onvif' } })}
        />
        <ChoiceRow title="Find cameras on my Wi-Fi" detail="Sightline looks around and shows what it finds" onPress={() => router.push('/onboarding/discover')} />
        <ChoiceRow title="I have a stream link" detail="A link that starts with rtsp://" onPress={() => router.push('/onboarding/rtsp')} />
      </View>
    </Screen>
  );
}

function Grid({ guides, onPick }: { guides: BrandGuide[]; onPick: (g: BrandGuide) => void }) {
  const p = usePalette();
  return (
    <View style={styles.grid}>
      {guides.map((g) => {
        const cloud = g.group === 'cloud';
        const detail = cloud ? 'Cloud only' : g.app ? `${g.app} app` : '';
        return (
          <Pressable
            key={g.id}
            onPress={() => onPick(g)}
            accessibilityRole="button"
            accessibilityLabel={`${g.name}. ${detail}`}
            style={({ pressed }) => [styles.tile, { backgroundColor: pressed ? p.surfaceRaised : p.surface, borderColor: p.border }]}>
            <T v="label" style={{ fontSize: 16 }} numberOfLines={1}>
              {g.name}
            </T>
            {!!detail && (
              <T v="caption" muted numberOfLines={1}>
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
  unknown: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.lg, borderRadius: 16, borderWidth: 1.5 },
});

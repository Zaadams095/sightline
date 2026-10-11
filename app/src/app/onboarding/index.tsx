import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, Screen, T } from '@/components/ui/primitives';
import { CATALOG, type Category, type SystemDescriptor } from '@/systems/catalog';
import { space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';

const SECTIONS: { category: Category; title: string }[] = [
  { category: 'recorder', title: 'Recorders (NVR boxes)' },
  { category: 'software', title: 'Camera software' },
  { category: 'camera', title: 'Individual cameras' },
];

export default function Welcome() {
  const p = usePalette();
  const insets = useSafeAreaInsets();

  const pick = (d: SystemDescriptor) => {
    if (d.kind === 'rtsp') router.push('/onboarding/rtsp');
    else router.push({ pathname: '/onboarding/connect', params: { kind: d.kind } });
  };

  return (
    <Screen style={{ paddingTop: insets.top + space.xxl }}>
      <View style={{ gap: space.sm }}>
        <T v="title" style={{ fontSize: 34 }}>
          Your cameras.{'\n'}Your network.
        </T>
        <T muted>Watch live, look back at recordings and get alerts, straight from your own system. Nothing goes through the cloud.</T>
      </View>

      <Button title="Find my cameras" onPress={() => router.push('/onboarding/discover')} />
      <T v="caption" muted style={{ textAlign: 'center', marginTop: -space.sm }}>
        Sightline looks around your home Wi-Fi and finds cameras and recorders for you.
      </T>

      <View style={styles.row}>
        <BigOption icon="qrcode.viewfinder" title="Someone shared cameras with me" onPress={() => router.push('/onboarding/invite')} />
        <BigOption icon="server.rack" title="I have a Sightline Hub" onPress={() => router.push({ pathname: '/onboarding/connect', params: { kind: 'hub' } })} />
      </View>

      <T v="heading" style={{ marginTop: space.md }}>
        Or choose your brand
      </T>
      {SECTIONS.map((s) => (
        <View key={s.category} style={{ gap: space.sm }}>
          <T v="caption" muted style={styles.sectionTitle}>
            {s.title}
          </T>
          <View style={styles.grid}>
            {CATALOG.filter((d) => d.category === s.category).map((d) => (
              <Pressable
                key={d.kind}
                disabled={!d.available}
                onPress={() => pick(d)}
                style={({ pressed }) => [
                  styles.card,
                  { backgroundColor: pressed ? p.surfaceRaised : p.surface, borderColor: p.border, opacity: d.available ? 1 : 0.45 },
                ]}>
                <T v="label" style={{ fontSize: 15 }}>
                  {d.label}
                </T>
                <T v="caption" muted numberOfLines={2}>
                  {d.available ? d.blurb : 'Coming soon'}
                </T>
              </Pressable>
            ))}
          </View>
        </View>
      ))}
    </Screen>
  );
}

function BigOption({ icon, title, onPress }: { icon: React.ComponentProps<typeof SymbolView>['name']; title: string; onPress: () => void }) {
  const p = usePalette();
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.big, { backgroundColor: pressed ? p.surfaceRaised : p.surface, borderColor: p.border }]}>
      <SymbolView name={icon} tintColor={p.accent} size={26} />
      <T v="label" style={{ textAlign: 'center' }}>
        {title}
      </T>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: space.sm },
  big: { flex: 1, alignItems: 'center', gap: space.sm, padding: space.lg, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth },
  sectionTitle: { textTransform: 'uppercase', letterSpacing: 0.6, marginLeft: space.xs },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  card: { flexGrow: 1, flexBasis: '45%', minHeight: 78, padding: space.md, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, gap: 4 },
});

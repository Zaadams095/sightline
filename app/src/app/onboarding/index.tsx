import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { WelcomeBack } from '@/components/backup/welcome-back';
import { offerSampleAlert } from '@/components/demo-banner';
import { Button, Screen, T } from '@/components/ui/primitives';
import { useApp } from '@/state/store';
import { CATALOG, type Category, type SystemDescriptor } from '@/systems/catalog';
import { startDemo, useDemoActive } from '@/systems/demo/session';
import { space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';

const SECTIONS: { category: Category; title: string }[] = [
  { category: 'recorder', title: 'Recorders (the box your cameras plug into)' },
  { category: 'software', title: 'Camera software on a computer' },
  { category: 'camera', title: 'Individual cameras' },
];

export default function Welcome() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  // Opened from Settings → "Add a recorder or camera": offer a way back out.
  const adding = useApp((s) => s.onboarded);

  const demoActive = useDemoActive();
  const [startingDemo, setStartingDemo] = useState(false);
  const tryDemo = async () => {
    setStartingDemo(true);
    try {
      await startDemo();
      router.replace('/');
      // Only on this explicit tap: offer one sample notification so alerts can be seen too.
      setTimeout(offerSampleAlert, 1200);
    } finally {
      setStartingDemo(false);
    }
  };

  const pick = (d: SystemDescriptor) => {
    if (d.kind === 'rtsp') router.push('/onboarding/rtsp');
    else router.push({ pathname: '/onboarding/connect', params: { kind: d.kind } });
  };

  return (
    <Screen style={{ paddingTop: insets.top + (adding ? space.sm : space.xxl) }}>
      {adding && (
        <Pressable
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
          accessibilityRole="button"
          hitSlop={8}
          style={{ alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center' }}>
          <T color={p.accent}>Cancel</T>
        </Pressable>
      )}
      <View style={{ gap: space.sm }}>
        {adding ? (
          <T v="title">Add a recorder or camera</T>
        ) : (
          <T v="title" style={{ fontSize: 34 }}>
            Your cameras.{'\n'}Your network.
          </T>
        )}
        <T muted>Watch live, look back at recordings and get alerts, straight from your own system. Nothing goes through the cloud.</T>
      </View>
      {!adding && <WelcomeBack />}

      <Button title="Find my cameras" onPress={() => router.push('/onboarding/discover')} />
      <T v="caption" muted style={{ textAlign: 'center', marginTop: -space.sm }}>
        Sightline looks around your home Wi-Fi and finds cameras and recorders for you.
      </T>
      <Button title="Pick your camera brand" kind="secondary" onPress={() => router.push('/onboarding/brands')} />

      {!demoActive && (
        <View style={[styles.demo, { backgroundColor: p.surface, borderColor: p.border }]}>
          <T v="label">No cameras handy?</T>
          <T v="caption" muted>
            Explore every feature with built-in sample cameras. Nothing to set up, and you can connect your own any time.
          </T>
          <Button title="Try it with sample cameras" kind="secondary" loading={startingDemo} onPress={() => void tryDemo()} />
        </View>
      )}

      <View style={styles.row}>
        <BigOption icon="qrcode.viewfinder" title="Someone shared cameras with me" onPress={() => router.push('/onboarding/invite')} />
        <BigOption icon="server.rack" title="I have a Sightline Hub" onPress={() => router.push({ pathname: '/onboarding/connect', params: { kind: 'hub' } })} />
      </View>

      <T v="heading" style={{ marginTop: space.md }}>
        Or choose what you record with
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
                accessibilityRole="button"
                accessibilityLabel={`${d.label}. ${d.available ? d.blurb : 'Coming soon'}`}
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
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={title} style={({ pressed }) => [styles.big, { backgroundColor: pressed ? p.surfaceRaised : p.surface, borderColor: p.border }]}>
      <SymbolView name={icon} tintColor={p.accent} size={26} />
      <T v="label" style={{ textAlign: 'center' }}>
        {title}
      </T>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: space.sm },
  demo: { gap: space.sm, padding: space.lg, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth },
  big: { flex: 1, alignItems: 'center', gap: space.sm, padding: space.lg, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth },
  sectionTitle: { textTransform: 'uppercase', letterSpacing: 0.6, marginLeft: space.xs },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  card: { flexGrow: 1, flexBasis: '45%', minHeight: 78, padding: space.md, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, gap: 4 },
});

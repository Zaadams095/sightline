import { router } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Screen, T } from '@/components/ui/primitives';
import { SYSTEMS, type SystemDescriptor } from '@/systems/types';
import { space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';

export default function Welcome() {
  const p = usePalette();
  const insets = useSafeAreaInsets();

  const pick = (s: SystemDescriptor) => {
    if (s.kind === 'frigate') router.push('/onboarding/frigate');
    else if (s.kind === 'rtsp') router.push('/onboarding/rtsp');
  };

  return (
    <Screen style={{ paddingTop: insets.top + space.xxl }}>
      <View style={{ gap: space.sm }}>
        <T v="title" style={{ fontSize: 34 }}>
          Your cameras.{'\n'}Your network.
        </T>
        <T muted>Live view, recordings and alerts, straight from your own system. Nothing goes through the cloud.</T>
      </View>

      <T v="heading" style={{ marginTop: space.lg }}>
        What are you running?
      </T>
      <View style={styles.grid}>
        {SYSTEMS.map((s) => (
          <Pressable
            key={s.kind}
            disabled={!s.available}
            onPress={() => pick(s)}
            style={({ pressed }) => [
              styles.card,
              {
                backgroundColor: pressed ? p.surfaceRaised : p.surface,
                borderColor: p.border,
                opacity: s.available ? 1 : 0.5,
              },
            ]}>
            <T v="label" style={{ fontSize: 15 }}>
              {s.label}
            </T>
            <T v="caption" muted numberOfLines={2}>
              {s.available ? s.blurb : 'Coming soon'}
            </T>
          </Pressable>
        ))}
      </View>
      <T v="caption" muted style={{ textAlign: 'center' }}>
        Don&apos;t see yours? Most cameras work with &quot;IP camera (RTSP)&quot;. You can add more systems later.
      </T>
    </Screen>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  card: {
    flexGrow: 1,
    flexBasis: '45%',
    minHeight: 84,
    padding: space.md,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 4,
  },
});

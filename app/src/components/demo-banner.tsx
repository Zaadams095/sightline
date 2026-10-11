import { router } from 'expo-router';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { T } from '@/components/ui/primitives';
import { removeDemo, sendSampleAlert, useDemoActive, useOnlyDemo } from '@/systems/demo/session';
import { space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';

/**
 * Shown while the sample cameras are in the app, so nobody mistakes them for real ones.
 * One tap goes to connecting real cameras.
 */
export function DemoBanner() {
  const p = usePalette();
  const active = useDemoActive();
  const only = useOnlyDemo();
  if (!active) return null;
  return (
    <View style={[styles.banner, { backgroundColor: p.surface, borderColor: p.border }]} accessibilityRole="summary">
      <View style={styles.head}>
        <SamplePill />
        <T v="caption" muted style={{ flex: 1 }}>
          {only ? 'You’re exploring with sample video. None of this is a real camera.' : 'Sample cameras are shown along with yours.'}
        </T>
      </View>
      <View style={styles.actions}>
        <Pressable
          onPress={() => router.push('/onboarding')}
          accessibilityRole="button"
          style={({ pressed }) => [styles.primary, { backgroundColor: p.accent, opacity: pressed ? 0.8 : 1 }]}>
          <T v="label" color={p.accentText}>
            Connect my real cameras
          </T>
        </Pressable>
        <Pressable onPress={only ? offerSampleAlert : confirmRemoveDemo} accessibilityRole="button" hitSlop={6} style={styles.secondary}>
          <T v="label" color={p.accent}>
            {only ? 'Try an alert' : 'Remove samples'}
          </T>
        </Pressable>
      </View>
    </View>
  );
}

/** A small "SAMPLE" tag for tiles and screens showing sample video. */
export function SamplePill({ dark }: { dark?: boolean }) {
  return (
    <View style={[styles.pill, { backgroundColor: dark ? 'rgba(255,255,255,0.2)' : '#FF9F0A' }]} accessibilityLabel="Sample video">
      <Text style={styles.pillText}>SAMPLE</Text>
    </View>
  );
}

/** Asks first, then sends one sample alert a few seconds later. */
export function offerSampleAlert() {
  Alert.alert('See what an alert looks like?', 'Sightline will send you one sample alert in a few seconds. You can lock your phone to see it on the Lock Screen.', [
    { text: 'Not now', style: 'cancel' },
    {
      text: 'Send one',
      onPress: async () => {
        const res = await sendSampleAlert().catch(() => 'denied' as const);
        if (res === 'denied') {
          Alert.alert('Notifications are off', 'To get alerts, allow notifications for Sightline in the iPhone Settings app.');
        }
      },
    },
  ]);
}

export function confirmRemoveDemo() {
  Alert.alert('Remove the sample cameras?', 'They’ll disappear from the app. You can add them again from Settings any time.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Remove', style: 'destructive', onPress: removeDemo },
  ]);
}

const styles = StyleSheet.create({
  banner: { marginHorizontal: space.lg, padding: space.md, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, gap: space.sm },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  actions: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  primary: { paddingHorizontal: 14, minHeight: 40, borderRadius: 12, justifyContent: 'center' },
  secondary: { minHeight: 40, justifyContent: 'center' },
  pill: { paddingHorizontal: 7, paddingVertical: 3, borderRadius: 6 },
  pillText: { color: '#fff', fontSize: 11, fontWeight: '800', letterSpacing: 0.6 },
});

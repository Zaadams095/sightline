import { router } from 'expo-router';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { T } from '@/components/ui/primitives';
import { tr } from '@/i18n';
import { useT } from '@/i18n/use-t';
import { removeDemo, sendSampleAlert, useDemoActive, useOnlyDemo } from '@/systems/demo/session';
import { OVERLAY_MAX_SCALE, space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';

/**
 * Shown while the sample cameras are in the app, so nobody mistakes them for real ones.
 * One tap goes to connecting real cameras.
 */
export function DemoBanner() {
  const p = usePalette();
  const t = useT();
  const active = useDemoActive();
  const only = useOnlyDemo();
  if (!active) return null;
  return (
    <View style={[styles.banner, { backgroundColor: p.surface, borderColor: p.border }]} accessibilityRole="summary">
      <View style={styles.head}>
        <SamplePill />
        <T v="caption" muted style={{ flex: 1 }}>
          {only ? t.home.demo.exploring : t.home.demo.alongside}
        </T>
      </View>
      <View style={styles.actions}>
        <Pressable
          onPress={() => router.push('/onboarding')}
          accessibilityRole="button"
          style={({ pressed }) => [styles.primary, { backgroundColor: p.accent, opacity: pressed ? 0.8 : 1 }]}>
          <T v="label" color={p.accentText}>
            {t.home.demo.connectReal}
          </T>
        </Pressable>
        <Pressable onPress={only ? offerSampleAlert : confirmRemoveDemo} accessibilityRole="button" hitSlop={6} style={styles.secondary}>
          <T v="label" color={p.accent}>
            {only ? t.home.demo.tryAlert : t.home.demo.removeSamples}
          </T>
        </Pressable>
      </View>
    </View>
  );
}

/** A small "SAMPLE" tag for tiles and screens showing sample video. */
export function SamplePill({ dark }: { dark?: boolean }) {
  const t = useT();
  return (
    <View style={[styles.pill, { backgroundColor: dark ? 'rgba(255,255,255,0.2)' : '#FF9F0A' }]} accessibilityLabel={t.home.demo.sampleA11y}>
      <Text style={styles.pillText} maxFontSizeMultiplier={OVERLAY_MAX_SCALE}>
        {t.home.demo.sample}
      </Text>
    </View>
  );
}

/** Asks first, then sends one sample alert a few seconds later. */
export function offerSampleAlert() {
  const d = tr().home.demo;
  Alert.alert(d.alertTitle, d.alertBody, [
    { text: tr().common.notNow, style: 'cancel' },
    {
      text: d.sendOne,
      onPress: async () => {
        const res = await sendSampleAlert().catch(() => 'denied' as const);
        if (res === 'denied') {
          Alert.alert(tr().home.demo.notificationsOffTitle, tr().home.demo.notificationsOffBody);
        }
      },
    },
  ]);
}

export function confirmRemoveDemo() {
  const d = tr().home.demo;
  Alert.alert(d.removeTitle, d.removeBody, [
    { text: tr().common.cancel, style: 'cancel' },
    { text: tr().common.remove, style: 'destructive', onPress: removeDemo },
  ]);
}

const styles = StyleSheet.create({
  banner: { marginHorizontal: space.lg, padding: space.md, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, gap: space.sm },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  // Wraps so the second button drops to its own line at big text sizes.
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.md },
  primary: { paddingHorizontal: 14, paddingVertical: 8, minHeight: 40, borderRadius: 12, justifyContent: 'center' },
  secondary: { minHeight: 40, justifyContent: 'center' },
  pill: { paddingHorizontal: 7, paddingVertical: 3, borderRadius: 6 },
  pillText: { color: '#fff', fontSize: 11, fontWeight: '800', letterSpacing: 0.6 },
});

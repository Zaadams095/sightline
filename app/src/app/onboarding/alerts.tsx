import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { registerBackgroundAlerts, requestNotificationPermission } from '@/alerts/background';
import { Button, Screen, T } from '@/components/ui/primitives';
import { useApp } from '@/state/store';
import { space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';

export default function OnboardingAlerts() {
  const insets = useSafeAreaInsets();
  const setAlerts = useApp((s) => s.setAlerts);
  const setOnboarded = useApp((s) => s.setOnboarded);
  const onboarded = useApp((s) => s.onboarded);
  const currentMode = useApp((s) => s.alerts.mode);
  // Instant Alerts come from a Sightline Hub, so they're only offered once one is paired.
  const hasHub = useApp((s) => s.systems.some((x) => x.kind === 'hub'));
  const [mode, setMode] = useState<'built-in' | 'instant'>(() => (onboarded ? currentMode : hasHub ? 'instant' : 'built-in'));

  const finish = async () => {
    // Someone adding another system later keeps the alert choice they already made.
    if (!onboarded) setAlerts({ mode: mode === 'instant' && !hasHub ? 'built-in' : mode });
    await requestNotificationPermission();
    await registerBackgroundAlerts();
    // First-time setup ends by offering the Face ID lock; adding a system later just returns.
    if (!onboarded) return router.push('/onboarding/lock');
    router.replace('/');
  };

  return (
    <Screen style={{ paddingTop: insets.top + 56 }}>
      <View style={{ gap: space.xs }}>
        <T v="title">Alerts</T>
        <T muted>Choose how alerts reach you. You can pick which cameras and what kind of activity alert you any time in Settings.</T>
      </View>
      <Option
        selected={mode === 'built-in'}
        onSelect={() => setMode('built-in')}
        title="Built-in"
        tag="No setup"
        body="Sightline checks your cameras in the background and sends notifications with a picture. iPhone decides when that runs, so alerts can be several minutes late."
      />
      <Option
        selected={mode === 'instant'}
        onSelect={() => setMode('instant')}
        disabled={!hasHub}
        title="Instant Alerts"
        tag={hasHub ? 'Recommended' : 'Needs a Sightline Hub'}
        body={
          hasHub
            ? 'Alerts arrive within a second, through your Sightline Hub. Pictures and video stay at home.'
            : 'Alerts within a second need a Sightline Hub at home: a free add-on for Home Assistant, or a small app for a NAS or always-on computer. Start with Built-in and switch any time.'
        }
      />
      {!hasHub && (
        <Button title="Set up a Sightline Hub" kind="ghost" onPress={() => router.push({ pathname: '/onboarding/connect', params: { kind: 'hub' } })} />
      )}
      <Button title="Finish" onPress={finish} />
    </Screen>
  );
}

function Option({
  selected,
  onSelect,
  title,
  body,
  tag,
  disabled,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  body: string;
  tag: string;
  disabled?: boolean;
}) {
  const p = usePalette();
  return (
    <Pressable
      onPress={onSelect}
      disabled={disabled}
      accessibilityRole="radio"
      accessibilityState={{ selected, disabled: !!disabled }}
      accessibilityLabel={`${title}, ${tag}. ${body}`}
      style={[styles.option, { backgroundColor: p.surface, borderColor: selected ? p.accent : p.border, opacity: disabled ? 0.6 : 1 }]}>
      <View style={styles.optionHead}>
        <T v="heading" style={{ fontSize: 17 }}>
          {title}
        </T>
        <T v="caption" color={disabled ? p.textMuted : p.accent}>
          {tag}
        </T>
      </View>
      <T muted>{body}</T>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  option: { padding: space.lg, borderRadius: 16, borderWidth: 2, gap: space.sm },
  optionHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
});

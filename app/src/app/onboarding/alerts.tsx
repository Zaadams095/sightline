import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { registerBackgroundAlerts, requestNotificationPermission } from '@/alerts/background';
import { Button, Screen, T } from '@/components/ui/primitives';
import { useT } from '@/i18n/use-t';
import { useApp } from '@/state/store';
import { space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';

export default function OnboardingAlerts() {
  const insets = useSafeAreaInsets();
  const t = useT();
  const a = t.onboarding.alerts;
  const setAlerts = useApp((s) => s.setAlerts);
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
        <T v="title">{a.title}</T>
        <T muted>{a.intro}</T>
      </View>
      <Option selected={mode === 'built-in'} onSelect={() => setMode('built-in')} title={a.builtIn} tag={a.noSetup} body={a.builtInBody} />
      <Option
        selected={mode === 'instant'}
        onSelect={() => setMode('instant')}
        disabled={!hasHub}
        title={a.instant}
        tag={hasHub ? a.recommended : a.needsHub}
        body={hasHub ? a.instantBody : a.instantBodyNoHub}
      />
      {!hasHub && <Button title={a.setUpHub} kind="ghost" onPress={() => router.push({ pathname: '/onboarding/connect', params: { kind: 'hub' } })} />}
      <Button title={a.finish} onPress={finish} />
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
  // Wraps so the tag drops under the title at large text sizes or in longer languages.
  optionHead: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', columnGap: space.sm, rowGap: 2 },
});

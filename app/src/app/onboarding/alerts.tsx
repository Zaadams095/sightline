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
  const [mode, setMode] = useState<'built-in' | 'instant'>('built-in');

  const finish = async () => {
    setAlerts({ mode });
    await requestNotificationPermission();
    await registerBackgroundAlerts();
    setOnboarded(true);
    router.replace('/');
    if (mode === 'instant') router.push('/settings/bridge');
  };

  return (
    <Screen style={{ paddingTop: insets.top + 56 }}>
      <View style={{ gap: space.xs }}>
        <T v="title">Alerts</T>
        <T muted>Choose which cameras, objects and zones notify you. You can fine-tune this any time in Settings.</T>
      </View>
      <Option
        selected={mode === 'built-in'}
        onSelect={() => setMode('built-in')}
        title="Built-in"
        tag="No setup"
        body="The app checks your system in the background and sends notifications with a snapshot. iOS decides when that runs, so alerts can be delayed by several minutes or more."
      />
      <Option
        selected={mode === 'instant'}
        onSelect={() => setMode('instant')}
        title="Instant Alerts"
        tag="Recommended"
        body="Alerts arrive within a second. Needs a Sightline Hub at home (a free add-on for Home Assistant, or an app for your NAS or computer). No images leave your network."
      />
      <Button title="Finish" onPress={finish} />
    </Screen>
  );
}

function Option({ selected, onSelect, title, body, tag }: { selected: boolean; onSelect: () => void; title: string; body: string; tag: string }) {
  const p = usePalette();
  return (
    <Pressable
      onPress={onSelect}
      style={[styles.option, { backgroundColor: p.surface, borderColor: selected ? p.accent : p.border }]}>
      <View style={styles.optionHead}>
        <T v="heading" style={{ fontSize: 17 }}>
          {title}
        </T>
        <T v="caption" color={p.accent}>
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

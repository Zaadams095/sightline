import { Stack } from 'expo-router';
import { Linking } from 'react-native';

import { Button, Card, Screen, T } from '@/components/ui/primitives';
import { useT } from '@/i18n/use-t';
import { space } from '@/theme/tokens';

/**
 * Settings → Privacy → Share crash data with the developer. iOS owns this switch (apps can't
 * flip it), so this explains what it does and where to find it.
 */
export default function CrashData() {
  const c = useT().settings.crashData;
  return (
    <Screen>
      <Stack.Screen options={{ title: c.title }} />
      <T>{c.intro}</T>

      <Card style={{ padding: space.md, gap: space.sm }}>
        <T v="label">{c.turnOnTitle}</T>
        <T muted>{c.step1}</T>
        <T muted>{c.step2}</T>
        <T muted>{c.step3}</T>
        <T muted>{c.step4}</T>
      </Card>
      <Button title={c.openSettings} kind="secondary" onPress={() => void Linking.openSettings()} />
      <T v="caption" muted>
        {c.opensNote}
      </T>

      <T v="label">{c.whatsInTitle}</T>
      <T muted>{c.whatsInBody}</T>
      <T muted>{c.keptBody}</T>
    </Screen>
  );
}

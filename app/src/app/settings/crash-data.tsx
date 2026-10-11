import { Stack } from 'expo-router';
import { Linking } from 'react-native';

import { Button, Card, Screen, T } from '@/components/ui/primitives';
import { space } from '@/theme/tokens';

/**
 * Settings → Privacy → Share crash data with the developer. iOS owns this switch (apps can't
 * flip it), so this explains what it does and where to find it.
 */
export default function CrashData() {
  return (
    <Screen>
      <Stack.Screen options={{ title: 'Crash data' }} />
      <T>
        If Sightline ever closes by itself, iOS writes a short crash report. You can let iOS pass these reports to the
        developer so problems get fixed, even ones you never report.
      </T>

      <Card style={{ padding: space.md, gap: space.sm }}>
        <T v="label">Turn it on in iOS Settings</T>
        <T muted>1. Open the Settings app.</T>
        <T muted>2. Tap Privacy & Security.</T>
        <T muted>3. Tap Analytics & Improvements.</T>
        <T muted>4. Turn on Share With App Developers.</T>
      </Card>
      <Button title="Open the Settings app" kind="secondary" onPress={() => void Linking.openSettings()} />
      <T v="caption" muted>
        This opens Sightline’s page in Settings. Go back to the main Settings list to find Privacy & Security.
      </T>

      <T v="label">What’s in a crash report</T>
      <T muted>
        Which part of the app stopped, your iPhone model and iOS version. No camera video, pictures, names, addresses or
        passwords. Apple delivers the reports, and Sightline has no server of its own.
      </T>
      <T muted>
        Sightline also keeps the crash reports iOS gives it on your phone, and only includes them when you choose
        Settings → Report a problem and tap Send.
      </T>
    </Screen>
  );
}

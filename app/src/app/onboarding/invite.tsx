import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, Screen, T } from '@/components/ui/primitives';

// Placeholder: invite redemption (scan a share QR from a Sightline Hub) is implemented with
// the sharing feature (docs/PLATFORM.md §5).
export default function Invite() {
  const insets = useSafeAreaInsets();
  return (
    <Screen style={{ paddingTop: insets.top + 56 }}>
      <T v="title">Shared cameras</T>
      <T muted>Ask the person who shared cameras with you for their invite QR code.</T>
      <Button title="Back" kind="secondary" onPress={() => router.back()} />
    </Screen>
  );
}

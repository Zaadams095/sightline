import { router } from 'expo-router';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, Screen, T } from '@/components/ui/primitives';
import { VpnSetup } from '@/components/vpn-setup';
import { space } from '@/theme/tokens';
import { isExpoGo } from '@/util/runtime';

export default function OnboardingVpn() {
  const insets = useSafeAreaInsets();
  const next = () => router.push('/onboarding/alerts');
  return (
    <Screen style={{ paddingTop: insets.top + 56 }}>
      <View style={{ gap: space.xs }}>
        <T v="title">Away from home</T>
        <T muted>
          The app has WireGuard built in. It connects on its own when you&apos;re away and stays off at home. There&apos;s no
          VPN switch to flip and no VPN icon, and your phone&apos;s other traffic doesn&apos;t use it.
        </T>
      </View>
      {isExpoGo ? (
        <T muted>Preview mode (Expo Go): the built-in VPN only works in the TestFlight build. Skip this for now.</T>
      ) : (
        <VpnSetup onSaved={next} />
      )}
      <Button title="Skip for now" kind="ghost" onPress={next} />
    </Screen>
  );
}

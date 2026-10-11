import { router } from 'expo-router';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ChoiceRow, StepList } from '@/components/guide/parts';
import { Button, Card, Screen, T } from '@/components/ui/primitives';
import { GUIDES } from '@/systems/guides';
import { space } from '@/theme/tokens';

/** "I don't know my brand": three easy ways to find out, none of them technical. */
export default function FindBrand() {
  const insets = useSafeAreaInsets();
  const withApps = GUIDES.filter((g) => g.app).sort((a, b) => a.app!.localeCompare(b.app!));

  return (
    <Screen style={{ paddingTop: insets.top + 56 }}>
      <View style={{ gap: space.xs }}>
        <T v="title">Let’s find out together</T>
        <T muted>Any one of these will do.</T>
      </View>

      <Card>
        <View style={{ gap: space.md }}>
          <T v="heading">Let Sightline look</T>
          <T muted>It checks your home Wi-Fi for cameras and recorders. Takes about 20 seconds.</T>
          <Button title="Find cameras on my Wi-Fi" onPress={() => router.push('/onboarding/discover')} />
        </View>
      </Card>

      <Card>
        <View style={{ gap: space.md }}>
          <T v="heading">Check the sticker</T>
          <StepList
            steps={[
              'Most cameras have a sticker underneath, on the back, or inside the battery door. Recorders have one on the bottom.',
              'It shows the brand and model, and often a code or password you may need later.',
              'Take a photo of it with your phone’s Camera app so the codes are handy when you need them.',
            ]}
          />
          <T v="caption" muted>
            No sticker? The brand is usually printed on the front of the camera or on its box.
          </T>
        </View>
      </Card>

      <View style={{ gap: space.sm }}>
        <T v="heading">Which app do you watch it with?</T>
        <T muted>The app on your phone tells you the brand. Tap yours.</T>
        {withApps.map((g) => (
          <ChoiceRow
            key={g.id}
            title={`${g.app} app`}
            detail={g.name}
            onPress={() => router.push({ pathname: '/onboarding/guide', params: { brand: g.id } })}
          />
        ))}
      </View>

      <Button title="Back to brands" kind="ghost" onPress={() => router.back()} />
    </Screen>
  );
}

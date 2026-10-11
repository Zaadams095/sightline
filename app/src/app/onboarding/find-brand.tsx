import { router } from 'expo-router';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ChoiceRow, StepList } from '@/components/guide/parts';
import { Button, Card, Screen, T } from '@/components/ui/primitives';
import { useT } from '@/i18n/use-t';
import { GUIDES } from '@/systems/guides';
import { space } from '@/theme/tokens';

/** "I don't know my brand": three easy ways to find out, none of them technical. */
export default function FindBrand() {
  const insets = useSafeAreaInsets();
  const t = useT();
  const f = t.onboarding.findBrand;
  const withApps = GUIDES.filter((g) => g.app).sort((a, b) => a.app!.localeCompare(b.app!));

  return (
    <Screen style={{ paddingTop: insets.top + 56 }}>
      <View style={{ gap: space.xs }}>
        <T v="title">{f.title}</T>
        <T muted>{f.subtitle}</T>
      </View>

      <Card>
        <View style={{ gap: space.md }}>
          <T v="heading">{f.letLook}</T>
          <T muted>{f.letLookBody}</T>
          <Button title={t.onboarding.brands.findOnWifi} onPress={() => router.push('/onboarding/discover')} />
        </View>
      </Card>

      <Card>
        <View style={{ gap: space.md }}>
          <T v="heading">{f.sticker}</T>
          <StepList steps={[f.stickerStep1, f.stickerStep2, f.stickerStep3]} />
          <T v="caption" muted>
            {f.noSticker}
          </T>
        </View>
      </Card>

      <View style={{ gap: space.sm }}>
        <T v="heading">{f.whichApp}</T>
        <T muted>{f.whichAppBody}</T>
        {withApps.map((g) => (
          <ChoiceRow
            key={g.id}
            title={t.onboarding.brands.appName(g.app!)}
            detail={g.name}
            onPress={() => router.push({ pathname: '/onboarding/guide', params: { brand: g.id } })}
          />
        ))}
      </View>

      <Button title={f.backToBrands} kind="ghost" onPress={() => router.back()} />
    </Screen>
  );
}

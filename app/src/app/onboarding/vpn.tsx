import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, Screen, T } from '@/components/ui/primitives';
import { VpnSetup } from '@/components/vpn-setup';
import { useT } from '@/i18n/use-t';
import { useApp } from '@/state/store';
import { space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';
import { isExpoGo } from '@/util/runtime';

type Choice = 'hub' | 'vpn' | null;

/**
 * Away-from-home access, in plain language. The Hub is the easy path; an existing WireGuard
 * VPN is the advanced one; "home only" is a fine answer too.
 */
export default function OnboardingAway() {
  const p = usePalette();
  const t = useT();
  const v = t.onboarding.vpn;
  const insets = useSafeAreaInsets();
  const hasHub = useApp((s) => s.systems.some((x) => x.kind === 'hub'));
  const [choice, setChoice] = useState<Choice>(null);
  // Adding another system later (from Settings) keeps the alert choice already made.
  const onboarded = useApp((s) => s.onboarded);
  const next = () => (onboarded ? router.replace('/') : router.push('/onboarding/alerts'));

  if (hasHub) {
    // The Hub already provides remote access; nothing to set up here.
    return (
      <Screen style={{ paddingTop: insets.top + 56 }}>
        <T v="title">{v.awayTitle}</T>
        <T muted>{v.hubHandles}</T>
        <Button title={t.common.continue} onPress={next} />
      </Screen>
    );
  }

  return (
    <Screen style={{ paddingTop: insets.top + 56 }}>
      <View style={{ gap: space.xs }}>
        <T v="title">{v.title}</T>
        <T muted>{v.intro}</T>
      </View>

      <Option icon="server.rack" title={v.hubOption} body={v.hubBody} selected={choice === 'hub'} onPress={() => setChoice('hub')} />
      <Option icon="lock.shield" title={v.vpnOption} body={v.vpnBody} selected={choice === 'vpn'} onPress={() => setChoice('vpn')} />

      {choice === 'hub' && (
        <View style={{ gap: space.sm }}>
          <T muted>{v.hubSteps}</T>
          <Button title={v.haveHub} onPress={() => router.push('/onboarding/invite')} />
        </View>
      )}
      {choice === 'vpn' && (isExpoGo ? <T muted>{v.previewOnly}</T> : <VpnSetup onSaved={next} />)}

      <Button title={v.homeOnly} kind="ghost" onPress={next} />
      <T v="caption" color={p.textMuted} style={{ textAlign: 'center' }}>
        {v.changeLater}
      </T>
    </Screen>
  );
}

function Option({
  icon,
  title,
  body,
  selected,
  onPress,
}: {
  icon: React.ComponentProps<typeof SymbolView>['name'];
  title: string;
  body: string;
  selected: boolean;
  onPress: () => void;
}) {
  const p = usePalette();
  return (
    <Pressable onPress={onPress} style={[styles.option, { backgroundColor: p.surface, borderColor: selected ? p.accent : p.border }]}>
      <SymbolView name={icon} tintColor={p.accent} size={24} />
      <View style={{ flex: 1, gap: 4 }}>
        <T v="label" style={{ fontSize: 16 }}>
          {title}
        </T>
        <T muted>{body}</T>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  option: { flexDirection: 'row', gap: space.md, padding: space.lg, borderRadius: 16, borderWidth: 2 },
});

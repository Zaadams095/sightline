import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, Screen, T } from '@/components/ui/primitives';
import { VpnSetup } from '@/components/vpn-setup';
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
        <T v="title">Away from home</T>
        <T muted>Your Sightline Hub takes care of this. Your cameras will work anywhere.</T>
        <Button title="Continue" onPress={next} />
      </Screen>
    );
  }

  return (
    <Screen style={{ paddingTop: insets.top + 56 }}>
      <View style={{ gap: space.xs }}>
        <T v="title">Watching when you’re away</T>
        <T muted>At home, Sightline connects directly. To see your cameras from anywhere else, pick one:</T>
      </View>

      <Option
        icon="server.rack"
        title="Sightline Hub (easiest)"
        body="A free add-on for Home Assistant, or a small app for a NAS or always-on computer. No router settings. Also gives instant alerts and sharing with family."
        selected={choice === 'hub'}
        onPress={() => setChoice('hub')}
      />
      <Option
        icon="lock.shield"
        title="My own VPN (advanced)"
        body="If your router already has a VPN you connect to from your phone, scan its QR code. Sightline turns it on by itself only when needed."
        selected={choice === 'vpn'}
        onPress={() => setChoice('vpn')}
      />

      {choice === 'hub' && (
        <View style={{ gap: space.sm }}>
          <T muted>
            Install the Hub, open its setup page, then scan the QR code it shows. You can do this any time from Settings.
          </T>
          <Button title="I have the Hub running: scan its code" onPress={() => router.push('/onboarding/invite')} />
        </View>
      )}
      {choice === 'vpn' &&
        (isExpoGo ? (
          <T muted>Preview mode: your own VPN only works in the full app.</T>
        ) : (
          <VpnSetup onSaved={next} />
        ))}

      <Button title="Only at home for now" kind="ghost" onPress={next} />
      <T v="caption" color={p.textMuted} style={{ textAlign: 'center' }}>
        You can change this later in Settings.
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

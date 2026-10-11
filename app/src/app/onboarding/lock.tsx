import * as LocalAuthentication from 'expo-local-authentication';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, Screen, T } from '@/components/ui/primitives';
import { SymbolView } from '@/components/ui/symbol';
import { tr } from '@/i18n';
import { useT } from '@/i18n/use-t';
import { useApp } from '@/state/store';
import { space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';

type Biometric = { name: 'Face ID' | 'Touch ID'; symbol: 'faceid' | 'touchid' };

/**
 * Last setup step: offer to lock the app with Face ID / Touch ID. This is Sightline's answer
 * to a login screen: nobody else holding the phone can open the cameras, and there's no
 * account or cloud behind it. Skipped silently on phones without biometrics set up.
 */
export default function OnboardingLock() {
  const p = usePalette();
  const t = useT();
  const l = t.onboarding.lock;
  const insets = useSafeAreaInsets();
  const setSecurity = useApp((s) => s.setSecurity);
  const setOnboarded = useApp((s) => s.setOnboarded);
  const [bio, setBio] = useState<Biometric | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const done = () => {
    setOnboarded(true);
    router.replace('/');
  };

  useEffect(() => {
    void (async () => {
      const [hardware, enrolled, types] = await Promise.all([
        LocalAuthentication.hasHardwareAsync(),
        LocalAuthentication.isEnrolledAsync(),
        LocalAuthentication.supportedAuthenticationTypesAsync(),
      ]).catch(() => [false, false, []] as const);
      if (!hardware || !enrolled) {
        // Nothing to offer (no Face ID/Touch ID set up); a PIN is still in Settings → Security.
        setOnboarded(true);
        router.replace('/');
        return;
      }
      setBio(
        types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)
          ? { name: 'Face ID', symbol: 'faceid' }
          : { name: 'Touch ID', symbol: 'touchid' },
      );
    })();
  }, [setOnboarded]);

  const turnOn = async () => {
    setBusy(true);
    setMsg(null);
    // Unlock once now, so the lock is only turned on if it will actually let them back in.
    const res = await LocalAuthentication.authenticateAsync({ promptMessage: tr().onboarding.lock.prompt }).catch(() => null);
    setBusy(false);
    if (!res?.success) {
      setMsg(tr().onboarding.lock.didntWork(bio?.name ?? 'Face ID'));
      return;
    }
    setSecurity({ lockEnabled: true, method: 'device', hideAppSwitcherPreview: true });
    done();
  };

  if (!bio) return null;

  return (
    <Screen style={{ paddingTop: insets.top + 56 }}>
      <View style={{ alignItems: 'center', gap: space.lg, paddingVertical: space.xl }}>
        <SymbolView name={bio.symbol} size={64} tintColor={p.accent} />
        <T v="title" style={{ textAlign: 'center' }}>
          {l.title}
        </T>
        <T muted style={{ textAlign: 'center' }}>
          {l.body(bio.name)}
        </T>
      </View>
      {msg && <T color={p.danger}>{msg}</T>}
      <Button title={l.turnOn(bio.name)} onPress={turnOn} loading={busy} />
      <Button title={t.common.notNow} kind="ghost" onPress={done} />
      <T v="caption" muted style={{ textAlign: 'center' }}>
        {l.changeLater}
      </T>
    </Screen>
  );
}

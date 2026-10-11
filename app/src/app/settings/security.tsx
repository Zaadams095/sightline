import * as LocalAuthentication from 'expo-local-authentication';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Chip, Field, Screen, Section, T, ToggleRow } from '@/components/ui/primitives';
import { tr } from '@/i18n';
import { useT } from '@/i18n/use-t';
import { clearPin, hasPin, setPin } from '@/security/pin';
import { useApp } from '@/state/store';
import { space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';

const RELOCK = [
  { v: 0, get label() { return tr().settings.security.immediately; } },
  { v: 60, get label() { return tr().settings.security.minutes(1); } },
  { v: 300, get label() { return tr().settings.security.minutes(5); } },
  { v: 900, get label() { return tr().settings.security.minutes(15); } },
];

export default function SecuritySettings() {
  const p = usePalette();
  const st = useT().settings.security;
  const security = useApp((s) => s.security);
  const set = useApp((s) => s.setSecurity);
  const [biometricName, setBiometricName] = useState('Face ID');
  const [pinSet, setPinSet] = useState(false);
  const [newPin, setNewPin] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    void hasPin().then(setPinSet);
    void LocalAuthentication.supportedAuthenticationTypesAsync().then((types) => {
      if (!types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) setBiometricName('Touch ID');
    });
  }, []);

  const enable = async (on: boolean) => {
    if (!on) return set({ lockEnabled: false });
    // Confirm the user can actually unlock before turning the lock on.
    const res = await LocalAuthentication.authenticateAsync({ promptMessage: st.turnOnPrompt });
    if (res.success) set({ lockEnabled: true });
  };

  const savePin = async () => {
    if (!/^\d{6}$/.test(newPin)) return setMsg(st.pinDigits);
    await setPin(newPin);
    setPinSet(true);
    setNewPin('');
    set({ method: 'pin' });
    setMsg(st.pinSaved);
  };

  return (
    <Screen>
      <Section footer={st.footer(biometricName)}>
        <ToggleRow label={st.appLock} value={security.lockEnabled} onChange={enable} last={!security.lockEnabled} />
        {security.lockEnabled && (
          <ToggleRow
            label={st.hideSwitcher}
            detail={st.hideSwitcherDetail}
            value={security.hideAppSwitcherPreview}
            onChange={(v) => set({ hideAppSwitcherPreview: v })}
            last
          />
        )}
      </Section>

      {security.lockEnabled && (
        <>
          <T v="caption" muted style={styles.label}>
            {st.unlockWith}
          </T>
          <View style={styles.chips}>
            <Chip label={st.bioAndPasscode(biometricName)} selected={security.method === 'device'} onPress={() => set({ method: 'device' })} />
            <Chip label={st.appPin} selected={security.method === 'pin'} onPress={() => (pinSet ? set({ method: 'pin' }) : setMsg(st.setPinFirst))} />
          </View>

          {security.method === 'pin' && (
            <Section>
              <ToggleRow label={st.alsoAllow(biometricName)} value={security.biometricsWithPin} onChange={(v) => set({ biometricsWithPin: v })} last />
            </Section>
          )}

          <T v="caption" muted style={styles.label}>
            {st.lockAgainAfter}
          </T>
          <View style={styles.chips}>
            {RELOCK.map((r) => (
              <Chip key={r.v} label={r.label} selected={security.relockAfterSec === r.v} onPress={() => set({ relockAfterSec: r.v })} />
            ))}
          </View>

          <View style={{ gap: space.sm }}>
            <Field
              label={pinSet ? st.changePin : st.setPin}
              value={newPin}
              onChangeText={(t) => setNewPin(t.replace(/\D/g, '').slice(0, 6))}
              keyboardType="number-pad"
              secureTextEntry
              placeholder={st.sixDigits}
              hint={st.pinHint}
            />
            <Button title={st.savePin} kind="secondary" onPress={savePin} disabled={newPin.length !== 6} />
            {pinSet && (
              <Button
                title={st.removePin}
                kind="ghost"
                onPress={async () => {
                  await clearPin();
                  setPinSet(false);
                  set({ method: 'device' });
                }}
              />
            )}
            {msg && <T color={p.textMuted}>{msg}</T>}
          </View>
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  label: { textTransform: 'uppercase', letterSpacing: 0.6, marginLeft: space.xs },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
});

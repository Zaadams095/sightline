import * as LocalAuthentication from 'expo-local-authentication';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Chip, Field, Screen, Section, T, ToggleRow } from '@/components/ui/primitives';
import { clearPin, hasPin, setPin } from '@/security/pin';
import { useApp } from '@/state/store';
import { space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';

const RELOCK = [
  { v: 0, label: 'Immediately' },
  { v: 60, label: '1 min' },
  { v: 300, label: '5 min' },
  { v: 900, label: '15 min' },
];

export default function SecuritySettings() {
  const p = usePalette();
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
    const res = await LocalAuthentication.authenticateAsync({ promptMessage: 'Turn on app lock' });
    if (res.success) set({ lockEnabled: true });
  };

  const savePin = async () => {
    if (!/^\d{6}$/.test(newPin)) return setMsg('PIN must be 6 digits.');
    await setPin(newPin);
    setPinSet(true);
    setNewPin('');
    set({ method: 'pin' });
    setMsg('PIN saved.');
  };

  return (
    <Screen>
      <Section footer={`Require ${biometricName} or a PIN to open the app. Useful if others use your phone.`}>
        <ToggleRow label="App lock" value={security.lockEnabled} onChange={enable} last={!security.lockEnabled} />
        {security.lockEnabled && (
          <ToggleRow
            label="Hide in app switcher"
            detail="Covers your cameras when you swipe between apps."
            value={security.hideAppSwitcherPreview}
            onChange={(v) => set({ hideAppSwitcherPreview: v })}
            last
          />
        )}
      </Section>

      {security.lockEnabled && (
        <>
          <T v="caption" muted style={styles.label}>
            Unlock with
          </T>
          <View style={styles.chips}>
            <Chip label={`${biometricName} & iPhone passcode`} selected={security.method === 'device'} onPress={() => set({ method: 'device' })} />
            <Chip label="App PIN" selected={security.method === 'pin'} onPress={() => (pinSet ? set({ method: 'pin' }) : setMsg('Set a PIN below first.'))} />
          </View>

          {security.method === 'pin' && (
            <Section>
              <ToggleRow label={`Also allow ${biometricName}`} value={security.biometricsWithPin} onChange={(v) => set({ biometricsWithPin: v })} last />
            </Section>
          )}

          <T v="caption" muted style={styles.label}>
            Lock again after
          </T>
          <View style={styles.chips}>
            {RELOCK.map((r) => (
              <Chip key={r.v} label={r.label} selected={security.relockAfterSec === r.v} onPress={() => set({ relockAfterSec: r.v })} />
            ))}
          </View>

          <View style={{ gap: space.sm }}>
            <Field
              label={pinSet ? 'Change app PIN' : 'Set app PIN'}
              value={newPin}
              onChangeText={(t) => setNewPin(t.replace(/\D/g, '').slice(0, 6))}
              keyboardType="number-pad"
              secureTextEntry
              placeholder="6 digits"
              hint="A PIN separate from your iPhone passcode, so people who know your passcode still can't open your cameras."
            />
            <Button title="Save PIN" kind="secondary" onPress={savePin} disabled={newPin.length !== 6} />
            {pinSet && (
              <Button
                title="Remove PIN"
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

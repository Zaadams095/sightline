import * as Haptics from 'expo-haptics';
import * as LocalAuthentication from 'expo-local-authentication';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Modal, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, T } from '@/components/ui/primitives';
import { checkPin } from '@/security/pin';
import { useApp } from '@/state/store';
import { space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';

const PIN_LENGTH = 6;

/**
 * Optional app lock. Covers the app (and the app-switcher snapshot) until the user
 * authenticates with Face ID / Touch ID, the device passcode, or an app PIN.
 */
export function AppLockGate() {
  const security = useApp((s) => s.security);
  const [locked, setLocked] = useState(security.lockEnabled);
  const [covered, setCovered] = useState(false);
  const backgroundedAt = useRef<number | null>(null);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      const { lockEnabled, relockAfterSec, hideAppSwitcherPreview } = useApp.getState().security;
      if (state === 'inactive' || state === 'background') {
        if (hideAppSwitcherPreview && lockEnabled) setCovered(true);
        if (state === 'background') backgroundedAt.current ??= Date.now();
      } else if (state === 'active') {
        setCovered(false);
        const away = backgroundedAt.current ? (Date.now() - backgroundedAt.current) / 1000 : 0;
        backgroundedAt.current = null;
        if (lockEnabled && away >= relockAfterSec && relockAfterSec >= 0) setLocked(true);
      }
    });
    return () => sub.remove();
  }, []);

  const showLock = security.lockEnabled && locked;
  // A native Modal so the lock also covers full-screen camera/playback modals.
  return (
    <Modal visible={showLock || covered} animationType="none" presentationStyle="overFullScreen" transparent>
      {showLock ? <LockScreen onUnlock={() => setLocked(false)} /> : <Cover />}
    </Modal>
  );
}

function Cover() {
  const p = usePalette();
  return <View style={[StyleSheet.absoluteFill, { backgroundColor: p.bg }]} />;
}

function LockScreen({ onUnlock }: { onUnlock: () => void }) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const { method, biometricsWithPin } = useApp((s) => s.security);
  const [pin, setPin] = useState('');
  const [error, setError] = useState(false);

  const biometric = useCallback(async () => {
    const res = await LocalAuthentication.authenticateAsync({
      promptMessage: 'Unlock your cameras',
      // In PIN mode the fallback is our own keypad, not the device passcode.
      disableDeviceFallback: method === 'pin',
      fallbackLabel: method === 'pin' ? 'Use PIN' : undefined,
    });
    if (res.success) onUnlock();
  }, [method, onUnlock]);

  useEffect(() => {
    if (method === 'device' || biometricsWithPin) void biometric();
  }, [biometric, method, biometricsWithPin]);

  const press = async (d: string) => {
    void Haptics.selectionAsync();
    const next = d === '⌫' ? pin.slice(0, -1) : (pin + d).slice(0, PIN_LENGTH);
    setPin(next);
    setError(false);
    if (next.length === PIN_LENGTH) {
      if (await checkPin(next)) onUnlock();
      else {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        setError(true);
        setPin('');
      }
    }
  };

  return (
    <View style={[StyleSheet.absoluteFill, styles.root, { backgroundColor: p.bg, paddingTop: insets.top + 80 }]}>
      <T v="title">Locked</T>
      {method === 'device' ? (
        <Button title="Unlock" onPress={biometric} style={{ alignSelf: 'stretch', marginTop: space.xl }} />
      ) : (
        <>
          <T muted color={error ? p.danger : undefined}>
            {error ? 'Wrong PIN' : 'Enter your PIN'}
          </T>
          <View style={styles.dots}>
            {Array.from({ length: PIN_LENGTH }, (_, i) => (
              <View key={i} style={[styles.dot, { borderColor: p.text, backgroundColor: i < pin.length ? p.text : 'transparent' }]} />
            ))}
          </View>
          <View style={styles.pad}>
            {['1', '2', '3', '4', '5', '6', '7', '8', '9', biometricsWithPin ? 'FaceID' : '', '0', '⌫'].map((d, i) => (
              <Pressable
                key={i}
                disabled={!d}
                onPress={() => (d === 'FaceID' ? void biometric() : void press(d))}
                style={({ pressed }) => [styles.key, { backgroundColor: d && d !== '⌫' && d !== 'FaceID' ? (pressed ? p.surfaceRaised : p.surface) : 'transparent' }]}>
                <T v={d === 'FaceID' ? 'caption' : 'heading'}>{d === 'FaceID' ? 'Face ID' : d}</T>
              </Pressable>
            ))}
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { alignItems: 'center', gap: space.lg, paddingHorizontal: space.xl, zIndex: 1000 },
  dots: { flexDirection: 'row', gap: 14, marginVertical: space.md },
  dot: { width: 14, height: 14, borderRadius: 7, borderWidth: 1.5 },
  pad: { flexDirection: 'row', flexWrap: 'wrap', width: 270, gap: 15, justifyContent: 'center' },
  key: { width: 76, height: 76, borderRadius: 38, alignItems: 'center', justifyContent: 'center' },
});

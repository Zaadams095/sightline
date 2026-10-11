import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';
import { BackHandler, Platform } from 'react-native';

/**
 * Android's Back button/gesture runs `onBack` instead of simply closing the screen, while the
 * screen is in front. For full-screen screens whose close does more than go back (the wall
 * display's lock, the doorbell call with nothing behind it). No-op on iOS.
 */
export function useAndroidBack(onBack: () => void) {
  const latest = useRef(onBack);
  useEffect(() => {
    latest.current = onBack;
  });
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== 'android') return;
      const sub = BackHandler.addEventListener('hardwareBackPress', () => {
        latest.current();
        return true;
      });
      return () => sub.remove();
    }, []),
  );
}

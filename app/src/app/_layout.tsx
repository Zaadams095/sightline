import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useSyncExternalStore } from 'react';
import { View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { WebView } from 'react-native-webview';

import { watchBridgeSync } from '@/alerts/bridge';
import { handleLaunchNotification, registerBackgroundAlerts, setupNotificationHandling } from '@/alerts/background';
import { startLifecycle } from '@/net/connection';
import { AppLockGate } from '@/security/app-lock';
import { useApp } from '@/state/store';
import { useIsDark, usePalette } from '@/theme/use-palette';

SplashScreen.preventAutoHideAsync();
setupNotificationHandling();

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

function useHydrated() {
  return useSyncExternalStore(useApp.persist.onFinishHydration, useApp.persist.hasHydrated);
}

export default function RootLayout() {
  const hydrated = useHydrated();
  const dark = useIsDark();
  const p = usePalette();

  useEffect(() => {
    if (!hydrated) return;
    void SplashScreen.hideAsync();
    void registerBackgroundAlerts();
    // Give the navigator a moment to mount before routing to a tapped notification's clip.
    const launchTimer = setTimeout(() => void handleLaunchNotification(), 300);
    const stopBridge = watchBridgeSync();
    const stopLifecycle = startLifecycle(() => useApp.getState().systems);
    return () => {
      clearTimeout(launchTimer);
      stopBridge();
      stopLifecycle();
    };
  }, [hydrated]);

  if (!hydrated) return null;

  const base = dark ? DarkTheme : DefaultTheme;
  const navTheme = {
    ...base,
    colors: { ...base.colors, primary: p.accent, background: p.bg, card: p.surface, text: p.text, border: p.border },
  };

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider value={navTheme}>
          <StatusBar style={dark ? 'light' : 'dark'} />
          <Stack screenOptions={{ headerShadowVisible: false, headerLargeTitleShadowVisible: false }}>
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen name="onboarding" options={{ headerShown: false, gestureEnabled: false }} />
            <Stack.Screen name="camera/[key]" options={{ headerShown: false, presentation: 'fullScreenModal' }} />
            <Stack.Screen name="playback" options={{ headerShown: false, presentation: 'fullScreenModal' }} />
            <Stack.Screen name="clip" options={{ headerShown: false, presentation: 'fullScreenModal' }} />
            <Stack.Screen name="settings/appearance" options={{ title: 'Appearance' }} />
            <Stack.Screen name="settings/alerts" options={{ title: 'Notifications' }} />
            <Stack.Screen name="settings/vpn" options={{ title: 'VPN' }} />
            <Stack.Screen name="settings/systems" options={{ title: 'Camera systems' }} />
            <Stack.Screen name="settings/cameras" options={{ title: 'Cameras & order' }} />
            <Stack.Screen name="settings/grid" options={{ title: 'Grid layouts' }} />
            <Stack.Screen name="settings/bridge" options={{ title: 'Instant Alerts' }} />
            <Stack.Screen name="settings/masks" options={{ title: 'Alert masks' }} />
            <Stack.Screen name="settings/diagnostics" options={{ title: 'Diagnostics' }} />
            <Stack.Screen name="settings/security" options={{ title: 'Privacy & lock' }} />
          </Stack>
          <AppLockGate />
          {/* Starts WebKit's web process at launch so the first live view doesn't pay for it. */}
          <View style={{ position: 'absolute', width: 1, height: 1, opacity: 0 }} pointerEvents="none">
            <WebView source={{ html: '<html><body></body></html>' }} />
          </View>
        </ThemeProvider>
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useSyncExternalStore } from 'react';
import { View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { WebView } from 'react-native-webview';

import { watchBridgeSync } from '@/alerts/bridge';
import { startCloudBackup } from '@/backup/icloud';
import { handleLaunchNotification, registerBackgroundAlerts, setupNotificationHandling } from '@/alerts/background';
import { startDoorbellWatch } from '@/alerts/doorbell';
import { installCrashHandlers } from '@/diagnostics/log';
import { startLiveActivities } from '@/alerts/live-activity';
import { startLifecycle } from '@/net/connection';
import { resumeHomeAway } from '@/presence/geofence';
import { AppLockGate } from '@/security/app-lock';
import { useApp } from '@/state/store';
import { watchStreamCredentials } from '@/systems/stream-credentials';
import { useIsDark, usePalette } from '@/theme/use-palette';
import { startWatchSync } from '@/watch/sync';

SplashScreen.preventAutoHideAsync();
setupNotificationHandling();
installCrashHandlers();

/** "Something went wrong — Try again / Send report" instead of a crashed screen. */
export { ErrorScreen as ErrorBoundary } from '@/diagnostics/error-screen';

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
    void resumeHomeAway();
    // Give the navigator a moment to mount before routing to a tapped notification's clip.
    const launchTimer = setTimeout(() => void handleLaunchNotification(), 300);
    const stopBridge = watchBridgeSync();
    // Stream-link passwords move to the keychain; settings back up to iCloud when they change.
    const stopStreamCreds = watchStreamCredentials();
    const stopBackup = startCloudBackup();
    // After a foreground or network change, re-resolve live streams onto the new route.
    const stopLifecycle = startLifecycle(
      () => useApp.getState().systems,
      () => void queryClient.invalidateQueries({ queryKey: ['live'] }),
    );
    const stopDoorbell = startDoorbellWatch();
    const stopLive = startLiveActivities();
    const stopWatch = startWatchSync();
    return () => {
      clearTimeout(launchTimer);
      stopBridge();
      stopStreamCreds();
      stopBackup();
      stopLifecycle();
      stopDoorbell();
      stopLive();
      stopWatch();
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
            <Stack.Screen name="doorbell" options={{ headerShown: false, presentation: 'fullScreenModal', gestureEnabled: false }} />
            <Stack.Screen name="timelapse" options={{ headerShown: false, presentation: 'fullScreenModal' }} />
            <Stack.Screen name="story" options={{ headerShown: false, presentation: 'fullScreenModal' }} />
            <Stack.Screen name="people" options={{ title: 'People & vehicles' }} />
            <Stack.Screen name="person" options={{ title: '' }} />
            <Stack.Screen name="settings/appearance" options={{ title: 'Appearance' }} />
            <Stack.Screen name="settings/alerts" options={{ title: 'Alerts' }} />
            <Stack.Screen name="settings/vpn" options={{ title: 'Away from home' }} />
            <Stack.Screen name="settings/systems" options={{ title: 'Recorder or camera' }} />
            <Stack.Screen name="settings/cameras" options={{ title: 'Cameras & order' }} />
            <Stack.Screen name="settings/grid" options={{ title: 'Grid layouts' }} />
            <Stack.Screen name="settings/groups" options={{ title: 'Camera groups' }} />
            <Stack.Screen name="settings/bridge" options={{ title: 'Instant Alerts' }} />
            <Stack.Screen name="settings/zones" options={{ title: 'Alert zones', presentation: 'fullScreenModal' }} />
            <Stack.Screen name="settings/diagnostics" options={{ title: 'Connection check' }} />
            <Stack.Screen name="settings/home-away" options={{ title: 'Home & Away' }} />
            <Stack.Screen name="settings/security" options={{ title: 'Privacy & lock' }} />
            <Stack.Screen name="settings/sharing" options={{ title: 'Sharing' }} />
            <Stack.Screen name="settings/backup" options={{ title: 'Backup & new phone' }} />
            {/* Deep links sightline://invite?… and sightline://hub?… redirect to the join screen. */}
            <Stack.Screen name="invite" options={{ headerShown: false }} />
            <Stack.Screen name="hub" options={{ headerShown: false }} />
            {/* sightline://tv?… (the QR code on the Apple TV app) connects the TV to a Hub. */}
            <Stack.Screen name="tv" options={{ title: 'Connect Apple TV' }} />
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

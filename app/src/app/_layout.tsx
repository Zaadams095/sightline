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
import { watchCheckinCategories } from '@/alerts/checkins-run';
import { startDoorbellWatch } from '@/alerts/doorbell';
import { installCrashHandlers } from '@/diagnostics/log';
// Picks the app's language (Settings → Appearance, else the iPhone's) before anything shows text.
import '@/i18n/device';
import { useT } from '@/i18n/use-t';
import { BrandIntro } from '@/components/brand-intro';
import { DialogHost } from '@/components/ui/action-sheet';
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
  const t = useT();

  useEffect(() => {
    if (!hydrated) return;
    // The native splash is hidden by BrandIntro, once its identical first frame is on screen.
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
    // "Watch Kitchen" / "Call Mom" / "Mom's fine" buttons for each family check-in.
    const stopCheckins = watchCheckinCategories();
    return () => {
      stopCheckins();
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
          <Stack screenOptions={{ headerShadowVisible: false, headerLargeTitleShadowVisible: false, headerBackButtonDisplayMode: 'minimal' }}>
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen name="onboarding" options={{ headerShown: false, gestureEnabled: false }} />
            <Stack.Screen name="camera/[key]" options={{ headerShown: false, presentation: 'fullScreenModal' }} />
            <Stack.Screen name="playback" options={{ headerShown: false, presentation: 'fullScreenModal' }} />
            <Stack.Screen name="clip" options={{ headerShown: false, presentation: 'fullScreenModal' }} />
            <Stack.Screen name="doorbell" options={{ headerShown: false, presentation: 'fullScreenModal', gestureEnabled: false }} />
            <Stack.Screen name="timelapse" options={{ headerShown: false, presentation: 'fullScreenModal' }} />
            <Stack.Screen name="story" options={{ headerShown: false, presentation: 'fullScreenModal' }} />
            <Stack.Screen name="people" options={{ title: t.home.nav.peopleVehicles }} />
            <Stack.Screen name="person" options={{ title: '' }} />
            <Stack.Screen name="ask" options={{ headerShown: false, presentation: 'modal' }} />
            <Stack.Screen name="settings/appearance" options={{ title: t.common.appearance.title }} />
            <Stack.Screen name="settings/alerts" options={{ title: t.home.nav.alerts }} />
            <Stack.Screen name="settings/vpn" options={{ title: t.home.nav.awayFromHome }} />
            <Stack.Screen name="settings/systems" options={{ title: t.home.nav.recorderOrCamera }} />
            <Stack.Screen name="settings/cameras" options={{ title: t.home.nav.camerasOrder }} />
            <Stack.Screen name="settings/grid" options={{ title: t.home.nav.gridLayouts }} />
            <Stack.Screen name="settings/groups" options={{ title: t.home.nav.cameraGroups }} />
            <Stack.Screen name="settings/bridge" options={{ title: t.home.nav.instantAlerts }} />
            <Stack.Screen name="settings/zones" options={{ title: t.home.nav.alertZones, presentation: 'fullScreenModal' }} />
            <Stack.Screen name="settings/diagnostics" options={{ title: t.home.nav.connectionCheck }} />
            <Stack.Screen name="settings/home-away" options={{ title: t.home.nav.homeAway }} />
            <Stack.Screen name="settings/security" options={{ title: t.home.nav.privacyLock }} />
            <Stack.Screen name="settings/sharing" options={{ title: t.home.nav.sharing }} />
            <Stack.Screen name="settings/backup" options={{ title: t.home.nav.backup }} />
            <Stack.Screen name="settings/learned" options={{ title: t.home.nav.learned }} />
            <Stack.Screen name="settings/checkins" options={{ title: t.home.nav.checkins }} />
            <Stack.Screen name="settings/checkin" options={{ title: t.home.nav.checkin }} />
            <Stack.Screen name="settings/wall" options={{ title: t.home.nav.wallDisplay }} />
            <Stack.Screen name="wall" options={{ headerShown: false, presentation: 'fullScreenModal', gestureEnabled: false, animation: 'fade' }} />
            <Stack.Screen name="export" options={{ title: t.home.nav.export, presentation: 'modal' }} />
            <Stack.Screen name="share-neighbors" options={{ title: t.home.nav.shareNeighbors, presentation: 'modal' }} />
            {/* Deep links sightline://invite?… and sightline://hub?… redirect to the join screen. */}
            <Stack.Screen name="invite" options={{ headerShown: false }} />
            <Stack.Screen name="hub" options={{ headerShown: false }} />
            {/* sightline://tv?… (the QR code on the Apple TV app) connects the TV to a Hub. */}
            <Stack.Screen name="tv" options={{ title: t.home.nav.connectTv }} />
          </Stack>
          {/* Android's action sheets and text prompts (iOS uses its own). */}
          <DialogHost />
          <BrandIntro ready={hydrated} />
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

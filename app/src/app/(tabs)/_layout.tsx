import { Redirect } from 'expo-router';
import { NativeTabs } from 'expo-router/unstable-native-tabs';

import { useT } from '@/i18n/use-t';
import { useApp } from '@/state/store';
import { usePalette } from '@/theme/use-palette';

export default function TabsLayout() {
  const onboarded = useApp((s) => s.onboarded);
  const p = usePalette();
  const t = useT();
  if (!onboarded) return <Redirect href="/onboarding" />;

  return (
    <NativeTabs tintColor={p.accent} minimizeBehavior="onScrollDown">
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Label>{t.home.tabs.live}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: 'video', selected: 'video.fill' }} md="videocam" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="review">
        <NativeTabs.Trigger.Label>{t.home.tabs.recordings}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: 'clock.arrow.circlepath', selected: 'clock.arrow.circlepath' }} md="history" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="map">
        <NativeTabs.Trigger.Label>{t.home.tabs.map}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: 'map', selected: 'map.fill' }} md="map" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="settings">
        <NativeTabs.Trigger.Label>{t.home.tabs.settings}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: 'gearshape', selected: 'gearshape.fill' }} md="settings" />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}

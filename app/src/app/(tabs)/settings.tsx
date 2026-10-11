import { router } from 'expo-router';
import { Platform, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { confirmRemoveDemo, offerSampleAlert } from '@/components/demo-banner';
import { Row, Screen, Section, StatusDot, T } from '@/components/ui/primitives';
import { useLinks } from '@/net/connection';
import { useApp } from '@/state/store';
import { startDemo, useDemoActive } from '@/systems/demo/session';
import { canShare, isGuest } from '@/systems/hub';
import { sharedByText } from '@/systems/hub-links';
import type { SystemConfig } from '@/systems/types';
import { space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';

/** "Shared by Home · ends Oct 12" for systems someone shared with this phone. */
function sharedDetail(s: SystemConfig): string | undefined {
  if (s.kind !== 'hub' || !s.extra?.role || s.extra.role === 'owner') return undefined;
  return sharedByText(s.extra.hubName || s.name, s.extra.expiresAt ? Number(s.extra.expiresAt) : null);
}

export default function SettingsScreen() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const systems = useApp((s) => s.systems);
  const alerts = useApp((s) => s.alerts);
  const links = useLinks((s) => s.links);
  const tunnelUp = useLinks((s) => s.tunnelUp);
  const { width } = useWindowDimensions();
  // Custom grid layouts only matter on a big screen (same rule as the Live tab).
  const tablet = (Platform.OS === 'ios' && Platform.isPad) || width >= 700;
  const hasHub = systems.some((s) => s.kind === 'hub');
  const hubRemote = systems.some((s) => s.kind === 'hub' && !!s.extra?.remoteUrl);
  // Someone who only has shared cameras doesn't need away-from-home or Hub setup.
  const guestOnly = systems.length > 0 && systems.every(isGuest);
  const sharable = systems.some(canShare);
  const shared = systems.find((s) => sharedDetail(s));
  const demoActive = useDemoActive();

  return (
    <Screen style={{ paddingTop: insets.top + space.sm }}>
      <T v="title">Settings</T>

      <Section title="Systems">
        {systems.map((s) => {
          const mode = links[s.id]?.mode ?? 'connecting';
          const color = { lan: p.success, tunnel: p.accent, connecting: p.warning, offline: p.danger }[mode];
          return (
            <Row
              key={s.id}
              label={s.name}
              detail={s.kind === 'demo' ? 'Built-in sample video, not a real camera' : (links[s.id]?.error ?? sharedDetail(s) ?? s.endpoint.lanUrl)}
              icon={<StatusDot color={color} />}
              onPress={() => router.push({ pathname: '/settings/systems', params: { id: s.id } })}
            />
          );
        })}
        <Row label="Add a recorder or camera" onPress={() => router.push('/onboarding')} last />
      </Section>

      <Section title="Sample cameras">
        {demoActive ? (
          <>
            <Row label="Send a sample alert" detail="See what an alert looks like on this iPhone" onPress={offerSampleAlert} />
            <Row label="Remove sample cameras" destructive onPress={confirmRemoveDemo} last />
          </>
        ) : (
          <Row
            label="Add sample cameras"
            detail="Explore every feature with built-in sample video"
            onPress={() => void startDemo().then(() => router.navigate('/'))}
            last
          />
        )}
      </Section>

      <Section title="Sharing">
        <Row
          label={sharable || !shared ? 'Share access' : 'Shared with you'}
          detail={
            sharable
              ? 'Family, friends or a sitter: you pick the cameras and how long'
              : shared
                ? sharedDetail(shared)
                : 'Needs a Sightline Hub'
          }
          onPress={() => router.push('/settings/sharing')}
          last
        />
      </Section>

      {!guestOnly && (
        <Section title="Connection">
          <Row
            label="Away from home"
            detail={hubRemote ? 'On, through your Sightline Hub' : tunnelUp ? 'Connected' : 'Watch your cameras from anywhere'}
            onPress={() => router.push('/settings/vpn')}
          />
          <Row label="Connection check" detail="Find out why a recorder or camera won’t connect" onPress={() => router.push('/settings/diagnostics')} last />
        </Section>
      )}

      <Section title="Alerts">
        <Row
          label="Alert settings"
          detail={alerts.mode === 'instant' ? 'Instant Alerts' : 'Built-in (may arrive a few minutes late)'}
          onPress={() => router.push('/settings/alerts')}
        />
        <Row
          label="Home & Away"
          detail={alerts.presence.enabled ? (alerts.presence.atHome ? 'Home: only selected cameras alert' : 'Away: all cameras alert') : 'Quiet alerts automatically when you’re home'}
          onPress={() => router.push('/settings/home-away')}
          last={guestOnly}
        />
        {!guestOnly && (
          <Row
            label="Instant Alerts"
            detail={hasHub || alerts.bridge ? 'Ready: alerts within a second' : 'Needs a Sightline Hub'}
            onPress={() => router.push('/settings/bridge')}
            last
          />
        )}
      </Section>

      <Section title="Privacy">
        <Row label="App lock" detail="Face ID or a PIN to open the app" onPress={() => router.push('/settings/security')} last />
      </Section>

      <Section title="Look & layout">
        <Row label="Appearance" detail="Theme, accent color, tile style" onPress={() => router.push('/settings/appearance')} />
        <Row label="Cameras & order" detail="Reorder or hide cameras" onPress={() => router.push('/settings/cameras')} />
        <Row label="Camera groups" detail="Front Yard, Back Yard, Indoors…" onPress={() => router.push('/settings/groups')} last={!tablet} />
        {tablet && <Row label="Grid layouts" detail="Custom multi-size camera walls" onPress={() => router.push('/settings/grid')} last />}
      </Section>

      <View style={{ alignItems: 'center', paddingTop: space.md }}>
        <T v="caption" muted>
          Everything stays on your network. No accounts, no cloud.
        </T>
      </View>
    </Screen>
  );
}

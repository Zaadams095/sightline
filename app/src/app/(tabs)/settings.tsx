import { router } from 'expo-router';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Row, Screen, Section, StatusDot, T } from '@/components/ui/primitives';
import { useLinks } from '@/net/connection';
import { useApp } from '@/state/store';
import { space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';

export default function SettingsScreen() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const systems = useApp((s) => s.systems);
  const alerts = useApp((s) => s.alerts);
  const links = useLinks((s) => s.links);
  const tunnelUp = useLinks((s) => s.tunnelUp);

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
              detail={links[s.id]?.error ?? s.endpoint.lanUrl}
              icon={<StatusDot color={color} />}
              onPress={() => router.push({ pathname: '/settings/systems', params: { id: s.id } })}
            />
          );
        })}
        <Row label="Add a system" onPress={() => router.push('/onboarding')} last />
      </Section>

      <Section title="Connection">
        <Row label="VPN" detail={tunnelUp ? 'Connected' : 'Connects automatically when away'} onPress={() => router.push('/settings/vpn')} />
        <Row label="Diagnostics" detail="Test the connection step by step" onPress={() => router.push('/settings/diagnostics')} last />
      </Section>

      <Section title="Alerts">
        <Row
          label="Notifications"
          detail={alerts.mode === 'instant' ? 'Instant Alerts' : 'Built-in (background checks)'}
          onPress={() => router.push('/settings/alerts')}
        />
        <Row label="Instant Alerts setup" onPress={() => router.push('/settings/bridge')} last />
      </Section>

      <Section title="Privacy">
        <Row label="App lock" detail="Face ID or a PIN to open the app" onPress={() => router.push('/settings/security')} last />
      </Section>

      <Section title="Look & layout">
        <Row label="Appearance" detail="Theme, accent color, tile style" onPress={() => router.push('/settings/appearance')} />
        <Row label="Cameras & order" detail="Reorder or hide cameras" onPress={() => router.push('/settings/cameras')} />
        <Row label="iPad grid layouts" detail="Custom multi-size camera walls" onPress={() => router.push('/settings/grid')} last />
      </Section>

      <View style={{ alignItems: 'center', paddingTop: space.md }}>
        <T v="caption" muted>
          Everything stays on your network. No accounts, no cloud.
        </T>
      </View>
    </Screen>
  );
}

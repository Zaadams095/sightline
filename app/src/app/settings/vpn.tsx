import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useState } from 'react';
import { Alert } from 'react-native';

import { Button, Row, Screen, Section, T } from '@/components/ui/primitives';
import { VpnSetup } from '@/components/vpn-setup';
import { connectSystem, hasTunnelConfig, useLinks } from '@/net/connection';
import { secrets } from '@/state/secrets';
import { useApp } from '@/state/store';
import { parseStatus, WgTunnel, type TunnelStatus } from '@modules/wg-tunnel';
import { usePalette } from '@/theme/use-palette';
import { formatRelative } from '@/util/format';

const INSTALL_GUIDE = 'https://github.com/Zaadams095/sightline/blob/main/bridge/README.md';

/**
 * Away from home: a Sightline Hub is the easy way; your own WireGuard VPN is the advanced
 * one (the only place the word "WireGuard" shows up).
 */
export default function AwayFromHome() {
  const systems = useApp((s) => s.systems);
  const hubs = systems.filter((s) => s.kind === 'hub');
  const remoteHubs = hubs.filter((s) => !!s.extra?.remoteUrl);

  return (
    <Screen>
      <T muted>
        At home, Sightline connects to your cameras directly. To watch from anywhere else, it needs a way back in: a Sightline
        Hub (easiest) or your own VPN.
      </T>

      <Section
        title="Sightline Hub"
        footer={
          hubs.length > 0 && remoteHubs.length === 0
            ? 'Turn on remote access on your Hub’s setup page, then reopen Sightline.'
            : hubs.length === 0
              ? 'A small free app for a computer that’s always on at home. No router settings needed.'
              : undefined
        }>
        {hubs.length > 0 ? (
          hubs.map((h, i) => (
            <Row
              key={h.id}
              label={h.extra?.hubName || h.name}
              detail={h.extra?.remoteUrl ? 'Away from home: on' : 'Away from home: off'}
              last={i === hubs.length - 1}
            />
          ))
        ) : (
          <>
            <Row label="Set up a Sightline Hub" onPress={() => void WebBrowser.openBrowserAsync(INSTALL_GUIDE)} />
            <Row label="I have a Hub: connect it" onPress={() => router.push({ pathname: '/onboarding/connect', params: { kind: 'hub' } })} last />
          </>
        )}
      </Section>

      <OwnVpn />
    </Screen>
  );
}

/** Advanced: the user's own WireGuard VPN, started by the app only when it's needed. */
function OwnVpn() {
  const p = usePalette();
  const systems = useApp((s) => s.systems);
  const tunnelUp = useLinks((s) => s.tunnelUp);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState<TunnelStatus | null>(null);

  useEffect(() => {
    void hasTunnelConfig().then(setConfigured);
  }, []);

  useEffect(() => {
    if (!WgTunnel) return;
    const tick = () => setStatus(parseStatus(WgTunnel!.tunnelStatus()));
    tick();
    const id = setInterval(tick, 2000);
    return () => clearInterval(id);
  }, []);

  const reconnect = () => systems.forEach((s) => void connectSystem(s));

  const remove = () =>
    Alert.alert('Remove your VPN?', 'Sightline will no longer reach your cameras through it when you’re away from home.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          await WgTunnel!.stopTunnel();
          await secrets.remove('tunnel', 'wg.conf');
          useLinks.setState({ tunnelUp: false });
          setConfigured(false);
        },
      },
    ]);

  if (!WgTunnel) {
    return (
      <Section title="Advanced: my own VPN">
        <Row label="Not available in preview mode" detail="Your own VPN works in the full app from the App Store or TestFlight." last />
      </Section>
    );
  }

  if (editing) {
    return (
      <>
        <T v="heading">My own VPN (WireGuard)</T>
        <VpnSetup
          onSaved={() => {
            setConfigured(true);
            setEditing(false);
            reconnect();
          }}
        />
        <Button title="Cancel" kind="ghost" onPress={() => setEditing(false)} />
      </>
    );
  }

  if (configured === false) {
    return (
      <Section title="Advanced: my own VPN (WireGuard)" footer="For people whose router already runs a WireGuard VPN.">
        <Row label="Set up my own VPN" onPress={() => setEditing(true)} last />
      </Section>
    );
  }

  return (
    <>
      <Section title="Advanced: my own VPN (WireGuard)" footer="Starts on its own when you’re away from home and stops shortly after you leave the app.">
        <Row label="Status" right={<T color={tunnelUp ? p.success : p.textMuted}>{tunnelUp ? 'Connected' : 'Waiting until you’re away'}</T>} />
        <Row label="Last contact" right={<T muted>{status?.lastHandshake ? formatRelative(status.lastHandshake) : 'Never'}</T>} />
        <Row label="Data used" right={<T muted>{status ? `${mb(status.rx + status.tx)}` : '–'}</T>} last />
      </Section>
      <Button title="Reconnect" kind="secondary" onPress={reconnect} />
      <Button title="Replace VPN settings" kind="secondary" onPress={() => setEditing(true)} />
      <Button title="Remove my VPN" kind="ghost" onPress={remove} />
    </>
  );
}

const mb = (b: number) => `${(b / 1_048_576).toFixed(1)} MB`;

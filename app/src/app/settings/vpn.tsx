import { useEffect, useState } from 'react';

import { Button, Row, Screen, Section, T } from '@/components/ui/primitives';
import { VpnSetup } from '@/components/vpn-setup';
import { connectSystem, hasTunnelConfig, useLinks } from '@/net/connection';
import { secrets } from '@/state/secrets';
import { useApp } from '@/state/store';
import { parseStatus, WgTunnel, type TunnelStatus } from '@modules/wg-tunnel';
import { usePalette } from '@/theme/use-palette';
import { formatRelative } from '@/util/format';

export default function VpnSettings() {
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

  if (!WgTunnel) {
    return (
      <Screen>
        <T muted>The built-in VPN needs the full app build (it isn&apos;t available in Expo Go).</T>
      </Screen>
    );
  }

  if (configured === false || editing) {
    return (
      <Screen>
        <VpnSetup
          onSaved={() => {
            setConfigured(true);
            setEditing(false);
            reconnect();
          }}
        />
      </Screen>
    );
  }

  return (
    <Screen>
      <Section title="Status" footer="The VPN starts on its own when you're away from home and stops shortly after you leave the app.">
        <Row label="State" right={<T color={tunnelUp ? p.success : p.textMuted}>{tunnelUp ? 'Connected' : 'Idle'}</T>} />
        <Row
          label="Last handshake"
          right={<T muted>{status?.lastHandshake ? formatRelative(status.lastHandshake) : 'Never'}</T>}
        />
        <Row label="Data" right={<T muted>{status ? `↓ ${mb(status.rx)}  ↑ ${mb(status.tx)}` : '–'}</T>} last />
      </Section>
      <Button title="Reconnect" kind="secondary" onPress={reconnect} />
      <Button title="Replace configuration" kind="secondary" onPress={() => setEditing(true)} />
      <Button
        title="Remove VPN"
        kind="ghost"
        onPress={async () => {
          await WgTunnel!.stopTunnel();
          await secrets.remove('tunnel', 'wg.conf');
          useLinks.setState({ tunnelUp: false });
          setConfigured(false);
        }}
      />
    </Screen>
  );
}

const mb = (b: number) => `${(b / 1_048_576).toFixed(1)} MB`;

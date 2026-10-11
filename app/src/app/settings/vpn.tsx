import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useState } from 'react';
import { Alert } from 'react-native';

import { Button, Row, Screen, Section, T } from '@/components/ui/primitives';
import { VpnSetup } from '@/components/vpn-setup';
import { fmtNumber, tr } from '@/i18n';
import { useT } from '@/i18n/use-t';
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
  const v = useT().settings.vpn;
  const systems = useApp((s) => s.systems);
  const hubs = systems.filter((s) => s.kind === 'hub');
  const remoteHubs = hubs.filter((s) => !!s.extra?.remoteUrl);

  return (
    <Screen>
      <T muted>{v.intro}</T>

      <Section
        title="Sightline Hub"
        footer={
          hubs.length > 0 && remoteHubs.length === 0
            ? v.turnOnRemote
            : hubs.length === 0
              ? v.hubAbout
              : undefined
        }>
        {hubs.length > 0 ? (
          hubs.map((h, i) => (
            <Row
              key={h.id}
              label={h.extra?.hubName || h.name}
              detail={h.extra?.remoteUrl ? v.awayOn : v.awayOff}
              last={i === hubs.length - 1}
            />
          ))
        ) : (
          <>
            <Row label={v.setUpHub} onPress={() => void WebBrowser.openBrowserAsync(INSTALL_GUIDE)} />
            <Row label={v.connectHub} onPress={() => router.push({ pathname: '/onboarding/connect', params: { kind: 'hub' } })} last />
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
  const t = useT();
  const v = t.settings.vpn;
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
    Alert.alert(v.removeTitle, v.removeBody, [
      { text: t.common.cancel, style: 'cancel' },
      {
        text: t.common.remove,
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
      <Section title={v.advanced}>
        <Row label={v.notInPreview} detail={v.notInPreviewDetail} last />
      </Section>
    );
  }

  if (editing) {
    return (
      <>
        <T v="heading">{v.ownHeading}</T>
        <VpnSetup
          onSaved={() => {
            setConfigured(true);
            setEditing(false);
            reconnect();
          }}
        />
        <Button title={t.common.cancel} kind="ghost" onPress={() => setEditing(false)} />
      </>
    );
  }

  if (configured === false) {
    return (
      <Section title={v.advancedWg} footer={v.forRouter}>
        <Row label={v.setUpOwn} onPress={() => setEditing(true)} last />
      </Section>
    );
  }

  return (
    <>
      <Section title={v.advancedWg} footer={v.startsOnOwn}>
        <Row label={v.status} right={<T color={tunnelUp ? p.success : p.textMuted}>{tunnelUp ? v.connected : v.waiting}</T>} />
        <Row label={v.lastContact} right={<T muted>{status?.lastHandshake ? formatRelative(status.lastHandshake) : v.never}</T>} />
        <Row label={v.dataUsed} right={<T muted>{status ? `${mb(status.rx + status.tx)}` : '–'}</T>} last />
      </Section>
      <Button title={v.reconnect} kind="secondary" onPress={reconnect} />
      <Button title={v.replace} kind="secondary" onPress={() => setEditing(true)} />
      <Button title={v.removeMine} kind="ghost" onPress={remove} />
    </>
  );
}

const mb = (b: number) => tr().settings.vpn.megabytes(fmtNumber(b / 1_048_576, { minimumFractionDigits: 1, maximumFractionDigits: 1 }));

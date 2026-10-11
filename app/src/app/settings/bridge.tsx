import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';

import { bridgeSecret, composeSnippet, sendBridgeTest, syncBridge, syncHubDevices } from '@/alerts/bridge';
import { registerBackgroundAlerts, requestNotificationPermission } from '@/alerts/background';
import { Button, Card, Disclosure, Field, Row, Screen, Section, T } from '@/components/ui/primitives';
import { useApp } from '@/state/store';
import { space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';

const INSTALL_GUIDE = 'https://github.com/Zaadams095/sightline/blob/main/bridge/README.md';

/**
 * Instant Alerts come from a Sightline Hub, which works with every brand. The older
 * stand-alone alerts container stays available under "Technical details".
 */
export default function InstantAlerts() {
  const p = usePalette();
  const systems = useApp((s) => s.systems);
  const hubs = systems.filter((x) => x.kind === 'hub');
  const mode = useApp((s) => s.alerts.mode);
  const setAlerts = useApp((s) => s.setAlerts);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const turnOn = async () => {
    setBusy(true);
    setMsg(null);
    try {
      if (!(await requestNotificationPermission())) throw new Error('Allow notifications for Sightline in the iPhone’s Settings app first.');
      setAlerts({ mode: 'instant' });
      await registerBackgroundAlerts();
      await syncHubDevices();
      setMsg({ ok: true, text: 'Instant Alerts are on.' });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      {hubs.length > 0 ? (
        <>
          <T v="heading">{mode === 'instant' ? 'Instant Alerts are on' : 'Ready to turn on'}</T>
          <T muted>
            {hubs.length === 1 ? (hubs[0].extra?.hubName || hubs[0].name) : 'Your Sightline Hubs'} watch your cameras and send a
            short notification (for example, “Person · Front Door”) within a second. Pictures and video stay at home; the app
            loads them when you tap the notification.
          </T>
          {mode !== 'instant' && <Button title="Turn on Instant Alerts" onPress={turnOn} loading={busy} />}
          {msg && <T color={msg.ok ? p.success : p.danger}>{msg.text}</T>}
          <Button title="Choose what alerts me" kind="secondary" onPress={() => router.push('/settings/alerts')} />
        </>
      ) : (
        <>
          <T v="heading">Instant Alerts need a Sightline Hub</T>
          <T muted>
            A Sightline Hub is a small free app for a computer that’s always on at home. It works with any camera brand
            and sends alerts within a second. It also lets you watch away from home and share cameras with family.
          </T>
          <Section title="Where to install it">
            <Row label="Home Assistant" detail="Add the Sightline Hub add-on. The easiest option." />
            <Row label="Synology, Unraid or another NAS" detail="Add the Sightline Hub app (container)." />
            <Row label="An always-on computer" detail="Windows, Mac or Linux." last />
          </Section>
          <Button title="Set up a Sightline Hub" kind="secondary" onPress={() => void WebBrowser.openBrowserAsync(INSTALL_GUIDE)} />
          <Button title="I have a Hub: connect it" onPress={() => router.push({ pathname: '/onboarding/connect', params: { kind: 'hub' } })} />
        </>
      )}

      <View style={{ height: space.sm }} />
      <Disclosure title="Technical details">
        <LegacyBridge />
      </Disclosure>
    </Screen>
  );
}

/** The older Frigate-only alerts container, set up with docker compose. */
function LegacyBridge() {
  const p = usePalette();
  const bridge = useApp((s) => s.alerts.bridge);
  const frigateHost = useApp((s) => s.systems.find((x) => x.kind === 'frigate')?.endpoint.lanUrl);
  const setAlerts = useApp((s) => s.setAlerts);
  const [snippet, setSnippet] = useState('');
  const [url, setUrl] = useState(bridge?.url ?? defaultBridgeUrl(frigateHost));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void bridgeSecret().then((s) => setSnippet(composeSnippet(s)));
  }, []);

  const pair = async () => {
    setBusy(true);
    setMsg(null);
    try {
      if (!(await requestNotificationPermission())) throw new Error('Allow notifications for this app in iOS Settings first.');
      setAlerts({ mode: 'instant', bridge: { url: url.trim().replace(/\/$/, ''), pairedAt: Date.now() } });
      await syncBridge();
      await sendBridgeTest();
      setMsg({ ok: true, text: 'Paired! A test notification is on its way.' });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ gap: space.md }}>
      <T v="caption" muted>
        For Frigate users who run the older stand-alone alerts container instead of a Hub. A Hub does the same and more, so
        most people don’t need this.
      </T>
      <T v="label">1. Add to your docker-compose.yml</T>
      <Card style={{ padding: space.md }}>
        <Text selectable style={{ fontFamily: 'Menlo', fontSize: 12, color: p.text }}>
          {snippet}
        </Text>
      </Card>
      <Button
        title={copied ? 'Copied' : 'Copy snippet'}
        kind="secondary"
        onPress={async () => {
          await Clipboard.setStringAsync(snippet);
          setCopied(true);
        }}
      />
      <T v="caption" muted>
        Put it under services:, set MQTT_URL to the broker in your Frigate config, then run docker compose up -d.
      </T>

      <T v="label">2. Pair this phone</T>
      <Field label="Container address" value={url} onChangeText={setUrl} keyboardType="url" placeholder="http://192.168.1.10:8086" />
      {msg && <T color={msg.ok ? p.success : p.danger}>{msg.text}</T>}
      <Button title={bridge ? 'Re-pair & send test' : 'Pair & send test'} onPress={pair} loading={busy} disabled={!url.trim()} />
    </View>
  );
}

function defaultBridgeUrl(frigateUrl?: string): string {
  if (!frigateUrl) return '';
  try {
    return `http://${new URL(frigateUrl).hostname}:8086`;
  } catch {
    return '';
  }
}

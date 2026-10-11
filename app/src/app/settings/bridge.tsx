import * as Clipboard from 'expo-clipboard';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';

import { bridgeSecret, composeSnippet, sendBridgeTest, syncBridge } from '@/alerts/bridge';
import { requestNotificationPermission } from '@/alerts/background';
import { Button, Card, Field, Screen, T } from '@/components/ui/primitives';
import { useApp } from '@/state/store';
import { space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';

export default function BridgeSetup() {
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
    <Screen>
      <T muted>
        Instant Alerts deliver notifications within a second. A small container next to Frigate watches for events and
        sends a short text notification (for example, &quot;Person · Front Door&quot;) through Apple. Snapshots and video never
        leave your network; the app loads them when you tap the notification.
      </T>

      <T v="heading">1. Add to your docker-compose.yml</T>
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

      <T v="heading">2. Pair this phone</T>
      <Field label="Bridge address" value={url} onChangeText={setUrl} keyboardType="url" placeholder="http://192.168.1.10:8086" />
      {msg && <T color={msg.ok ? p.success : p.danger}>{msg.text}</T>}
      <Button title={bridge ? 'Re-pair & send test' : 'Pair & send test'} onPress={pair} loading={busy} disabled={!url.trim()} />
      <View style={{ height: space.md }} />
    </Screen>
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

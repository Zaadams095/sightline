import * as Clipboard from 'expo-clipboard';
import { router, Stack } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';

import { bridgeSecret, composeSnippet, sendBridgeTest, syncBridge, syncHubDevices } from '@/alerts/bridge';
import { registerBackgroundAlerts, requestNotificationPermission } from '@/alerts/background';
import { Button, Card, Disclosure, Field, Row, Screen, Section, T } from '@/components/ui/primitives';
import { useT } from '@/i18n/use-t';
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
  const t = useT();
  const b = t.alertSettings.bridge;
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
      if (!(await requestNotificationPermission())) throw new Error(b.allowNotifications);
      setAlerts({ mode: 'instant' });
      await registerBackgroundAlerts();
      await syncHubDevices();
      setMsg({ ok: true, text: b.turnedOn });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Stack.Screen options={{ title: b.title }} />
      {hubs.length > 0 ? (
        <>
          <T v="heading">{mode === 'instant' ? b.onHeading : b.ready}</T>
          <T muted>{hubs.length === 1 ? b.explainOne(hubs[0].extra?.hubName || hubs[0].name) : b.explainMany}</T>
          {mode !== 'instant' && <Button title={b.turnOn} onPress={turnOn} loading={busy} />}
          {msg && <T color={msg.ok ? p.success : p.danger}>{msg.text}</T>}
          <Button title={b.chooseWhat} kind="secondary" onPress={() => router.push('/settings/alerts')} />
        </>
      ) : (
        <>
          <T v="heading">{b.needHub}</T>
          <T muted>{b.hubExplain}</T>
          <Section title={b.whereInstall}>
            <Row label="Home Assistant" detail={b.homeAssistantDetail} />
            <Row label={b.nas} detail={b.nasDetail} />
            <Row label={b.computer} detail={b.computerDetail} last />
          </Section>
          <Button title={b.setUpHub} kind="secondary" onPress={() => void WebBrowser.openBrowserAsync(INSTALL_GUIDE)} />
          <Button title={b.haveHub} onPress={() => router.push({ pathname: '/onboarding/connect', params: { kind: 'hub' } })} />
        </>
      )}

      <View style={{ height: space.sm }} />
      <Disclosure title={b.technical}>
        <LegacyBridge />
      </Disclosure>
    </Screen>
  );
}

/** The older Frigate-only alerts container, set up with docker compose. */
function LegacyBridge() {
  const p = usePalette();
  const t = useT();
  const b = t.alertSettings.bridge;
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
      if (!(await requestNotificationPermission())) throw new Error(b.allowNotificationsLegacy);
      setAlerts({ mode: 'instant', bridge: { url: url.trim().replace(/\/$/, ''), pairedAt: Date.now() } });
      await syncBridge();
      await sendBridgeTest();
      setMsg({ ok: true, text: b.paired });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ gap: space.md }}>
      <T v="caption" muted>
        {b.legacyIntro}
      </T>
      <T v="label">{b.step1}</T>
      <Card style={{ padding: space.md }}>
        <Text selectable maxFontSizeMultiplier={2} style={{ fontFamily: 'Menlo', fontSize: 12, color: p.text }}>
          {snippet}
        </Text>
      </Card>
      <Button
        title={copied ? b.copied : b.copy}
        kind="secondary"
        onPress={async () => {
          await Clipboard.setStringAsync(snippet);
          setCopied(true);
        }}
      />
      <T v="caption" muted>
        {b.step1Help}
      </T>

      <T v="label">{b.step2}</T>
      <Field label={b.address} value={url} onChangeText={setUrl} keyboardType="url" placeholder="http://192.168.1.10:8086" />
      {msg && <T color={msg.ok ? p.success : p.danger}>{msg.text}</T>}
      <Button title={bridge ? b.repair : b.pair} onPress={pair} loading={busy} disabled={!url.trim()} />
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

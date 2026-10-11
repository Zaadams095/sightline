import * as Clipboard from 'expo-clipboard';
import Constants from 'expo-constants';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Button, Card, Field, Screen, T } from '@/components/ui/primitives';
import { hasTunnelConfig, useLinks } from '@/net/connection';
import { describeStartup, useLiveStats } from '@/state/live-stats';
import { useApp } from '@/state/store';
import { space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';
import { fetchWithTimeout } from '@/util/fetch';
import { normalizeUrl } from '@/util/url';
import { parseStatus, WgTunnel } from '@modules/wg-tunnel';

interface Step {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * Step-by-step connection test. Separates "the phone can't reach it" from "the app's
 * networking can't reach it" from "the login/gateway fails", with the real error text.
 */
export default function Diagnostics() {
  const p = usePalette();
  const firstSystem = useApp((s) => s.systems.find((x) => x.kind === 'frigate'));
  const links = useLinks((s) => s.links);
  const [address, setAddress] = useState(firstSystem?.endpoint.lanUrl ?? '');
  const [steps, setSteps] = useState<Step[]>([]);
  const [running, setRunning] = useState(false);
  const lastLive = useLiveStats((s) => s.last);

  const run = async () => {
    setRunning(true);
    setSteps([]);
    const out: Step[] = [];
    const push = (s: Step) => {
      out.push(s);
      setSteps([...out]);
    };

    const url = normalizeUrl(address);
    const u = new URL(url);
    const hostport = `${u.hostname}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`;
    push({ name: 'Address', ok: true, detail: `${url}  (${hostport})` });

    if (!WgTunnel) {
      push({ name: 'Native networking', ok: false, detail: 'Not available in this build (Expo Go?)' });
    } else {
      const tcp = await WgTunnel.probeError(hostport, false, 3000);
      push({ name: 'App → TCP connect (direct)', ok: !tcp, detail: tcp || 'Connected' });

      const http = await WgTunnel.httpCheck(`${url}/api/version`, false, 5000);
      push({ name: 'App → HTTP GET /api/version (direct)', ok: http.startsWith('HTTP'), detail: http });
    }

    // iOS's own networking (same stack Safari uses). A certificate error still proves reachability.
    try {
      const res = await fetchWithTimeout(`${url}/api/version`, {}, 5000);
      push({ name: 'iOS networking → GET /api/version', ok: true, detail: `HTTP ${res.status}` });
    } catch (e) {
      push({ name: 'iOS networking → GET /api/version', ok: false, detail: e instanceof Error ? e.message : String(e) });
    }

    if (firstSystem) {
      const link = links[firstSystem.id];
      push({
        name: `Saved system "${firstSystem.name}"`,
        ok: link?.mode === 'lan' || link?.mode === 'tunnel',
        detail: `${link?.mode ?? 'not connected'}${link?.error ? ` · ${link.error}` : ''}`,
      });
      if (link?.baseUrl) {
        try {
          const res = await fetchWithTimeout(`${link.baseUrl}/api/version`, {}, 6000);
          push({ name: 'Gateway → /api/version (with login)', ok: res.ok, detail: `HTTP ${res.status} ${res.ok ? await res.text() : ''}` });
        } catch (e) {
          push({ name: 'Gateway → /api/version (with login)', ok: false, detail: e instanceof Error ? e.message : String(e) });
        }
      }
    }

    if (WgTunnel) {
      const configured = await hasTunnelConfig();
      const st = parseStatus(WgTunnel.tunnelStatus());
      push({
        name: 'VPN',
        ok: true,
        detail: configured ? `configured · ${st.running ? `running, last handshake ${st.lastHandshake || 'never'}` : 'idle'}` : 'not configured',
      });
      if (configured && st.running) {
        const viaTunnel = await WgTunnel.probeError(hostport, true, 5000);
        push({ name: 'App → TCP connect (via VPN)', ok: !viaTunnel, detail: viaTunnel || 'Connected' });
      }
    }

    push({
      name: 'Build',
      ok: true,
      detail: `v${Constants.expoConfig?.version} · ${Constants.expoConfig?.ios?.buildNumber ?? ''}`,
    });
    setRunning(false);
  };

  const report = [
    ...steps.map((s) => `${s.ok ? 'OK ' : 'ERR'} ${s.name}: ${s.detail}`),
    ...(lastLive ? ['', 'Last live view startup:', describeStartup(lastLive)] : []),
  ].join('\n');

  return (
    <Screen>
      <T muted>Tests each step of reaching your recorder and shows the exact error. Copy the results to share them.</T>
      <Field label="Address" value={address} onChangeText={setAddress} placeholder="10.0.0.130:8971" keyboardType="url" />
      <Button title={running ? 'Testing…' : 'Run tests'} onPress={run} loading={running} disabled={!address.trim()} />

      {steps.length > 0 && (
        <Card style={{ padding: space.md, gap: space.sm }}>
          {steps.map((s, i) => (
            <View key={i} style={styles.step}>
              <Text style={[styles.badge, { color: s.ok ? p.success : p.danger }]}>{s.ok ? '✓' : '✕'}</Text>
              <View style={{ flex: 1 }}>
                <T v="label">{s.name}</T>
                <Text selectable style={[styles.detail, { color: p.textMuted }]}>
                  {s.detail}
                </Text>
              </View>
            </View>
          ))}
        </Card>
      )}
      {lastLive && (
        <Card style={{ padding: space.md, gap: space.xs }}>
          <T v="label">Last live view startup</T>
          <Text selectable style={[styles.detail, { color: p.textMuted }]}>
            {describeStartup(lastLive)}
          </Text>
        </Card>
      )}
      {(steps.length > 0 || lastLive) && !running && (
        <Button title="Copy results" kind="secondary" onPress={() => Clipboard.setStringAsync(report)} />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  step: { flexDirection: 'row', gap: space.sm },
  badge: { fontSize: 16, fontWeight: '700', width: 18 },
  detail: { fontFamily: 'Menlo', fontSize: 12 },
});

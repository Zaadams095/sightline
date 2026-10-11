import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, Card, Field, Screen, T, ToggleRow } from '@/components/ui/primitives';
import { connectSystem, disconnectSystem } from '@/net/connection';
import { secrets, SECRET } from '@/state/secrets';
import { useApp } from '@/state/store';
import { dropAdapter, getAdapter } from '@/systems/registry';
import type { SystemConfig } from '@/systems/types';
import { WgTunnel } from '@modules/wg-tunnel';
import { space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';
import { isExpoGo } from '@/util/runtime';
import { normalizeUrl } from '@/util/url';

export default function FrigateSetup() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const upsert = useApp((s) => s.upsertSystem);
  const [name, setName] = useState('Home');
  const [url, setUrl] = useState('');
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [useTunnel, setUseTunnel] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const test = async () => {
    setBusy(true);
    setResult(null);
    const id = `frigate-${Date.now().toString(36)}`;
    const system: SystemConfig = {
      id,
      kind: 'frigate',
      name: name.trim() || 'Frigate',
      endpoint: { lanUrl: normalizeUrl(url), useTunnel, allowSelfSigned: true },
      username: user.trim() || undefined,
    };
    try {
      await secrets.set(id, SECRET.password, pass);
      const link = await connectSystem(system);
      if (link.mode === 'offline') {
        throw new Error(
          useTunnel
            ? `${link.error ?? 'Could not reach Frigate'}. If you're away from home, set up the VPN on the next step and test again from Settings.`
            : (link.error ?? 'Could not reach Frigate'),
        );
      }
      if (link.port != null && user && WgTunnel) {
        const err = await WgTunnel.login(link.port);
        if (err) throw new Error(err);
      }
      const adapter = getAdapter(system, link)!;
      await adapter.connect();
      const cams = await adapter.listCameras();
      upsert(system);
      setResult({ ok: true, msg: `Connected. Found ${cams.length} camera${cams.length === 1 ? '' : 's'}.` });
    } catch (e) {
      disconnectSystem(id);
      dropAdapter(id);
      await secrets.remove(id, SECRET.password);
      setResult({ ok: false, msg: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen style={{ paddingTop: insets.top + 56 }}>
      <View style={{ gap: space.xs }}>
        <T v="title">Connect Frigate</T>
        <T muted>Use the address you open Frigate at at home. Port 8971 with a login is recommended.</T>
      </View>

      <Field label="Name" value={name} onChangeText={setName} placeholder="Home" autoCapitalize="words" />
      <Field
        label="Frigate address"
        value={url}
        onChangeText={setUrl}
        placeholder="192.168.1.10:8971"
        keyboardType="url"
        hint={isExpoGo ? 'Preview mode: use http://<ip>:5000 (Expo Go cannot accept self-signed certificates).' : 'Self-signed certificates are accepted.'}
      />
      <Field label="Username" value={user} onChangeText={setUser} placeholder="admin" textContentType="username" />
      <Field label="Password" value={pass} onChangeText={setPass} secureTextEntry textContentType="password" />

      <Card>
        <ToggleRow
          label="Use VPN when away"
          detail="Connects through your WireGuard VPN automatically when you're not on home Wi-Fi."
          value={useTunnel}
          onChange={setUseTunnel}
          last
        />
      </Card>

      {result && <T color={result.ok ? p.success : p.danger}>{result.msg}</T>}

      {result?.ok ? (
        <Button title="Continue" onPress={() => router.push('/onboarding/vpn')} />
      ) : (
        <Button title="Test connection" onPress={test} loading={busy} disabled={!url.trim()} />
      )}
    </Screen>
  );
}

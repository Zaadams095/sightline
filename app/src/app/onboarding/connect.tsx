import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, Card, Field, Screen, T, ToggleRow } from '@/components/ui/primitives';
import { connectSystem, disconnectSystem } from '@/net/connection';
import { secrets, SECRET } from '@/state/secrets';
import { useApp } from '@/state/store';
import { describe } from '@/systems/catalog';
import { resolveAddress } from '@/systems/discovery';
import { finishHubJoin, joinAndSaveHub } from '@/systems/hub-join';
import { normalizeHubAddress } from '@/systems/hub-links';
import { dropAdapter, getAdapter } from '@/systems/registry';
import type { SystemConfig, SystemKind } from '@/systems/types';
import { space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';
import { userMessage } from '@/util/errors';
import { WgTunnel } from '@modules/wg-tunnel';

/**
 * One setup screen for every brand, generated from the catalog: address, sign-in, and any
 * brand-specific fields. "Test" resolves ports/scheme, signs in and lists cameras.
 */
export default function ConnectSystem() {
  // Guided setup (onboarding/guide) may pass the brand's name and usual username.
  const params = useLocalSearchParams<{ kind: SystemKind; address?: string; username?: string; name?: string }>();
  const d = describe(params.kind);
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const upsert = useApp((s) => s.upsertSystem);

  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      d.fields.map((f) => [
        f.key,
        f.key === 'address' ? (params.address ?? '') : f.key === 'username' && params.username ? params.username : (f.defaultValue ?? ''),
      ]),
    ),
  );
  // A Hub names itself (its setup page); leave blank to use that name.
  // Everything else starts with its brand name, which the user can change.
  const [name, setName] = useState(d.category === 'hub' ? '' : (params.name ?? d.label));
  const [useTunnel, setUseTunnel] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [unreachable, setUnreachable] = useState<SystemConfig | null>(null);

  const set = (k: string, v: string) => setValues((s) => ({ ...s, [k]: v }));
  const missing = d.fields.some((f) => !f.optional && !values[f.key]?.trim());

  // Sightline Hub: pair with the 6-digit code from its setup page (no VPN, no password).
  const pairHub = async () => {
    setBusy(true);
    setResult(null);
    try {
      const url = normalizeHubAddress(values.address ?? '');
      const r = await joinAndSaveHub({ kind: 'pair', url, code: values.code ?? '' }, name);
      setResult({ ok: true, msg: `Connected to ${r.hubName}. Found ${r.cameras} camera${r.cameras === 1 ? '' : 's'}.` });
    } catch (e) {
      setResult({ ok: false, msg: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    if (d.kind === 'hub') return pairHub();
    setBusy(true);
    setResult(null);
    setUnreachable(null);
    const id = `${d.kind}-${Date.now().toString(36)}`;
    const { address: _a, username, password, ...extra } = values;
    const label = name.trim() || d.label;
    try {
      // Inside the try: a bad address shows as a message instead of leaving the button spinning.
      const lanUrl = await resolveAddress(d, values.address ?? '');
      const system: SystemConfig = {
        id,
        kind: d.kind,
        name: label,
        endpoint: { lanUrl, useTunnel, allowSelfSigned: true },
        username: username?.trim() || undefined,
        extra,
      };
      await secrets.set(id, SECRET.password, password ?? '');
      const link = await connectSystem(system);
      if (link.mode === 'offline') {
        disconnectSystem(id);
        dropAdapter(id);
        setUnreachable(system);
        setResult({ ok: false, msg: `${link.error ?? `Couldn’t reach ${label}.`} (tried ${lanUrl})` });
        return;
      }
      if (d.kind === 'frigate' && link.port != null && username && WgTunnel) {
        const err = await WgTunnel.login(link.port);
        if (err) throw new Error(/401|unauthori[sz]ed|password|credential/i.test(err) ? `${label} didn’t accept the username or password. Check them and try again.` : err);
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
      setResult({ ok: false, msg: userMessage(e, label) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen style={{ paddingTop: insets.top + 56 }}>
      <View style={{ gap: space.xs }}>
        <T v="title">Connect {params.name ?? d.label}</T>
        <T muted>{d.addressHint}</T>
      </View>

      <Field
        label={d.category === 'hub' ? 'Name (optional)' : 'Name'}
        value={name}
        onChangeText={setName}
        placeholder={d.category === 'hub' ? 'Uses the Hub’s name' : d.label}
        autoCapitalize="words"
      />
      {d.fields.map((f) => (
        <Field
          key={f.key}
          label={f.optional ? `${f.label} (if you use one)` : f.label}
          value={values[f.key] ?? ''}
          onChangeText={(v) => set(f.key, v)}
          placeholder={f.placeholder}
          hint={f.hint}
          secureTextEntry={f.secure}
          keyboardType={f.keyboard === 'url' ? 'url' : f.keyboard === 'number-pad' ? 'number-pad' : 'default'}
          textContentType={f.key === 'password' ? 'password' : f.key === 'username' ? 'username' : 'none'}
        />
      ))}

      {d.category !== 'hub' && (
        <Card>
          <ToggleRow
            label="Reach it when I’m away"
            detail="Uses your own VPN, if you set one up (Settings → Away from home). Not needed with a Sightline Hub."
            value={useTunnel}
            onChange={setUseTunnel}
            last
          />
        </Card>
      )}

      {result && <T color={result.ok ? p.success : p.danger}>{result.msg}</T>}

      {unreachable && (
        <>
          <Button
            title="Check the connection step by step"
            kind="ghost"
            onPress={() => router.push({ pathname: '/settings/diagnostics', params: { kind: d.kind, address: unreachable.endpoint.lanUrl } })}
          />
          <Button
            title="Save anyway and set up away-from-home access"
            kind="secondary"
            onPress={() => {
              upsert(unreachable);
              router.push('/onboarding/vpn');
            }}
          />
        </>
      )}

      {d.kind === 'hub' && !result?.ok && (
        <Button title="Scan the Hub’s QR code instead" kind="secondary" onPress={() => router.push('/onboarding/invite')} />
      )}

      {result?.ok ? (
        <Button
          title="Continue"
          onPress={() => (d.kind === 'hub' ? void finishHubJoin() : router.push('/onboarding/vpn'))}
        />
      ) : (
        <Button title="Connect" onPress={test} loading={busy} disabled={missing} />
      )}
    </Screen>
  );
}

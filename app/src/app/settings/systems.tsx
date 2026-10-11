import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';

import { unregisterHubDevice } from '@/alerts/bridge';
import { Button, Card, Field, Screen, T, ToggleRow } from '@/components/ui/primitives';
import { forgetHubToken } from '@/systems/hub';
import { connectSystem, disconnectSystem, useLinks } from '@/net/connection';
import { secrets, SECRET } from '@/state/secrets';
import { useApp } from '@/state/store';
import { dropAdapter } from '@/systems/registry';
import { usePalette } from '@/theme/use-palette';
import { normalizeUrl, resolveScheme } from '@/util/url';
import { WgTunnel } from '@modules/wg-tunnel';

export default function SystemSettings() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const p = usePalette();
  const system = useApp((s) => s.systems.find((x) => x.id === id));
  const upsert = useApp((s) => s.upsertSystem);
  const removeSystem = useApp((s) => s.removeSystem);
  const link = useLinks((s) => s.links[id]);
  const [name, setName] = useState(system?.name ?? '');
  const [url, setUrl] = useState(system?.endpoint.lanUrl ?? '');
  const [user, setUser] = useState(system?.username ?? '');
  const [pass, setPass] = useState('');
  const [useTunnel, setUseTunnel] = useState(system?.endpoint.useTunnel ?? true);
  const [busy, setBusy] = useState(false);

  if (!system) return <Screen><T muted>System not found.</T></Screen>;

  const save = async () => {
    setBusy(true);
    if (pass) await secrets.set(system.id, SECRET.password, pass);
    const next = {
      ...system,
      name: name.trim() || system.name,
      username: user.trim() || undefined,
      endpoint: {
        ...system.endpoint,
        lanUrl:
          system.kind === 'frigate' && WgTunnel
            ? await resolveScheme(normalizeUrl(url), (u) => WgTunnel!.httpCheck(u, false, 4000))
            : system.kind === 'frigate'
              ? normalizeUrl(url)
              : url,
        useTunnel,
      },
    };
    // Credentials live in the native route, so rebuild it.
    disconnectSystem(system.id);
    dropAdapter(system.id);
    upsert(next);
    await connectSystem(next);
    setBusy(false);
  };

  return (
    <Screen>
      <T muted>
        Status: {link?.mode ?? 'unknown'}
        {link?.error ? ` · ${link.error}` : ''}
      </T>
      <Field label="Name" value={name} onChangeText={setName} autoCapitalize="words" />
      {system.kind === 'frigate' && (
        <>
          <Field label="Address" value={url} onChangeText={setUrl} keyboardType="url" />
          <Field label="Username" value={user} onChangeText={setUser} />
          <Field label="Password" value={pass} onChangeText={setPass} secureTextEntry placeholder="Unchanged" />
        </>
      )}
      {system.kind === 'hub' ? (
        <T v="caption" muted>
          {system.extra?.remoteUrl
            ? `Away from home: ${system.extra.remoteUrl}`
            : 'Away from home: off. Turn on remote access on the Hub’s setup page.'}
        </T>
      ) : (
        <Card>
          <ToggleRow label="Use VPN when away" value={useTunnel} onChange={setUseTunnel} last />
        </Card>
      )}
      <Button title="Save & reconnect" onPress={save} loading={busy} />
      <Button
        title="Remove system"
        kind="ghost"
        onPress={async () => {
          if (system.kind === 'hub') {
            // Stop this phone's push from the Hub before forgetting its token.
            await unregisterHubDevice(system);
            await forgetHubToken(system.id);
          }
          disconnectSystem(system.id);
          dropAdapter(system.id);
          await secrets.remove(system.id, SECRET.password);
          removeSystem(system.id);
          router.back();
        }}
      />
      <T v="caption" color={p.textMuted}>
        Removing a system only removes it from this app. Nothing on your recorder is changed.
      </T>
    </Screen>
  );
}

import { useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';

import { unregisterHubDevice } from '@/alerts/bridge';
import { Button, Card, Field, Screen, T, ToggleRow } from '@/components/ui/primitives';
import { forgetHubToken } from '@/systems/hub';
import { connectSystem, disconnectSystem, useLinks } from '@/net/connection';
import { secrets, SECRET } from '@/state/secrets';
import { useApp } from '@/state/store';
import { describe } from '@/systems/catalog';
import { resolveAddress } from '@/systems/discovery';
import { releaseSystemLive } from '@/systems/live';
import { dropAdapter } from '@/systems/registry';
import type { SystemConfig } from '@/systems/types';
import { usePalette } from '@/theme/use-palette';
import { userMessage } from '@/util/errors';

/** Edit or remove a connected system. Fields come from the catalog, like setup. */
export default function SystemSettings() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const p = usePalette();
  const system = useApp((s) => s.systems.find((x) => x.id === id));
  const upsert = useApp((s) => s.upsertSystem);
  const removeSystem = useApp((s) => s.removeSystem);
  const link = useLinks((s) => s.links[id]);
  const d = system ? describe(system.kind) : null;

  const [name, setName] = useState(system?.name ?? '');
  const [values, setValues] = useState<Record<string, string>>(() => ({
    address: system?.endpoint.lanUrl ?? '',
    username: system?.username ?? '',
    password: '',
    ...(system?.extra ?? {}),
  }));
  const [useTunnel, setUseTunnel] = useState(system?.endpoint.useTunnel ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  if (!system || !d) {
    return (
      <Screen>
        <T muted>System not found.</T>
      </Screen>
    );
  }

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const { address, username, password, ...extra } = values;
      if (password) await secrets.set(system.id, SECRET.password, password);
      const next: SystemConfig = {
        ...system,
        name: name.trim() || system.name,
        username: username?.trim() || undefined,
        extra: { ...system.extra, ...extra },
        endpoint: {
          ...system.endpoint,
          lanUrl: address && address !== system.endpoint.lanUrl ? await resolveAddress(d, address) : system.endpoint.lanUrl,
          useTunnel,
        },
      };
      // Credentials live in the native route (and this system's RTSP restreamers), so rebuild
      // them; other systems' live views keep playing.
      disconnectSystem(system.id);
      dropAdapter(system.id);
      releaseSystemLive(system.id);
      upsert(next);
      await connectSystem(next);
      // Streams and lists cached for the old settings point at routes that no longer exist.
      await queryClient.invalidateQueries({
        predicate: (q) => q.queryKey[0] === 'cameras' || q.queryKey[1] === system.id,
      });
    } catch (e) {
      setError(userMessage(e, name.trim() || system.name));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <T muted>
        {d.label} · {link?.mode === 'lan' ? 'Connected at home' : link?.mode === 'tunnel' ? 'Connected over VPN' : 'Not connected'}
        {link?.error ? `\n${link.error}` : ''}
      </T>
      <Field label="Name" value={name} onChangeText={setName} autoCapitalize="words" />
      {d.fields.map((f) => (
        <Field
          key={f.key}
          label={f.label}
          value={values[f.key] ?? ''}
          onChangeText={(v) => setValues((s) => ({ ...s, [f.key]: v }))}
          placeholder={f.secure ? 'Unchanged' : f.placeholder}
          hint={f.hint}
          secureTextEntry={f.secure}
          keyboardType={f.keyboard === 'url' ? 'url' : f.keyboard === 'number-pad' ? 'number-pad' : 'default'}
        />
      ))}
      {system.kind === 'hub' ? (
        <T v="caption" muted>
          {system.extra?.remoteUrl
            ? 'Away from home: on (through your Hub).'
            : 'Away from home: off. Turn on remote access on the Hub’s setup page.'}
        </T>
      ) : (
        d.usesGateway !== false && (
          <Card>
            <ToggleRow label="Reach it when I’m away" value={useTunnel} onChange={setUseTunnel} last />
          </Card>
        )
      )}
      {error && <T color={p.danger}>{error}</T>}
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
          releaseSystemLive(system.id);
          await secrets.remove(system.id, SECRET.password);
          removeSystem(system.id);
          router.back();
        }}
      />
      <T v="caption" color={p.textMuted}>
        Removing a system only removes it from this app. Nothing on your recorder or cameras is changed.
      </T>
    </Screen>
  );
}

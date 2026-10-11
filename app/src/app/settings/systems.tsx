import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';

import { Button, Card, Field, Screen, T, ToggleRow } from '@/components/ui/primitives';
import { connectSystem, disconnectSystem, useLinks } from '@/net/connection';
import { secrets, SECRET } from '@/state/secrets';
import { useApp } from '@/state/store';
import { describe } from '@/systems/catalog';
import { resolveAddress } from '@/systems/discovery';
import { releaseLive } from '@/systems/live';
import { dropAdapter } from '@/systems/registry';
import type { SystemConfig } from '@/systems/types';
import { usePalette } from '@/theme/use-palette';

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

  if (!system || !d) {
    return (
      <Screen>
        <T muted>System not found.</T>
      </Screen>
    );
  }

  const save = async () => {
    setBusy(true);
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
    // Credentials live in the native route (and any RTSP restreamers), so rebuild them.
    disconnectSystem(system.id);
    dropAdapter(system.id);
    releaseLive(`rtsp://`);
    upsert(next);
    await connectSystem(next);
    setBusy(false);
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
      {d.usesGateway !== false && d.category !== 'hub' && (
        <Card>
          <ToggleRow label="Use VPN when away" value={useTunnel} onChange={setUseTunnel} last />
        </Card>
      )}
      <Button title="Save & reconnect" onPress={save} loading={busy} />
      <Button
        title="Remove system"
        kind="ghost"
        onPress={async () => {
          disconnectSystem(system.id);
          dropAdapter(system.id);
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

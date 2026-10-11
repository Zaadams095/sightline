import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';

import { Button, Row, Screen, Section, T } from '@/components/ui/primitives';
import { useT } from '@/i18n/use-t';
import { connectSystem } from '@/net/connection';
import { useApp } from '@/state/store';
import { canShare, HubAdapter } from '@/systems/hub';
import { getAdapter } from '@/systems/registry';
import type { SystemConfig } from '@/systems/types';
import { parseTvLink, tvPairBody } from '@/tv/link';
import { usePalette } from '@/theme/use-palette';
import { fetchWithTimeout } from '@/util/fetch';

/**
 * Deep link sightline://tv?h=…&k=…&n=… (the QR code on the Apple TV app). Gives the TV its own
 * access to a Sightline Hub: a "live" grant that can be removed any time in Sharing, handed
 * over on the home network. Nothing goes through a cloud server.
 */
export default function ConnectTv() {
  const p = usePalette();
  const t = useT();
  const s = t.onboarding.tv;
  const params = useLocalSearchParams<{ h?: string; k?: string; n?: string }>();
  const link = parseTvLink(params);
  const systems = useApp((s) => s.systems);
  const hubs = systems.filter(canShare);
  const [hubId, setHubId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const hub = hubs.find((h) => h.id === hubId) ?? (hubs.length === 1 ? hubs[0] : undefined);

  const connect = async (system: SystemConfig) => {
    if (!link) return;
    setBusy(true);
    setError(null);
    let grantId: string | null = null;
    let adapter: HubAdapter | null = null;
    try {
      const route = await connectSystem(system);
      const a = route.mode === 'offline' ? null : getAdapter(system, route);
      if (!(a instanceof HubAdapter)) throw new Error(route.error ?? t.onboarding.cantReachHub);
      adapter = a;
      const { grant, invite } = await adapter.createGrant({ name: link.name, role: 'live', cameras: 'all', expiresAt: null });
      grantId = grant.id;
      const res = await fetchWithTimeout(
        `http://${link.host}/pair`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: tvPairBody(
            link,
            { name: system.extra?.hubName || system.name, lanUrl: system.endpoint.lanUrl.replace(/\/+$/, ''), remoteUrl: system.extra?.remoteUrl ?? '' },
            invite.code,
          ),
        },
        25000,
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? s.tvAnswered(res.status));
      }
      setDone(true);
    } catch (e) {
      // Don't leave an unused invite behind.
      if (grantId && adapter) await adapter.revokeGrant(grantId).catch(() => {});
      const message = e instanceof Error ? e.message : String(e);
      setError(
        /Network request failed|No response|abort/i.test(message)
          ? s.cantReachTv
          : message,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Stack.Screen options={{ title: s.title, headerShown: true }} />
      {!link ? (
        <T>{s.notTvCode}</T>
      ) : done ? (
        <>
          <T v="heading">{s.connected}</T>
          <T muted>{s.connectedBody(link.name)}</T>
          <Button title={t.common.done} onPress={() => router.replace('/')} />
        </>
      ) : hubs.length === 0 ? (
        <>
          <T v="heading">{s.needsHub}</T>
          <T muted>{s.needsHubBody}</T>
          <Button title={t.common.close} kind="secondary" onPress={() => router.back()} />
        </>
      ) : (
        <>
          <T v="heading">{s.showOn(link.name)}</T>
          <T muted>{s.grantBody}</T>
          {hubs.length > 1 && (
            <Section title={s.whichHub}>
              {hubs.map((h, i) => (
                <Row key={h.id} label={h.extra?.hubName || h.name} detail={h.id === hub?.id ? s.selected : undefined} onPress={() => setHubId(h.id)} last={i === hubs.length - 1} />
              ))}
            </Section>
          )}
          <Button title={s.connectTv} onPress={() => hub && void connect(hub)} loading={busy} disabled={!hub} />
          {error && <T color={p.danger}>{error}</T>}
        </>
      )}
    </Screen>
  );
}

import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';

import { Button, Row, Screen, Section, T } from '@/components/ui/primitives';
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
      if (!(a instanceof HubAdapter)) throw new Error(route.error ?? 'Couldn’t reach the Hub.');
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
        throw new Error(body.error ?? `The TV answered HTTP ${res.status}.`);
      }
      setDone(true);
    } catch (e) {
      // Don't leave an unused invite behind.
      if (grantId && adapter) await adapter.revokeGrant(grantId).catch(() => {});
      const message = e instanceof Error ? e.message : String(e);
      setError(
        /Network request failed|No response|abort/i.test(message)
          ? 'Couldn’t reach the TV. Make sure this iPhone is on the same Wi-Fi as the Apple TV, and that the Sightline code is still on the TV screen.'
          : message,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Stack.Screen options={{ title: 'Connect Apple TV', headerShown: true }} />
      {!link ? (
        <T>That isn’t a Sightline TV code. Open Sightline on the Apple TV and scan the code it shows.</T>
      ) : done ? (
        <>
          <T v="heading">Your Apple TV is connected</T>
          <T muted>It shows the cameras on your Hub. To remove it later, open Settings → Sharing and remove “{link.name}”.</T>
          <Button title="Done" onPress={() => router.replace('/')} />
        </>
      ) : hubs.length === 0 ? (
        <>
          <T v="heading">Apple TV needs a Sightline Hub</T>
          <T muted>
            The TV app shows cameras through your Sightline Hub, so it works with every brand. Set up a Hub (Settings → Instant Alerts or Sharing), then scan the TV code again.
          </T>
          <Button title="Close" kind="secondary" onPress={() => router.back()} />
        </>
      ) : (
        <>
          <T v="heading">Show your cameras on “{link.name}”?</T>
          <T muted>The TV gets live view and snapshots of all cameras, nothing else. You can remove it anytime in Sharing.</T>
          {hubs.length > 1 && (
            <Section title="Which Hub">
              {hubs.map((h, i) => (
                <Row key={h.id} label={h.extra?.hubName || h.name} detail={h.id === hub?.id ? 'Selected' : undefined} onPress={() => setHubId(h.id)} last={i === hubs.length - 1} />
              ))}
            </Section>
          )}
          <Button title="Connect TV" onPress={() => hub && void connect(hub)} loading={busy} disabled={!hub} />
          {error && <T color={p.danger}>{error}</T>}
        </>
      )}
    </Screen>
  );
}

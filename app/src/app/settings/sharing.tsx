import { useQuery } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useMemo, useState } from 'react';
import { Alert, Modal, Pressable, Share, StyleSheet, View } from 'react-native';

import { Button, Chip, Field, Row, Screen, Section, T } from '@/components/ui/primitives';
import { useLinks } from '@/net/connection';
import { useApp } from '@/state/store';
import { canShare, HubAdapter, type HubInvite } from '@/systems/hub';
import {
  formatDay,
  formatLocalDateTime,
  grantSummary,
  inviteMessage,
  parseLocalDateTime,
  presetWindow,
  ROLE_INFO,
  roleLabel,
  sharedByText,
  type GuestRole,
  type HubGrant,
} from '@/systems/hub-links';
import { getAdapter, useAllCameras } from '@/systems/registry';
import type { SystemConfig } from '@/systems/types';
import { space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';

const INSTALL_GUIDE = 'https://github.com/Zaadams095/sightline/blob/main/bridge/README.md';

/** Share access to cameras through a Sightline Hub (docs/PLATFORM.md §5). */
export default function SharingScreen() {
  const systems = useApp((s) => s.systems);
  const hubs = systems.filter((s) => s.kind === 'hub');
  const sharable = hubs.filter(canShare);
  const [hubId, setHubId] = useState<string | null>(null);

  if (hubs.length === 0) return <NoHub />;
  if (sharable.length === 0) return <SharedWithMe hubs={hubs} />;
  const hub = sharable.find((h) => h.id === hubId) ?? sharable[0];
  return (
    <Screen>
      {sharable.length > 1 && (
        <View style={styles.chips}>
          {sharable.map((h) => (
            <Chip key={h.id} label={h.name} selected={h.id === hub.id} onPress={() => setHubId(h.id)} />
          ))}
        </View>
      )}
      <HubSharing key={hub.id} hub={hub} />
    </Screen>
  );
}

function NoHub() {
  return (
    <Screen>
      <T v="heading">Sharing needs a Sightline Hub</T>
      <T muted>
        A Sightline Hub is a small free app that runs on a computer that&apos;s always on at home. It lets you share
        cameras with family and friends, and you decide which cameras and for how long. It also sends instant alerts
        and lets you watch away from home without a VPN.
      </T>
      <Section title="Where to install it">
        <Row label="Home Assistant" detail="Add the Sightline Hub add-on. The easiest option." />
        <Row label="Synology, Unraid or another NAS" detail="Add the sightline-hub container." />
        <Row label="Any computer with Docker" detail="One line next to your recorder." last />
      </Section>
      <Button title="How to install" kind="secondary" onPress={() => void WebBrowser.openBrowserAsync(INSTALL_GUIDE)} />
      <Button
        title="I have a Hub"
        onPress={() => router.push({ pathname: '/onboarding/connect', params: { kind: 'hub' } })}
      />
    </Screen>
  );
}

function SharedWithMe({ hubs }: { hubs: SystemConfig[] }) {
  return (
    <Screen>
      <T muted>These cameras were shared with you. Only the person who shared them can share them with others.</T>
      <Section title="Shared with you">
        {hubs.map((h, i) => (
          <Row
            key={h.id}
            label={h.name}
            detail={`${roleLabel((h.extra?.role || 'household') as GuestRole)} · ${sharedByText(
              h.extra?.hubName || h.name,
              h.extra?.expiresAt ? Number(h.extra.expiresAt) : null,
            )}`}
            last={i === hubs.length - 1}
          />
        ))}
      </Section>
    </Screen>
  );
}

function HubSharing({ hub }: { hub: SystemConfig }) {
  const p = usePalette();
  const link = useLinks((st) => st.links[hub.id]);
  const connected = link?.mode === 'lan' || link?.mode === 'tunnel';
  const adapter = connected ? getAdapter(hub, link) : null;
  const hubAdapter = adapter instanceof HubAdapter ? adapter : null;
  const { entries } = useAllCameras({ includeHidden: true });
  const cameras = useMemo(() => entries.filter((e) => e.camera.systemId === hub.id).map((e) => e.camera), [entries, hub.id]);
  const nameOf = (id: string) => cameras.find((c) => c.id === id)?.name ?? id;
  const [flow, setFlow] = useState(false);
  const [shown, setShown] = useState<{ invite: HubInvite; role: GuestRole; name: string } | null>(null);

  const grants = useQuery({
    queryKey: ['hub-grants', hub.id, link?.baseUrl],
    enabled: !!hubAdapter,
    queryFn: async () => {
      if (!hubAdapter!.info) await hubAdapter!.connect();
      return hubAdapter!.listGrants();
    },
  });

  if (!hubAdapter) {
    return <T muted>{link?.error ?? 'Connecting to the Hub…'}</T>;
  }
  const me = hubAdapter.info?.grant?.id;
  const guests = (grants.data ?? []).filter((g) => g.role !== 'owner');
  const owners = (grants.data ?? []).filter((g) => g.role === 'owner');

  const revoke = (g: HubGrant) =>
    Alert.alert(`Stop sharing with ${g.name}?`, 'They lose access right away, on every phone they use.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: g.role === 'owner' ? 'Remove' : 'Revoke',
        style: 'destructive',
        onPress: async () => {
          try {
            await hubAdapter.revokeGrant(g.id);
          } catch (e) {
            Alert.alert('Couldn’t revoke', e instanceof Error ? e.message : String(e));
          }
          void grants.refetch();
        },
      },
    ]);

  const manage = (g: HubGrant) =>
    Alert.alert(g.name, `${roleLabel(g.role)} · ${grantSummary(g, nameOf)}`, [
      {
        text: 'Send a new invite',
        onPress: async () => {
          try {
            const r = await hubAdapter.reinvite(g.id);
            setShown({ invite: r.invite, role: g.role as GuestRole, name: g.name });
          } catch (e) {
            Alert.alert('Couldn’t make an invite', e instanceof Error ? e.message : String(e));
          }
        },
      },
      { text: 'Revoke access', style: 'destructive', onPress: () => revoke(g) },
      { text: 'Close', style: 'cancel' },
    ]);

  return (
    <>
      <T muted>Give family, a neighbor or a sitter access to the cameras you pick. You can take it back at any time.</T>
      <Button title="Share access" onPress={() => setFlow(true)} />

      {grants.error && <T color={p.danger}>{(grants.error as Error).message}</T>}

      <Section title="People" footer={guests.length === 0 && !grants.isLoading ? 'You haven’t shared with anyone yet.' : undefined}>
        {guests.length === 0 ? (
          <Row label={grants.isLoading ? 'Loading…' : 'Nobody yet'} last />
        ) : (
          guests.map((g, i) => (
            <Row
              key={g.id}
              label={g.name}
              detail={`${roleLabel(g.role)} · ${grantSummary(g, nameOf)}`}
              onPress={() => manage(g)}
              last={i === guests.length - 1}
            />
          ))
        )}
      </Section>

      {owners.length > 0 && (
        <Section title="Owner phones" footer="To add another of your own phones, share Full access with yourself.">
          {owners.map((g, i) => (
            <Row
              key={g.id}
              label={g.id === me ? `${g.name} (this phone)` : g.name}
              detail={`Paired ${formatDay(g.createdAt)}`}
              onPress={g.id === me ? undefined : () => revoke(g)}
              last={i === owners.length - 1}
            />
          ))}
        </Section>
      )}

      <ShareFlow
        visible={flow}
        hubName={hubAdapter.hubName}
        cameras={cameras.map((c) => ({ id: c.id, name: c.name }))}
        onClose={() => setFlow(false)}
        onCreate={async (req) => {
          const r = await hubAdapter.createGrant(req);
          void grants.refetch();
          setFlow(false);
          setShown({ invite: r.invite, role: req.role, name: req.name });
        }}
      />
      <InviteSheet shown={shown} hubName={hubAdapter.hubName} onClose={() => setShown(null)} />
    </>
  );
}

// ---- share flow ----

type Preset = 'today' | 'week' | 'custom' | 'none';

interface ShareRequest {
  name: string;
  role: GuestRole;
  cameras: 'all' | string[];
  recordings?: 'all' | 'none' | { from: number; to: number };
  expiresAt: number | null;
}

function ShareFlow({
  visible,
  hubName,
  cameras,
  onClose,
  onCreate,
}: {
  visible: boolean;
  hubName: string;
  cameras: { id: string; name: string }[];
  onClose: () => void;
  onCreate: (req: ShareRequest) => Promise<void>;
}) {
  const p = usePalette();
  const [role, setRole] = useState<GuestRole | null>(null);
  const [name, setName] = useState('');
  const [all, setAll] = useState(true);
  const [picked, setPicked] = useState<string[]>([]);
  const [preset, setPreset] = useState<Preset>('week');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setRole(null);
    setName('');
    setAll(true);
    setPicked([]);
    setPreset('week');
    setError(null);
  };
  const close = () => {
    reset();
    onClose();
  };

  const pickRole = (r: GuestRole) => {
    setRole(r);
    setPreset(r === 'temporary' ? 'week' : 'none');
    const w = presetWindow('week');
    setCustomFrom(formatLocalDateTime(w.from));
    setCustomTo(formatLocalDateTime(w.to));
  };

  const datesApply = role === 'temporary' || role === 'live';

  const submit = async () => {
    if (!role) return;
    setError(null);
    if (!name.trim()) return setError('Add a name so you know who this is for.');
    if (role !== 'full' && !all && picked.length === 0) return setError('Pick at least one camera.');
    let window: { from: number; to: number } | null = null;
    if (datesApply && preset !== 'none') {
      if (preset === 'custom') {
        const from = parseLocalDateTime(customFrom);
        const to = parseLocalDateTime(customTo, true);
        if (!from || !to) return setError('Use dates like 2026-10-12 or 2026-10-12 18:30.');
        if (to <= from) return setError('The end has to be after the start.');
        window = { from: Math.floor(from.getTime() / 1000), to: Math.floor(to.getTime() / 1000) };
      } else window = presetWindow(preset);
      if (window.to * 1000 <= Date.now()) return setError('The end date has already passed.');
    }
    if (role === 'temporary' && !window) return setError('Temporary access needs an end date.');
    setBusy(true);
    try {
      await onCreate({
        name: name.trim(),
        role,
        cameras: role === 'full' || all ? 'all' : picked,
        recordings: role === 'temporary' && window ? window : undefined,
        expiresAt: window?.to ?? null,
      });
      reset();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
      <Screen>
        <View style={styles.sheetHead}>
          <T v="title">{role ? ROLE_INFO[role].label : 'Share access'}</T>
          <Button title="Cancel" kind="ghost" onPress={close} style={{ height: 36 }} />
        </View>

        {!role ? (
          <>
            <T muted>What should they be able to do on {hubName}?</T>
            {(Object.keys(ROLE_INFO) as GuestRole[]).map((r) => (
              <Pressable
                key={r}
                onPress={() => pickRole(r)}
                style={({ pressed }) => [styles.option, { backgroundColor: pressed ? p.surfaceRaised : p.surface, borderColor: p.border }]}>
                <T v="heading" style={{ fontSize: 17 }}>
                  {ROLE_INFO[r].label}
                </T>
                <T muted>{ROLE_INFO[r].description}</T>
              </Pressable>
            ))}
          </>
        ) : (
          <>
            <T muted>{ROLE_INFO[role].description}</T>
            <Field label="Who is this for?" value={name} onChangeText={setName} placeholder="Mom, Pet sitter…" autoCapitalize="words" />

            {role !== 'full' && (
              <View style={{ gap: space.sm }}>
                <T v="label" muted>
                  Cameras
                </T>
                <View style={styles.chips}>
                  <Chip label="All cameras" selected={all} onPress={() => setAll(true)} />
                  {cameras.map((c) => (
                    <Chip
                      key={c.id}
                      label={c.name}
                      selected={!all && picked.includes(c.id)}
                      onPress={() => {
                        setAll(false);
                        setPicked((cur) => (cur.includes(c.id) ? cur.filter((x) => x !== c.id) : [...cur, c.id]));
                      }}
                    />
                  ))}
                </View>
              </View>
            )}

            {datesApply && (
              <View style={{ gap: space.sm }}>
                <T v="label" muted>
                  {role === 'temporary' ? 'When' : 'Ends'}
                </T>
                <View style={styles.chips}>
                  {role === 'live' && <Chip label="No end date" selected={preset === 'none'} onPress={() => setPreset('none')} />}
                  <Chip label="Today" selected={preset === 'today'} onPress={() => setPreset('today')} />
                  <Chip label="This week" selected={preset === 'week'} onPress={() => setPreset('week')} />
                  <Chip label="Custom" selected={preset === 'custom'} onPress={() => setPreset('custom')} />
                </View>
                {preset === 'custom' ? (
                  <>
                    <Field label="Starts" value={customFrom} onChangeText={setCustomFrom} placeholder="2026-10-12 08:00" />
                    <Field label="Ends" value={customTo} onChangeText={setCustomTo} placeholder="2026-10-19 18:00" />
                  </>
                ) : preset !== 'none' ? (
                  <T v="caption" muted>
                    {`Until ${formatDay(presetWindow(preset).to, new Date(), true)}. ${
                      role === 'temporary' ? 'They can see recordings from this time only.' : ''
                    }`}
                  </T>
                ) : null}
              </View>
            )}

            {error && <T color={p.danger}>{error}</T>}
            <Button title="Create invite" onPress={submit} loading={busy} />
            <Button title="Back" kind="ghost" onPress={() => setRole(null)} />
          </>
        )}
      </Screen>
    </Modal>
  );
}

function InviteSheet({
  shown,
  hubName,
  onClose,
}: {
  shown: { invite: HubInvite; role: GuestRole; name: string } | null;
  hubName: string;
  onClose: () => void;
}) {
  const p = usePalette();
  if (!shown) return null;
  const { invite, role, name } = shown;
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <Screen>
        <T v="title">Invite {name}</T>
        <T muted>
          On their iPhone, they install Sightline, tap “Someone shared cameras with me” and scan this code. Or send them
          the invite.
        </T>
        {invite.qr ? (
          <View style={[styles.qrWrap, { borderColor: p.border }]}>
            <Image source={{ uri: invite.qr }} style={styles.qr} contentFit="contain" />
          </View>
        ) : null}
        <Button
          title="Send invite"
          onPress={() => void Share.share({ message: inviteMessage(hubName, role, invite.link, invite.webLink) })}
        />
        <T v="caption" muted style={{ textAlign: 'center' }}>
          {`Code ${invite.code} · works once · expires ${formatDay(invite.expiresAt, new Date(), true)}`}
        </T>
        {!invite.webLink && (
          <T v="caption" muted>
            Remote access is off on the Hub, so they can only join and watch while on your Wi-Fi. Turn it on from the
            Hub’s setup page.
          </T>
        )}
        <Button title="Done" kind="secondary" onPress={onClose} />
      </Screen>
    </Modal>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  sheetHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  option: { padding: space.lg, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, gap: space.xs },
  qrWrap: { alignSelf: 'center', backgroundColor: '#fff', padding: space.md, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth },
  qr: { width: 240, height: 240 },
});

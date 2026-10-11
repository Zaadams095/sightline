import { useQuery } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useMemo, useState } from 'react';
import { Alert, Modal, Pressable, Share, StyleSheet, View } from 'react-native';

import { Button, Chip, Field, Row, Screen, Section, T } from '@/components/ui/primitives';
import { useT } from '@/i18n/use-t';
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
  const s = useT().settings.sharing;
  return (
    <Screen>
      <T v="heading">{s.needsHub}</T>
      <T muted>{s.hubAbout}</T>
      <Section title={s.whereTitle}>
        <Row label="Home Assistant" detail={s.haDetail} />
        <Row label={s.nas} detail={s.nasDetail} />
        <Row label={s.docker} detail={s.dockerDetail} last />
      </Section>
      <Button title={s.howToInstall} kind="secondary" onPress={() => void WebBrowser.openBrowserAsync(INSTALL_GUIDE)} />
      <Button
        title={s.haveHub}
        onPress={() => router.push({ pathname: '/onboarding/connect', params: { kind: 'hub' } })}
      />
    </Screen>
  );
}

function SharedWithMe({ hubs }: { hubs: SystemConfig[] }) {
  const s = useT().settings.sharing;
  return (
    <Screen>
      <T muted>{s.sharedIntro}</T>
      <Section title={s.sharedWithYou}>
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
  const t = useT();
  const s = t.settings.sharing;
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
    return <T muted>{link?.error ?? s.connecting}</T>;
  }
  const me = hubAdapter.info?.grant?.id;
  const guests = (grants.data ?? []).filter((g) => g.role !== 'owner');
  const owners = (grants.data ?? []).filter((g) => g.role === 'owner');

  const revoke = (g: HubGrant) =>
    Alert.alert(s.stopTitle(g.name), s.stopBody, [
      { text: t.common.cancel, style: 'cancel' },
      {
        text: g.role === 'owner' ? t.common.remove : s.revoke,
        style: 'destructive',
        onPress: async () => {
          try {
            await hubAdapter.revokeGrant(g.id);
          } catch (e) {
            Alert.alert(s.couldntRevoke, e instanceof Error ? e.message : String(e));
          }
          void grants.refetch();
        },
      },
    ]);

  const manage = (g: HubGrant) =>
    Alert.alert(g.name, `${roleLabel(g.role)} · ${grantSummary(g, nameOf)}`, [
      {
        text: s.sendNewInvite,
        onPress: async () => {
          try {
            const r = await hubAdapter.reinvite(g.id);
            setShown({ invite: r.invite, role: g.role as GuestRole, name: g.name });
          } catch (e) {
            Alert.alert(s.couldntInvite, e instanceof Error ? e.message : String(e));
          }
        },
      },
      { text: s.revokeAccess, style: 'destructive', onPress: () => revoke(g) },
      { text: t.common.close, style: 'cancel' },
    ]);

  return (
    <>
      <T muted>{s.intro}</T>
      <Button title={s.shareAccess} onPress={() => setFlow(true)} />

      {grants.error && <T color={p.danger}>{(grants.error as Error).message}</T>}

      <Section title={s.people} footer={guests.length === 0 && !grants.isLoading ? s.noneYetFooter : undefined}>
        {guests.length === 0 ? (
          <Row label={grants.isLoading ? t.common.loading : s.nobodyYet} last />
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
        <Section title={s.ownerPhones} footer={s.ownerFooter}>
          {owners.map((g, i) => (
            <Row
              key={g.id}
              label={g.id === me ? s.thisPhone(g.name) : g.name}
              detail={s.paired(formatDay(g.createdAt))}
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
  const t = useT();
  const s = t.settings.sharing;
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
    if (!name.trim()) return setError(s.needName);
    if (role !== 'full' && !all && picked.length === 0) return setError(s.pickCamera);
    let window: { from: number; to: number } | null = null;
    if (datesApply && preset !== 'none') {
      if (preset === 'custom') {
        const from = parseLocalDateTime(customFrom);
        const to = parseLocalDateTime(customTo, true);
        if (!from || !to) return setError(s.dateFormat);
        if (to <= from) return setError(s.endAfterStart);
        window = { from: Math.floor(from.getTime() / 1000), to: Math.floor(to.getTime() / 1000) };
      } else window = presetWindow(preset);
      if (window.to * 1000 <= Date.now()) return setError(s.endPassed);
    }
    if (role === 'temporary' && !window) return setError(s.needsEnd);
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
          <T v="title">{role ? ROLE_INFO[role].label : s.shareAccess}</T>
          <Button title={t.common.cancel} kind="ghost" onPress={close} style={{ minHeight: 36 }} />
        </View>

        {!role ? (
          <>
            <T muted>{s.whatCanTheyDo(hubName)}</T>
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
            <Field label={s.whoFor} value={name} onChangeText={setName} placeholder={s.whoPlaceholder} autoCapitalize="words" />

            {role !== 'full' && (
              <View style={{ gap: space.sm }}>
                <T v="label" muted>
                  {s.cameras}
                </T>
                <View style={styles.chips}>
                  <Chip label={s.allCameras} selected={all} onPress={() => setAll(true)} />
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
                  {role === 'temporary' ? s.when : s.ends}
                </T>
                <View style={styles.chips}>
                  {role === 'live' && <Chip label={s.noEnd} selected={preset === 'none'} onPress={() => setPreset('none')} />}
                  <Chip label={t.common.today} selected={preset === 'today'} onPress={() => setPreset('today')} />
                  <Chip label={s.thisWeek} selected={preset === 'week'} onPress={() => setPreset('week')} />
                  <Chip label={s.custom} selected={preset === 'custom'} onPress={() => setPreset('custom')} />
                </View>
                {preset === 'custom' ? (
                  <>
                    <Field label={s.starts} value={customFrom} onChangeText={setCustomFrom} placeholder="2026-10-12 08:00" />
                    <Field label={s.ends} value={customTo} onChangeText={setCustomTo} placeholder="2026-10-19 18:00" />
                  </>
                ) : preset !== 'none' ? (
                  <T v="caption" muted>
                    {`${s.until(formatDay(presetWindow(preset).to, new Date(), true))} ${
                      role === 'temporary' ? s.recordingsOnly : ''
                    }`}
                  </T>
                ) : null}
              </View>
            )}

            {error && <T color={p.danger}>{error}</T>}
            <Button title={s.createInvite} onPress={submit} loading={busy} />
            <Button title={t.common.back} kind="ghost" onPress={() => setRole(null)} />
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
  const t = useT();
  const s = t.settings.sharing;
  if (!shown) return null;
  const { invite, role, name } = shown;
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <Screen>
        <T v="title">{s.inviteTitle(name)}</T>
        <T muted>{s.inviteBody}</T>
        {invite.qr ? (
          <View style={[styles.qrWrap, { borderColor: p.border }]}>
            <Image source={{ uri: invite.qr }} style={styles.qr} contentFit="contain" />
          </View>
        ) : null}
        <Button
          title={s.sendInvite}
          onPress={() => void Share.share({ message: inviteMessage(hubName, role, invite.link, invite.webLink) })}
        />
        <T v="caption" muted style={{ textAlign: 'center' }}>
          {s.codeLine(invite.code, formatDay(invite.expiresAt, new Date(), true))}
        </T>
        {!invite.webLink && (
          <T v="caption" muted>
            {s.remoteOff}
          </T>
        )}
        <Button title={t.common.done} kind="secondary" onPress={onClose} />
      </Screen>
    </Modal>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  sheetHead: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center' },
  option: { padding: space.lg, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, gap: space.xs },
  qrWrap: { alignSelf: 'center', backgroundColor: '#fff', padding: space.md, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth },
  qr: { width: 240, height: 240 },
});

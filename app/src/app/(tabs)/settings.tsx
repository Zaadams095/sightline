import { router } from 'expo-router';
import { Platform, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { confirmRemoveDemo, offerSampleAlert } from '@/components/demo-banner';
import { Row, Screen, Section, StatusDot, T } from '@/components/ui/primitives';
import { useT } from '@/i18n/use-t';
import { useLinks } from '@/net/connection';
import { useApp } from '@/state/store';
import { startDemo, useDemoActive } from '@/systems/demo/session';
import { canShare, isGuest } from '@/systems/hub';
import { sharedByText } from '@/systems/hub-links';
import type { SystemConfig } from '@/systems/types';
import { space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';

/** "Shared by Home · ends Oct 12" for systems someone shared with this phone. */
function sharedDetail(s: SystemConfig): string | undefined {
  if (s.kind !== 'hub' || !s.extra?.role || s.extra.role === 'owner') return undefined;
  return sharedByText(s.extra.hubName || s.name, s.extra.expiresAt ? Number(s.extra.expiresAt) : null);
}

export default function SettingsScreen() {
  const p = usePalette();
  const t = useT();
  const L = t.home.settings;
  const nav = t.home.nav;
  const insets = useSafeAreaInsets();
  const systems = useApp((s) => s.systems);
  const alerts = useApp((s) => s.alerts);
  const links = useLinks((s) => s.links);
  const tunnelUp = useLinks((s) => s.tunnelUp);
  const { width } = useWindowDimensions();
  // Custom grid layouts only matter on a big screen (same rule as the Live tab).
  const tablet = (Platform.OS === 'ios' && Platform.isPad) || width >= 700;
  const hasHub = systems.some((s) => s.kind === 'hub');
  const hubRemote = systems.some((s) => s.kind === 'hub' && !!s.extra?.remoteUrl);
  // Someone who only has shared cameras doesn't need away-from-home or Hub setup.
  const guestOnly = systems.length > 0 && systems.every(isGuest);
  const sharable = systems.some(canShare);
  const shared = systems.find((s) => sharedDetail(s));
  const demoActive = useDemoActive();

  return (
    <Screen style={{ paddingTop: insets.top + space.sm }}>
      <T v="title">{t.home.tabs.settings}</T>

      <Section title={L.systems}>
        {systems.map((s) => {
          const mode = links[s.id]?.mode ?? 'connecting';
          const color = { lan: p.success, tunnel: p.accent, connecting: p.warning, offline: p.danger }[mode];
          return (
            <Row
              key={s.id}
              label={s.name}
              detail={s.kind === 'demo' ? L.demoDetail : (links[s.id]?.error ?? sharedDetail(s) ?? s.endpoint.lanUrl)}
              icon={<StatusDot color={color} />}
              onPress={() => router.push({ pathname: '/settings/systems', params: { id: s.id } })}
            />
          );
        })}
        <Row label={L.addSystem} onPress={() => router.push('/onboarding')} last />
      </Section>

      <Section title={L.sampleCameras}>
        {demoActive ? (
          <>
            <Row label={L.sendSample} detail={L.sendSampleDetail} onPress={offerSampleAlert} />
            <Row label={L.removeSamples} destructive onPress={confirmRemoveDemo} last />
          </>
        ) : (
          <Row
            label={L.addSamples}
            detail={L.addSamplesDetail}
            onPress={() => void startDemo().then(() => router.navigate('/'))}
            last
          />
        )}
      </Section>

      <Section title={nav.sharing}>
        <Row
          label={sharable || !shared ? L.shareAccess : L.sharedWithYou}
          detail={
            sharable
              ? L.shareDetail
              : shared
                ? sharedDetail(shared)
                : L.needsHub
          }
          onPress={() => router.push('/settings/sharing')}
          last={!sharable}
        />
        {sharable && (
          <Row
            label="Apple TV"
            detail={L.appleTvDetail}
            last
          />
        )}
      </Section>

      {!guestOnly && (
        <Section title={L.connection}>
          <Row
            label={nav.awayFromHome}
            detail={hubRemote ? L.awayViaHub : tunnelUp ? L.connected : L.awayDetail}
            onPress={() => router.push('/settings/vpn')}
          />
          <Row label={nav.connectionCheck} detail={L.connectionCheckDetail} onPress={() => router.push('/settings/diagnostics')} last />
        </Section>
      )}

      <Section title={nav.alerts}>
        <Row
          label={L.alertSettings}
          detail={alerts.mode === 'instant' ? nav.instantAlerts : L.builtIn}
          onPress={() => router.push('/settings/alerts')}
        />
        <Row
          label={nav.homeAway}
          detail={alerts.presence.enabled ? (alerts.presence.atHome ? L.homeOnly : L.awayAll) : L.homeAwayDetail}
          onPress={() => router.push('/settings/home-away')}
          last={guestOnly}
        />
        {!guestOnly && (
          <Row
            label={nav.instantAlerts}
            detail={hasHub || alerts.bridge ? L.instantReady : L.needsHub}
            onPress={() => router.push('/settings/bridge')}
            last
          />
        )}
      </Section>

      <Section title={L.recognition}>
        <Row label={nav.peopleVehicles} detail={L.peopleDetail} onPress={() => router.push('/people')} last />
      </Section>

      <Section title={L.privacy}>
        <Row label={L.appLock} detail={L.appLockDetail} onPress={() => router.push('/settings/security')} />
        <Row label={L.crashData} detail={L.crashDataDetail} onPress={() => router.push('/settings/crash-data')} last />
      </Section>

      <Section title={L.backup}>
        <Row label={nav.backup} detail={L.backupDetail} onPress={() => router.push('/settings/backup')} last />
      </Section>

      <Section title={L.help}>
        <Row label={L.report} detail={L.reportDetail} onPress={() => router.push('/settings/report')} last />
      </Section>

      {systems.length > 0 && (
        <Section title={t.home.tabs.recordings}>
          <Row
            label={nav.export}
            detail={L.exportDetail}
            onPress={() => router.push('/export')}
            last
          />
        </Section>
      )}

      <Section title={L.look}>
        <Row label={t.common.appearance.title} detail={L.appearanceDetail} onPress={() => router.push('/settings/appearance')} />
        <Row label={nav.camerasOrder} detail={L.camerasOrderDetail} onPress={() => router.push('/settings/cameras')} />
        <Row label={nav.cameraGroups} detail={L.groupsDetail} onPress={() => router.push('/settings/groups')} last={!tablet} />
        {tablet && <Row label={nav.gridLayouts} detail={L.gridDetail} onPress={() => router.push('/settings/grid')} />}
        {tablet && <Row label={nav.wallDisplay} detail={L.wallDetail} onPress={() => router.push('/settings/wall')} last />}
      </Section>

      <View style={{ alignItems: 'center', paddingTop: space.md }}>
        <T v="caption" muted style={{ textAlign: 'center' }}>
          {L.footer}
        </T>
      </View>
    </Screen>
  );
}

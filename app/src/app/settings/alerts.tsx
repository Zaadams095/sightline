import { router, Stack } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { checkForAlerts, registerBackgroundAlerts, requestNotificationPermission } from '@/alerts/background';
import { ruleFor } from '@/alerts/rules';
import { zoneSupportFor, type ZoneSupport } from '@/alerts/zones';
import { DoorbellPackagesSection, HealthSection, KnownPeopleSection, LockScreenSection, SnoozedSection } from '@/components/alerts/alert-extras';
import { SmartAlertsSection } from '@/components/alerts/smart-section';
import { Button, Chip, Row, Screen, Section, T, TimeStepper, ToggleRow } from '@/components/ui/primitives';
import { useFamiliar } from '@/familiar/store';
import type { Strings } from '@/i18n';
import { useT } from '@/i18n/use-t';
import { useApp, type CameraAlertRule } from '@/state/store';
import { useFeatureSupport } from '@/systems/caps';
import { useAllCameras } from '@/systems/registry';
import { labelFor } from '@/util/format';
import type { Camera, Severity } from '@/systems/types';
import { space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';

const COOLDOWNS = [0, 30, 60, 300, 900];

export default function AlertSettings() {
  const p = usePalette();
  const t = useT();
  const a = t.alertSettings.alerts;
  const alerts = useApp((s) => s.alerts);
  const setAlerts = useApp((s) => s.setAlerts);
  const setRule = useApp((s) => s.setCameraRule);
  const { entries } = useAllCameras({ includeHidden: true });
  const support = useFeatureSupport();
  // People named on this iPhone (People & vehicles) also get the known-people choices.
  const hasFamiliar = useFamiliar((s) => s.settings.enabled && s.identities.some((i) => !i.ignored && !!i.name));
  // Instant push needs a paired Sightline Hub (or the older stand-alone alerts container).
  const instantReady = useApp((s) => s.systems.some((x) => x.kind === 'hub') || !!s.alerts.bridge);
  const [open, setOpen] = useState<string | null>(null);
  const [testMsg, setTestMsg] = useState<string | null>(null);

  return (
    <Screen>
      <Stack.Screen options={{ title: a.title }} />
      <Section
        title={a.delivery}
        footer={
          !instantReady
            ? a.deliveryNoHub
            : alerts.mode === 'built-in'
              ? a.deliveryBuiltIn
              : a.deliveryInstant
        }>
        <View style={styles.chips}>
          <Chip label={a.builtIn} selected={alerts.mode === 'built-in'} onPress={() => { setAlerts({ mode: 'built-in' }); void registerBackgroundAlerts(); }} />
          <Chip
            label={a.instant}
            selected={alerts.mode === 'instant'}
            disabled={!instantReady && alerts.mode !== 'instant'}
            accessibilityLabel={instantReady ? a.instant : a.instantNeedsHub}
            onPress={() => { setAlerts({ mode: 'instant' }); void registerBackgroundAlerts(); }}
          />
        </View>
        {!instantReady && <Row label={a.setUpHub} detail={a.setUpHubDetail} onPress={() => router.push('/settings/bridge')} last />}
      </Section>

      <SnoozedSection entries={entries} />

      <SmartAlertsSection />

      <LockScreenSection />

      <DoorbellPackagesSection />

      {(support.knownNames || hasFamiliar) && <KnownPeopleSection />}

      <Section title={a.quietHours}>
        <ToggleRow
          label={a.quietHours}
          detail={a.quietHoursDetail}
          value={alerts.quietHours.enabled}
          onChange={(enabled) => setAlerts({ quietHours: { ...alerts.quietHours, enabled } })}
          last={!alerts.quietHours.enabled}
        />
        {alerts.quietHours.enabled && (
          <>
            <TimeStepper label={a.from} value={alerts.quietHours.start} onChange={(start) => setAlerts({ quietHours: { ...alerts.quietHours, start } })} />
            <TimeStepper label={a.until} value={alerts.quietHours.end} onChange={(end) => setAlerts({ quietHours: { ...alerts.quietHours, end } })} last />
          </>
        )}
      </Section>

      {support.health && <HealthSection />}

      <Section title={a.cooldown}>
        <View style={styles.chips}>
          {COOLDOWNS.map((c) => (
            <Chip key={c} label={c === 0 ? t.common.off : c < 60 ? a.secShort(c) : a.minShort(c / 60)} selected={alerts.cooldownSec === c} onPress={() => setAlerts({ cooldownSec: c })} />
          ))}
        </View>
      </Section>

      <T v="caption" muted style={{ textTransform: 'uppercase', letterSpacing: 0.6, marginLeft: space.xs }}>
        {a.cameras}
      </T>
      {entries.map(({ camera, adapter }) => {
        const rule = ruleFor(alerts, camera.key);
        const custom = !!alerts.rules[camera.key];
        return (
          <Section key={camera.key}>
            <Row
              label={camera.name}
              detail={describe(rule, t)}
              onPress={() => setOpen(open === camera.key ? null : camera.key)}
              right={<T color={rule.enabled ? p.success : p.textMuted}>{rule.enabled ? t.common.on : t.common.off}</T>}
              last={open !== camera.key}
            />
            {open === camera.key && (
              <RuleEditor
                camera={camera}
                rule={rule}
                custom={custom}
                onChange={(r) => setRule(camera.key, r)}
                onReset={() => setRule(camera.key, null)}
                zones={zoneSupportFor(adapter, camera)}
              />
            )}
          </Section>
        );
      })}

      <Button
        title={a.checkNow}
        kind="secondary"
        onPress={async () => {
          await requestNotificationPermission();
          const n = await checkForAlerts();
          setTestMsg(n ? a.sent(n) : a.nothingNew);
        }}
      />
      {testMsg && <T muted>{testMsg}</T>}
    </Screen>
  );
}

function RuleEditor({
  camera,
  rule,
  custom,
  onChange,
  onReset,
  zones,
}: {
  camera: Camera;
  rule: CameraAlertRule;
  custom: boolean;
  onChange: (r: CameraAlertRule) => void;
  onReset: () => void;
  zones: ZoneSupport;
}) {
  const t = useT();
  const a = t.alertSettings.alerts;
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const severities: { v: Severity; label: string }[] = [
    { v: 'alert', label: a.important },
    { v: 'detection', label: a.otherMotion },
  ];
  return (
    <View style={{ padding: space.lg, gap: space.md }}>
      <ToggleRow label={a.notifyForCamera} value={rule.enabled} onChange={(enabled) => onChange({ ...rule, enabled })} last />
      <T v="label" muted>
        {a.notifyMeFor}
      </T>
      <View style={styles.chips0}>
        {severities.map((s) => (
          <Chip key={s.v} label={s.label} selected={rule.severities.includes(s.v)} onPress={() => onChange({ ...rule, severities: toggle(rule.severities, s.v) })} />
        ))}
      </View>
      <T v="label" muted>
        {rule.objects.length === 0 ? a.whatAnything : a.what}
      </T>
      <View style={styles.chips0}>
        {camera.objects.map((o) => (
          <Chip key={o} label={labelFor([o])} selected={rule.objects.includes(o)} onPress={() => onChange({ ...rule, objects: toggle(rule.objects, o) })} />
        ))}
      </View>
      {camera.zones.length > 0 && (
        <>
          <T v="label" muted>
            {rule.zones.length === 0 ? a.whereAnywhere : a.where}
          </T>
          <View style={styles.chips0}>
            {camera.zones.map((z) => (
              <Chip key={z} label={z.replace(/_/g, ' ')} selected={rule.zones.includes(z)} onPress={() => onChange({ ...rule, zones: toggle(rule.zones, z) })} />
            ))}
          </View>
        </>
      )}
      {zones ? (
        <ZonesButton cameraKey={camera.key} />
      ) : (
        <T v="caption" muted>
          {a.noZones}
        </T>
      )}
      {custom && <Button title={a.useDefault} kind="ghost" onPress={onReset} />}
    </View>
  );
}

function ZonesButton({ cameraKey }: { cameraKey: string }) {
  const t = useT();
  const count = useApp((s) => s.alertZones[cameraKey]?.length ?? 0);
  return (
    <Button
      title={count ? t.alertSettings.alerts.zonesCount(count) : t.alertSettings.alerts.zonesNone}
      kind="secondary"
      onPress={() => router.push({ pathname: '/settings/zones', params: { key: cameraKey } })}
    />
  );
}

function describe(r: CameraAlertRule, t: Strings): string {
  if (!r.enabled) return t.alertSettings.alerts.notificationsOff;
  const what = r.objects.length ? r.objects.map((o) => t.common.objects[o] ?? o).join(', ') : t.alertSettings.alerts.anything;
  return r.zones.length ? t.alertSettings.alerts.whatWhere(what, r.zones.join(', ').replace(/_/g, ' ')) : what;
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, padding: space.lg },
  chips0: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  row: { flexDirection: 'row', gap: space.md },
});

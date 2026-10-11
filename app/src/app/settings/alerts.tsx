import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { checkForAlerts, registerBackgroundAlerts, requestNotificationPermission } from '@/alerts/background';
import { ruleFor } from '@/alerts/rules';
import { DoorbellPackagesSection, HealthSection, KnownPeopleSection, SnoozedSection } from '@/components/alerts/alert-extras';
import { Button, Chip, Field, Row, Screen, Section, T, ToggleRow } from '@/components/ui/primitives';
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
  const alerts = useApp((s) => s.alerts);
  const setAlerts = useApp((s) => s.setAlerts);
  const setRule = useApp((s) => s.setCameraRule);
  const { entries } = useAllCameras({ includeHidden: true });
  const support = useFeatureSupport();
  const [open, setOpen] = useState<string | null>(null);
  const [testMsg, setTestMsg] = useState<string | null>(null);

  return (
    <Screen>
      <Section title="Delivery" footer={alerts.mode === 'built-in' ? 'iOS schedules background checks, so alerts may arrive several minutes late. Instant Alerts deliver within a second.' : undefined}>
        <View style={styles.chips}>
          <Chip label="Built-in" selected={alerts.mode === 'built-in'} onPress={() => { setAlerts({ mode: 'built-in' }); void registerBackgroundAlerts(); }} />
          <Chip label="Instant Alerts" selected={alerts.mode === 'instant'} onPress={() => { setAlerts({ mode: 'instant' }); void registerBackgroundAlerts(); }} />
        </View>
      </Section>

      <SnoozedSection entries={entries} />

      <DoorbellPackagesSection />

      {support.knownNames && <KnownPeopleSection />}

      <Section title="Quiet hours">
        <ToggleRow
          label="Quiet hours"
          detail="No notifications during this time. Everything is still recorded."
          value={alerts.quietHours.enabled}
          onChange={(enabled) => setAlerts({ quietHours: { ...alerts.quietHours, enabled } })}
          last={!alerts.quietHours.enabled}
        />
        {alerts.quietHours.enabled && (
          <View style={[styles.row, { padding: space.lg }]}>
            <View style={{ flex: 1 }}>
              <Field label="From" value={alerts.quietHours.start} onChangeText={(start) => setAlerts({ quietHours: { ...alerts.quietHours, start } })} placeholder="23:00" />
            </View>
            <View style={{ flex: 1 }}>
              <Field label="To" value={alerts.quietHours.end} onChangeText={(end) => setAlerts({ quietHours: { ...alerts.quietHours, end } })} placeholder="06:30" />
            </View>
          </View>
        )}
      </Section>

      {support.health && <HealthSection />}

      <Section title="Cooldown per camera">
        <View style={styles.chips}>
          {COOLDOWNS.map((c) => (
            <Chip key={c} label={c === 0 ? 'Off' : c < 60 ? `${c}s` : `${c / 60} min`} selected={alerts.cooldownSec === c} onPress={() => setAlerts({ cooldownSec: c })} />
          ))}
        </View>
      </Section>

      <T v="caption" muted style={{ textTransform: 'uppercase', letterSpacing: 0.6, marginLeft: space.xs }}>
        Cameras
      </T>
      {entries.map(({ camera, adapter }) => {
        const rule = ruleFor(alerts, camera.key);
        const custom = !!alerts.rules[camera.key];
        return (
          <Section key={camera.key}>
            <Row
              label={camera.name}
              detail={describe(rule)}
              onPress={() => setOpen(open === camera.key ? null : camera.key)}
              right={<T color={rule.enabled ? p.success : p.textMuted}>{rule.enabled ? 'On' : 'Off'}</T>}
              last={open !== camera.key}
            />
            {open === camera.key && (
              <RuleEditor
                camera={camera}
                rule={rule}
                custom={custom}
                onChange={(r) => setRule(camera.key, r)}
                onReset={() => setRule(camera.key, null)}
                canMask={!!adapter.detectionPoints}
              />
            )}
          </Section>
        );
      })}

      <Button
        title="Check for alerts now"
        kind="secondary"
        onPress={async () => {
          await requestNotificationPermission();
          const n = await checkForAlerts();
          setTestMsg(n ? `Sent ${n} notification${n === 1 ? '' : 's'}.` : 'Nothing new matched your rules.');
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
  canMask,
}: {
  camera: Camera;
  rule: CameraAlertRule;
  custom: boolean;
  onChange: (r: CameraAlertRule) => void;
  onReset: () => void;
  canMask: boolean;
}) {
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const severities: { v: Severity; label: string }[] = [
    { v: 'alert', label: 'Important (people, cars…)' },
    { v: 'detection', label: 'Other motion' },
  ];
  return (
    <View style={{ padding: space.lg, gap: space.md }}>
      <ToggleRow label="Notify for this camera" value={rule.enabled} onChange={(enabled) => onChange({ ...rule, enabled })} last />
      <T v="label" muted>
        Notify me for
      </T>
      <View style={styles.chips0}>
        {severities.map((s) => (
          <Chip key={s.v} label={s.label} selected={rule.severities.includes(s.v)} onPress={() => onChange({ ...rule, severities: toggle(rule.severities, s.v) })} />
        ))}
      </View>
      <T v="label" muted>
        What {rule.objects.length === 0 ? '(anything)' : ''}
      </T>
      <View style={styles.chips0}>
        {camera.objects.map((o) => (
          <Chip key={o} label={labelFor([o])} selected={rule.objects.includes(o)} onPress={() => onChange({ ...rule, objects: toggle(rule.objects, o) })} />
        ))}
      </View>
      {camera.zones.length > 0 && (
        <>
          <T v="label" muted>
            Where {rule.zones.length === 0 ? '(anywhere)' : ''}
          </T>
          <View style={styles.chips0}>
            {camera.zones.map((z) => (
              <Chip key={z} label={z.replace(/_/g, ' ')} selected={rule.zones.includes(z)} onPress={() => onChange({ ...rule, zones: toggle(rule.zones, z) })} />
            ))}
          </View>
        </>
      )}
      {canMask ? (
        <MaskButton cameraKey={camera.key} />
      ) : (
        <T v="caption" muted>
          To ignore part of this camera’s view (like the street), set up motion zones in the camera’s or recorder’s own app.
        </T>
      )}
      {custom && <Button title="Use default rule" kind="ghost" onPress={onReset} />}
    </View>
  );
}

function MaskButton({ cameraKey }: { cameraKey: string }) {
  const count = useApp((s) => s.masks[cameraKey]?.length ?? 0);
  return (
    <Button
      title={count ? `Ignored areas (${count})` : 'Ignore an area of the picture'}
      kind="secondary"
      onPress={() => router.push({ pathname: '/settings/masks', params: { key: cameraKey } })}
    />
  );
}

function describe(r: CameraAlertRule): string {
  if (!r.enabled) return 'Notifications off';
  const what = r.objects.length ? r.objects.join(', ') : 'anything';
  const where = r.zones.length ? ` in ${r.zones.join(', ').replace(/_/g, ' ')}` : '';
  return `${what}${where}`;
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, padding: space.lg },
  chips0: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  row: { flexDirection: 'row', gap: space.md },
});

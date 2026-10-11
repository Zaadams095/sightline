import { useQuery } from '@tanstack/react-query';
import { StyleSheet, View } from 'react-native';

import { syncPackageReminder } from '@/alerts/packages-notify';
import { Chip, Row, Section, T, ToggleRow } from '@/components/ui/primitives';
import { familiarNames, useFamiliar } from '@/familiar/store';
import { fmtTime } from '@/i18n';
import { useT } from '@/i18n/use-t';
import { useLinks } from '@/net/connection';
import { useApp } from '@/state/store';
import { getAdapter, type CameraEntry } from '@/systems/registry';
import { space } from '@/theme/tokens';
import { formatClock, nowSec } from '@/util/format';
import { LiveActivity } from '@modules/live-activity';

const STORAGE_LEVELS = [80, 90, 95];

/** Live Activities: only on iPhone builds that include them. */
export function LockScreenSection() {
  const t = useT();
  const k = t.alertSettings.extras;
  const lockScreen = useApp((s) => s.alerts.lockScreen);
  const setAlerts = useApp((s) => s.setAlerts);
  if (!LiveActivity) return null;
  return (
    <Section footer={k.lockFooter}>
      <ToggleRow
        label={k.lockLabel}
        detail={k.lockDetail}
        value={lockScreen}
        onChange={(v) => setAlerts({ lockScreen: v })}
        last
      />
    </Section>
  );
}

/** "Don't alert for these people/cars": names your system can recognize (faces, known plates). */
export function KnownPeopleSection() {
  const t = useT();
  const k = t.alertSettings.extras;
  const systems = useApp((s) => s.systems);
  const links = useLinks((s) => s.links);
  const quietFor = useApp((s) => s.alerts.quietFor);
  const setAlerts = useApp((s) => s.setAlerts);

  const names = useQuery({
    queryKey: ['known-names', systems.map((s) => `${s.id}@${links[s.id]?.baseUrl}`).join('|')],
    staleTime: 10 * 60_000,
    queryFn: async () => {
      const lists = await Promise.allSettled(systems.map((s) => getAdapter(s, links[s.id])?.knownNames?.() ?? Promise.resolve([])));
      return [...new Set(lists.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])))].sort();
    },
  });

  // Names recognized on this iPhone (People & vehicles) work the same as the system's own.
  const identities = useFamiliar((s) => s.identities);
  const alwaysFor = useApp((s) => s.alerts.alwaysFor) ?? NO_NAMES;
  const all = [...new Set([...(names.data ?? []), ...familiarNames(identities), ...quietFor, ...alwaysFor])].sort();
  const toggle = (n: string) =>
    setAlerts({
      quietFor: quietFor.includes(n) ? quietFor.filter((x) => x !== n) : [...quietFor, n],
      alwaysFor: alwaysFor.filter((x) => x !== n),
    });
  const toggleAlways = (n: string) =>
    setAlerts({
      alwaysFor: alwaysFor.includes(n) ? alwaysFor.filter((x) => x !== n) : [...alwaysFor, n],
      quietFor: quietFor.filter((x) => x !== n),
    });

  return (
    <>
      <Section title={k.knownTitle} footer={all.length ? k.knownFooterSome : k.knownFooterNone}>
        <View style={styles.chips}>
          {all.length === 0 && <T muted>{names.isLoading ? t.common.loading : k.noNames}</T>}
          {all.map((n) => (
            <Chip key={n} label={n} selected={quietFor.includes(n)} onPress={() => toggle(n)} />
          ))}
        </View>
      </Section>
      {all.length > 0 && (
        <Section title={k.alwaysTitle} footer={k.alwaysFooter}>
          <View style={styles.chips}>
            {all.map((n) => (
              <Chip key={n} label={n} selected={alwaysFor.includes(n)} onPress={() => toggleAlways(n)} />
            ))}
          </View>
        </Section>
      )}
    </>
  );
}

const NO_NAMES: string[] = [];

/** Cameras currently snoozed, with a way to resume early. */
export function SnoozedSection({ entries }: { entries: CameraEntry[] }) {
  const t = useT();
  const k = t.alertSettings.extras;
  const snoozed = useApp((s) => s.alerts.snoozed);
  const snooze = useApp((s) => s.snooze);
  const now = nowSec();
  const active = Object.entries(snoozed).filter(([, until]) => until > now);
  if (!active.length) return null;
  const nameOf = (key: string) => entries.find((e) => e.camera.key === key)?.camera.name ?? key;
  return (
    <Section title={k.snoozed}>
      {active.map(([key, until], i) => (
        <Row
          key={key}
          label={nameOf(key)}
          detail={k.mutedUntil(formatClock(until))}
          right={<Chip label={k.resume} selected={false} onPress={() => snooze(key, null)} />}
          last={i === active.length - 1}
        />
      ))}
    </Section>
  );
}

const REMINDER_TIMES = ['17:00', '18:00', '19:00', '20:00', '21:00'];

/** Doorbell call screen and package alerts (any system that reports rings / packages). */
export function DoorbellPackagesSection() {
  const t = useT();
  const k = t.alertSettings.extras;
  const doorbell = useApp((s) => s.alerts.doorbell);
  const packages = useApp((s) => s.alerts.packages);
  const setAlerts = useApp((s) => s.setAlerts);
  const setPackages = (p: Partial<typeof packages>) => {
    setAlerts({ packages: { ...packages, ...p } });
    void syncPackageReminder();
  };
  return (
    <Section title={k.doorbellTitle} footer={k.doorbellFooter}>
      <ToggleRow
        label={k.fullScreen}
        detail={k.fullScreenDetail}
        value={doorbell.fullScreen}
        onChange={(fullScreen) => setAlerts({ doorbell: { ...doorbell, fullScreen } })}
      />
      <ToggleRow
        label={k.packages}
        detail={k.packagesDetail}
        value={packages.enabled}
        onChange={(enabled) => setPackages({ enabled })}
        last={!packages.enabled}
      />
      {packages.enabled && (
        <ToggleRow
          label={k.reminder}
          detail={k.reminderDetail}
          value={packages.reminder}
          onChange={(reminder) => setPackages({ reminder })}
          last={!packages.reminder}
        />
      )}
      {packages.enabled && packages.reminder && (
        <View style={[styles.chips, { paddingTop: space.sm }]}>
          {REMINDER_TIMES.map((hhmm) => (
            <Chip
              key={hhmm}
              label={fmtTime(new Date(2000, 0, 1, Number(hhmm.slice(0, 2)), 0))}
              selected={packages.reminderTime === hhmm}
              onPress={() => setPackages({ reminderTime: hhmm })}
            />
          ))}
        </View>
      )}
    </Section>
  );
}

export function HealthSection() {
  const t = useT();
  const k = t.alertSettings.extras;
  const health = useApp((s) => s.alerts.health);
  const setAlerts = useApp((s) => s.setAlerts);
  return (
    <Section title={k.healthTitle} footer={k.healthFooter}>
      <ToggleRow
        label={k.healthLabel}
        value={health.enabled}
        onChange={(enabled) => setAlerts({ health: { ...health, enabled } })}
        last={!health.enabled}
      />
      {health.enabled && (
        <View style={[styles.chips, { paddingTop: 0 }]}>
          <T muted style={{ width: '100%' }}>
            {k.warnWhen}
          </T>
          {STORAGE_LEVELS.map((pct) => (
            <Chip
              key={pct}
              label={k.pctFull(pct)}
              selected={health.storagePct === pct}
              onPress={() => setAlerts({ health: { ...health, storagePct: pct } })}
            />
          ))}
        </View>
      )}
    </Section>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, padding: space.lg },
});

import { useQuery } from '@tanstack/react-query';
import { StyleSheet, View } from 'react-native';

import { Chip, Row, Section, T, ToggleRow } from '@/components/ui/primitives';
import { useLinks } from '@/net/connection';
import { useApp } from '@/state/store';
import { getAdapter, type CameraEntry } from '@/systems/registry';
import { space } from '@/theme/tokens';
import { formatClock, nowSec } from '@/util/format';

const STORAGE_LEVELS = [80, 90, 95];

/** "Don't alert for these people/cars": names your system can recognize (faces, known plates). */
export function KnownPeopleSection() {
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

  const all = [...new Set([...(names.data ?? []), ...quietFor])].sort();
  const toggle = (n: string) =>
    setAlerts({ quietFor: quietFor.includes(n) ? quietFor.filter((x) => x !== n) : [...quietFor, n] });

  return (
    <Section
      title="Known people & cars"
      footer={
        all.length
          ? 'Selected names never trigger alerts. Anyone your system doesn’t recognize still alerts.'
          : 'If your system recognizes faces or license plates, their names appear here so family and your own cars don’t set off alerts.'
      }>
      <View style={styles.chips}>
        {all.length === 0 && <T muted>{names.isLoading ? 'Loading…' : 'No recognized names yet'}</T>}
        {all.map((n) => (
          <Chip key={n} label={n} selected={quietFor.includes(n)} onPress={() => toggle(n)} />
        ))}
      </View>
    </Section>
  );
}

/** Cameras currently snoozed, with a way to resume early. */
export function SnoozedSection({ entries }: { entries: CameraEntry[] }) {
  const snoozed = useApp((s) => s.alerts.snoozed);
  const snooze = useApp((s) => s.snooze);
  const now = nowSec();
  const active = Object.entries(snoozed).filter(([, until]) => until > now);
  if (!active.length) return null;
  const nameOf = (key: string) => entries.find((e) => e.camera.key === key)?.camera.name ?? key;
  return (
    <Section title="Snoozed">
      {active.map(([key, until], i) => (
        <Row
          key={key}
          label={nameOf(key)}
          detail={`Muted until ${formatClock(until)}`}
          right={<Chip label="Resume" selected={false} onPress={() => snooze(key, null)} />}
          last={i === active.length - 1}
        />
      ))}
    </Section>
  );
}

export function HealthSection() {
  const health = useApp((s) => s.alerts.health);
  const setAlerts = useApp((s) => s.setAlerts);
  return (
    <Section
      title="System health"
      footer="Alerts once when a camera goes offline, storage runs low, or the recorder stops answering, and again only after it recovers.">
      <ToggleRow
        label="Health alerts"
        value={health.enabled}
        onChange={(enabled) => setAlerts({ health: { ...health, enabled } })}
        last={!health.enabled}
      />
      {health.enabled && (
        <View style={[styles.chips, { paddingTop: 0 }]}>
          <T muted style={{ width: '100%' }}>
            Warn when storage is
          </T>
          {STORAGE_LEVELS.map((pct) => (
            <Chip
              key={pct}
              label={`${pct}% full`}
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

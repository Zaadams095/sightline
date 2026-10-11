import { router } from 'expo-router';
import { useMemo } from 'react';

import { learnRules } from '@/alerts/learning';
import { Row, Section, ToggleRow } from '@/components/ui/primitives';
import { useT } from '@/i18n/use-t';
import { useSmart } from '@/state/smart';
import { nowSec } from '@/util/format';

/** Settings → Alerts: rain/wind/headlights, what Sightline learned, and family check-ins. */
export function SmartAlertsSection() {
  const t = useT();
  const k = t.alertSettings.smart;
  const conditions = useSmart((s) => s.conditions);
  const setConditions = useSmart((s) => s.setConditions);
  const learning = useSmart((s) => s.learning);
  const checkins = useSmart((s) => s.checkins);
  const rules = useMemo(() => learnRules(learning, nowSec()), [learning]);
  const waiting = rules.filter((r) => r.needsConfirm && !r.confirmed).length;

  return (
    <Section title={k.title} footer={k.footer}>
      <ToggleRow
        label={k.ignoreWeather}
        detail={k.ignoreWeatherDetail}
        value={conditions}
        onChange={setConditions}
      />
      <Row
        label={k.learned}
        detail={
          rules.length === 0
            ? k.nothingYet
            : waiting
              ? k.itemsWaiting(rules.length, waiting)
              : k.items(rules.length)
        }
        onPress={() => router.push('/settings/learned')}
      />
      <Row
        label={k.checkins}
        detail={checkins.length ? k.checkinCount(checkins.length) : k.checkinEmpty}
        onPress={() => router.push('/settings/checkins')}
        last
      />
    </Section>
  );
}

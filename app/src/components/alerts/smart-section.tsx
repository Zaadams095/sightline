import { router } from 'expo-router';
import { useMemo } from 'react';

import { learnRules } from '@/alerts/learning';
import { Row, Section, ToggleRow } from '@/components/ui/primitives';
import { useSmart } from '@/state/smart';
import { nowSec } from '@/util/format';

/** Settings → Alerts: rain/wind/headlights, what Sightline learned, and family check-ins. */
export function SmartAlertsSection() {
  const conditions = useSmart((s) => s.conditions);
  const setConditions = useSmart((s) => s.setConditions);
  const learning = useSmart((s) => s.learning);
  const checkins = useSmart((s) => s.checkins);
  const rules = useMemo(() => learnRules(learning, nowSec()), [learning]);
  const waiting = rules.filter((r) => r.needsConfirm && !r.confirmed).length;

  return (
    <Section
      title="Fewer false alarms"
      footer="Long-press an alert and choose “Not important” (or use the thumbs in Recordings). After a few of the same kind, Sightline stops alerting for them. Doorbell rings always come through, and people are only quieted if you say so.">
      <ToggleRow
        label="Ignore likely rain, wind and headlights"
        detail="Motion with nothing detected that hits several cameras at once, or blinks by at night. People, cars and animals still alert."
        value={conditions}
        onChange={setConditions}
      />
      <Row
        label="What Sightline learned"
        detail={
          rules.length === 0
            ? 'Nothing yet'
            : waiting
              ? `${rules.length} item${rules.length === 1 ? '' : 's'} · ${waiting} waiting for you`
              : `${rules.length} item${rules.length === 1 ? '' : 's'}`
        }
        onPress={() => router.push('/settings/learned')}
      />
      <Row
        label="Family check-ins"
        detail={checkins.length ? `${checkins.length} check-in${checkins.length === 1 ? '' : 's'}` : 'Hear if there’s no activity at a loved one’s home'}
        onPress={() => router.push('/settings/checkins')}
        last
      />
    </Section>
  );
}

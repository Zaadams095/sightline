import { useQuery } from '@tanstack/react-query';
import { router, Stack } from 'expo-router';
import { View } from 'react-native';

import { hubCheckinStates } from '@/alerts/bridge';
import { placeName, statusText, type CheckInState } from '@/alerts/checkins';
import { runsOnHub } from '@/alerts/checkins-run';
import { Button, Card, Row, Screen, Section, T } from '@/components/ui/primitives';
import { useT } from '@/i18n/use-t';
import { useSmart } from '@/state/smart';
import { space } from '@/theme/tokens';
import { nowSec } from '@/util/format';

/** Settings → Alerts → Family check-ins. */
export default function CheckinsScreen() {
  const t = useT();
  const k = t.alertSettings.checkins;
  const checkins = useSmart((s) => s.checkins);
  const local = useSmart((s) => s.checkinStates);
  const hubSystems = [...new Set(checkins.filter(runsOnHub).map((c) => c.systemId))];

  // The Hub's own view of today (it's the one watching), falling back to the phone's.
  const remote = useQuery({
    queryKey: ['checkin-states', hubSystems.join('|')],
    enabled: hubSystems.length > 0,
    refetchInterval: 60_000,
    queryFn: async () => {
      const out: Record<string, CheckInState> = {};
      for (const id of hubSystems) Object.assign(out, await hubCheckinStates(id).catch(() => ({})));
      return out;
    },
  });

  const now = nowSec();
  return (
    <Screen>
      <Stack.Screen options={{ title: k.title }} />
      {checkins.length === 0 ? (
        <Card>
          <View style={{ gap: space.sm }}>
            <T v="heading">{k.emptyTitle}</T>
            <T muted>{k.emptyBody}</T>
          </View>
        </Card>
      ) : (
        <Section footer={k.footer}>
          {[...checkins]
            .sort((a, b) => placeName(a).localeCompare(placeName(b)))
            .map((c, i, all) => (
              <Row
                key={c.id}
                label={c.enabled ? placeName(c) : k.off(placeName(c))}
                detail={statusText(c, remote.data?.[c.id] ?? local[c.id], now)}
                onPress={() => router.push({ pathname: '/settings/checkin', params: { id: c.id } })}
                last={i === all.length - 1}
              />
            ))}
        </Section>
      )}
      <Button title={k.add} onPress={() => router.push({ pathname: '/settings/checkin', params: { id: 'new' } })} />
    </Screen>
  );
}

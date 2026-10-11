import { Stack } from 'expo-router';
import { useState } from 'react';
import { Switch, View } from 'react-native';

import { Button, Row, Screen, Section, T } from '@/components/ui/primitives';
import { useT } from '@/i18n/use-t';
import { disableHomeAway, overrideAtHome, setHomeHere } from '@/presence/geofence';
import { useApp } from '@/state/store';
import { useAllCameras } from '@/systems/registry';
import { usePalette } from '@/theme/use-palette';

export default function HomeAwaySettings() {
  const p = usePalette();
  const t = useT();
  const ha = t.alertSettings.homeAway;
  const presence = useApp((s) => s.alerts.presence);
  const setAlerts = useApp((s) => s.setAlerts);
  const { entries } = useAllCameras({ includeHidden: true });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const toggleCamera = (key: string) =>
    setAlerts({
      presence: {
        ...presence,
        alertWhenHome: presence.alertWhenHome.includes(key)
          ? presence.alertWhenHome.filter((k) => k !== key)
          : [...presence.alertWhenHome, key],
      },
    });

  const setHome = async () => {
    setBusy(true);
    setMsg(await setHomeHere().catch((e) => (e instanceof Error ? e.message : String(e))));
    setBusy(false);
  };

  return (
    <Screen>
      <Stack.Screen options={{ title: ha.title }} />
      <T muted>{ha.intro}</T>

      {!presence.enabled || !presence.home ? (
        <Button title={busy ? ha.gettingLocation : ha.setHome} onPress={setHome} loading={busy} />
      ) : (
        <Section title={ha.status}>
          <Row
            label={presence.atHome ? ha.youreHome : ha.youreAway}
            detail={presence.atHome ? ha.onlySelected : ha.allNormal}
            right={<T color={presence.atHome ? p.success : p.accent}>{presence.atHome ? ha.home : ha.away}</T>}
          />
          <Row
            label={presence.atHome ? ha.switchAway : ha.switchHome}
            detail={ha.switchDetail}
            onPress={() => void overrideAtHome(!presence.atHome)}
          />
          <Row label={ha.moveHome} onPress={setHome} />
          <Row label={ha.turnOff} destructive onPress={() => void disableHomeAway()} last />
        </Section>
      )}
      {msg && <T color={p.danger}>{msg}</T>}

      <Section title={ha.keepAlerting} footer={ha.keepFooter}>
        {entries.map((e, i) => (
          <Row
            key={e.camera.key}
            label={e.camera.name}
            last={i === entries.length - 1}
            right={
              <Switch
                value={presence.alertWhenHome.includes(e.camera.key)}
                onValueChange={() => toggleCamera(e.camera.key)}
                trackColor={{ true: p.accent }}
              />
            }
          />
        ))}
        {entries.length === 0 && (
          <View style={{ padding: 16 }}>
            <T muted>{ha.noCameras}</T>
          </View>
        )}
      </Section>
    </Screen>
  );
}

import { useState } from 'react';
import { Switch, View } from 'react-native';

import { Button, Row, Screen, Section, T } from '@/components/ui/primitives';
import { disableHomeAway, overrideAtHome, setHomeHere } from '@/presence/geofence';
import { useApp } from '@/state/store';
import { useAllCameras } from '@/systems/registry';
import { usePalette } from '@/theme/use-palette';

export default function HomeAwaySettings() {
  const p = usePalette();
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
      <T muted>
        When you&apos;re home, Sightline quiets alerts except from the cameras you choose below (like the doorbell). Your
        location stays on your phone; only &quot;home&quot; or &quot;away&quot; is shared with your Instant Alerts bridge.
      </T>

      {!presence.enabled || !presence.home ? (
        <Button title={busy ? 'Getting location…' : 'I’m home now: set this as home'} onPress={setHome} loading={busy} />
      ) : (
        <Section title="Status">
          <Row
            label={presence.atHome ? 'You’re home' : 'You’re away'}
            detail={presence.atHome ? 'Only selected cameras alert' : 'All cameras alert normally'}
            right={<T color={presence.atHome ? p.success : p.accent}>{presence.atHome ? 'Home' : 'Away'}</T>}
          />
          <Row
            label={presence.atHome ? 'Switch to Away for now' : 'Switch to Home for now'}
            detail="Changes back automatically the next time you arrive or leave."
            onPress={() => void overrideAtHome(!presence.atHome)}
          />
          <Row label="Move home to my current location" onPress={setHome} />
          <Row label="Turn off Home/Away" destructive onPress={() => void disableHomeAway()} last />
        </Section>
      )}
      {msg && <T color={p.danger}>{msg}</T>}

      <Section title="Keep alerting while I'm home" footer="Cameras not checked stay quiet while you’re home.">
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
            <T muted>No cameras yet</T>
          </View>
        )}
      </Section>
    </Screen>
  );
}

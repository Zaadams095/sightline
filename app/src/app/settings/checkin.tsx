import * as Crypto from 'expo-crypto';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';

import { DEFAULT_CHECKIN, okLabel, placeName, type CheckIn } from '@/alerts/checkins';
import { runsOnHub } from '@/alerts/checkins-run';
import { clockText, parseHHMM } from '@/alerts/clock';
import { deviceTimezone } from '@/alerts/smart';
import { Button, Chip, Field, Section, Screen, T, TimeStepper, ToggleRow } from '@/components/ui/primitives';
import { useApp } from '@/state/store';
import { useSmart } from '@/state/smart';
import { useAllCameras } from '@/systems/registry';
import { space } from '@/theme/tokens';

const QUIET_HOURS = [2, 3, 4, 6, 8];

/** Add or edit one family check-in. */
export default function CheckinEditor() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const systems = useApp((s) => s.systems);
  const existing = useSmart((s) => s.checkins.find((c) => c.id === id));
  const save = useSmart((s) => s.saveCheckin);
  const remove = useSmart((s) => s.deleteCheckin);
  const { entries } = useAllCameras({ includeHidden: true });

  // A Hub is the natural home for a check-in (it watches all day), so it's the default.
  const firstSystem = systems.find((s) => s.kind === 'hub') ?? systems[0];
  const [c, setC] = useState<CheckIn>(
    () =>
      existing ?? {
        ...DEFAULT_CHECKIN,
        id: Crypto.randomUUID(),
        systemId: firstSystem?.id ?? '',
        timezone: firstSystem?.extra?.timezone || deviceTimezone(),
      },
  );
  const set = (p: Partial<CheckIn>) => setC((x) => ({ ...x, ...p }));
  const system = systems.find((s) => s.id === c.systemId);
  const cams = useMemo(() => entries.filter((e) => e.camera.systemId === c.systemId).map((e) => e.camera), [entries, c.systemId]);
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const hub = runsOnHub(c);
  const theirZone = system?.extra?.timezone;
  const mine = deviceTimezone();

  const pickSystem = (systemId: string) => {
    const s = systems.find((x) => x.id === systemId);
    set({ systemId, cameras: [], zones: {}, timezone: s?.extra?.timezone || mine });
  };

  const onSave = () => {
    if (!c.cameras.length) {
      Alert.alert('Pick at least one camera', 'Choose the cameras that show everyday life, like the kitchen or hallway.');
      return;
    }
    if (!c.byTime && !c.quietLimitHours && !c.summaryTime) {
      Alert.alert('Choose when to hear from Sightline', 'Turn on at least one: no activity by a time, a long quiet stretch, or the daily summary.');
      return;
    }
    const names = Object.fromEntries(cams.filter((cam) => c.cameras.includes(cam.id)).map((cam) => [cam.id, cam.name]));
    save({ ...c, cameraNames: names, place: system?.name, who: c.who.trim(), phone: c.phone?.trim() || undefined });
    router.back();
  };

  return (
    <Screen>
      <Section title="Who" footer={c.who.trim() ? `Notifications say “${placeName(c)}”, with buttons like “${okLabel(c)}”.` : 'For example “Mom” or “Grandpa”.'}>
        <View style={styles.pad}>
          <Field label="Who lives there?" value={c.who} onChangeText={(who) => set({ who })} placeholder="Mom" autoCapitalize="words" />
          <Field
            label="Phone number (optional)"
            hint={`Adds a “Call ${c.who.trim() || 'them'}” button to the notification.`}
            value={c.phone ?? ''}
            onChangeText={(phone) => set({ phone })}
            keyboardType="phone-pad"
            placeholder="(555) 123-4567"
          />
        </View>
      </Section>

      {systems.length > 1 && (
        <Section title="Home">
          <View style={styles.chips}>
            {systems.map((s) => (
              <Chip key={s.id} label={s.name} selected={s.id === c.systemId} onPress={() => pickSystem(s.id)} />
            ))}
          </View>
        </Section>
      )}

      <Section title="Cameras that show everyday life" footer="Only cameras you’re allowed to see are listed. Pick rooms they pass through every day.">
        <View style={styles.chips}>
          {cams.length === 0 && <T muted>No cameras from this system are connected right now.</T>}
          {cams.map((cam) => (
            <Chip key={cam.id} label={cam.name} selected={c.cameras.includes(cam.id)} onPress={() => set({ cameras: toggle(c.cameras, cam.id) })} />
          ))}
        </View>
        {cams
          .filter((cam) => c.cameras.includes(cam.id) && cam.zones.length > 0)
          .map((cam) => (
            <View key={cam.id} style={[styles.pad, { gap: space.sm }]}>
              <T v="label" muted>
                {cam.name}: only count {(c.zones[cam.id] ?? []).length ? '' : '(the whole picture)'}
              </T>
              <View style={styles.chips0}>
                {cam.zones.map((z) => (
                  <Chip
                    key={z}
                    label={z.replace(/_/g, ' ')}
                    selected={(c.zones[cam.id] ?? []).includes(z)}
                    onPress={() => set({ zones: { ...c.zones, [cam.id]: toggle(c.zones[cam.id] ?? [], z) } })}
                  />
                ))}
              </View>
            </View>
          ))}
        <ToggleRow
          label="Only count people"
          detail="Otherwise any movement counts, which could include a pet."
          value={c.peopleOnly}
          onChange={(peopleOnly) => set({ peopleOnly })}
          last
        />
      </Section>

      <Section title="Let me know if">
        <ToggleRow
          label="There’s no activity by"
          value={!!c.byTime}
          onChange={(v) => set({ byTime: v ? '10:00' : null })}
          last={!c.byTime}
        />
        {c.byTime && <TimeStepper label="Time" value={c.byTime} onChange={(byTime) => set({ byTime })} last />}
      </Section>

      <Section>
        <ToggleRow
          label="It’s quiet for a long time during the day"
          value={!!c.quietLimitHours}
          onChange={(v) => set({ quietLimitHours: v ? 6 : null })}
          last={!c.quietLimitHours}
        />
        {!!c.quietLimitHours && (
          <>
            <View style={styles.chips}>
              {QUIET_HOURS.map((h) => (
                <Chip key={h} label={`${h} hours`} selected={c.quietLimitHours === h} onPress={() => set({ quietLimitHours: h })} />
              ))}
            </View>
            <TimeStepper label="Day starts" value={c.dayStart} onChange={(dayStart) => set({ dayStart })} />
            <TimeStepper label="Day ends" value={c.dayEnd} onChange={(dayEnd) => set({ dayEnd })} last />
          </>
        )}
      </Section>

      <Section footer={c.summaryTime ? `For example: “All normal at ${placeName(c)}: first activity 7:42 AM · 23 moments today.”` : undefined}>
        <ToggleRow
          label="Daily “All normal” summary"
          value={!!c.summaryTime}
          onChange={(v) => set({ summaryTime: v ? '20:00' : null })}
          last={!c.summaryTime}
        />
        {c.summaryTime && <TimeStepper label="Send at" value={c.summaryTime} onChange={(summaryTime) => set({ summaryTime })} last />}
      </Section>

      <Section footer="Check-ins ignore Home & Away and snoozed cameras: they’re about their home, not yours.">
        <ToggleRow
          label="Come through during my quiet hours"
          detail={c.duringQuietHours ? 'With normal sound, even when Focus is on.' : 'Waits until your quiet hours end.'}
          value={c.duringQuietHours}
          onChange={(duringQuietHours) => set({ duringQuietHours })}
          last={!(theirZone && theirZone !== mine)}
        />
        {theirZone && theirZone !== mine && (
          <View style={styles.chips}>
            <Chip label={`Their time (${theirZone})`} selected={c.timezone === theirZone} onPress={() => set({ timezone: theirZone })} />
            <Chip label="My time" selected={c.timezone === mine} onPress={() => set({ timezone: mine })} />
          </View>
        )}
      </Section>

      <T v="caption" muted style={{ marginHorizontal: space.xs }}>
        {hub || system?.kind === 'hub'
          ? 'Your Sightline Hub watches around the clock, even when your phone is off, and double-checks with the recorder before saying there’s been no activity.'
          : `Without a Sightline Hub, iPhone decides when Sightline can check, so a check-in can arrive late.${c.byTime ? ` If Sightline couldn’t check by ${clockText(...parseHHMM(c.byTime))}, it reminds you to look.` : ''}`}
      </T>

      {existing && (
        <Section>
          <ToggleRow label="Check-in is on" value={c.enabled} onChange={(enabled) => set({ enabled })} last />
        </Section>
      )}
      <Button title="Save" onPress={onSave} />
      {existing && (
        <Button
          title="Delete check-in"
          kind="ghost"
          onPress={() =>
            Alert.alert('Delete this check-in?', undefined, [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Delete',
                style: 'destructive',
                onPress: () => {
                  remove(c.id);
                  router.back();
                },
              },
            ])
          }
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  pad: { padding: space.lg, gap: space.md },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, padding: space.lg },
  chips0: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
});

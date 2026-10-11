import * as Crypto from 'expo-crypto';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';

import { DEFAULT_CHECKIN, okLabel, placeName, type CheckIn } from '@/alerts/checkins';
import { runsOnHub } from '@/alerts/checkins-run';
import { parseHHMM } from '@/alerts/clock';
import { deviceTimezone } from '@/alerts/smart';
import { Button, Chip, Field, Section, Screen, T, TimeStepper, ToggleRow } from '@/components/ui/primitives';
import { fmtTime } from '@/i18n';
import { useT } from '@/i18n/use-t';
import { useApp } from '@/state/store';
import { useSmart } from '@/state/smart';
import { useAllCameras } from '@/systems/registry';
import { space } from '@/theme/tokens';

const QUIET_HOURS = [2, 3, 4, 6, 8];

/** "9:15 PM" / "21:15" for an "HH:MM" setting, in the app's language. */
const hhmmText = (hhmm: string) => {
  const [h, m] = parseHHMM(hhmm);
  return fmtTime(new Date(2000, 0, 1, h, m));
};

/** Add or edit one family check-in. */
export default function CheckinEditor() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useT();
  const k = t.alertSettings.checkin;
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
      Alert.alert(k.pickCamera, k.pickCameraBody);
      return;
    }
    if (!c.byTime && !c.quietLimitHours && !c.summaryTime) {
      Alert.alert(k.chooseWhen, k.chooseWhenBody);
      return;
    }
    const names = Object.fromEntries(cams.filter((cam) => c.cameras.includes(cam.id)).map((cam) => [cam.id, cam.name]));
    save({ ...c, cameraNames: names, place: system?.name, who: c.who.trim(), phone: c.phone?.trim() || undefined });
    router.back();
  };

  return (
    <Screen>
      <Stack.Screen options={{ title: k.title }} />
      <Section title={k.who} footer={c.who.trim() ? k.whoFooter(placeName(c), okLabel(c)) : k.whoExample}>
        <View style={styles.pad}>
          <Field label={k.whoLabel} value={c.who} onChangeText={(who) => set({ who })} placeholder={k.whoPlaceholder} autoCapitalize="words" />
          <Field
            label={k.phone}
            hint={k.phoneHint(c.who.trim() || k.them)}
            value={c.phone ?? ''}
            onChangeText={(phone) => set({ phone })}
            keyboardType="phone-pad"
            placeholder={k.phonePlaceholder}
          />
        </View>
      </Section>

      {systems.length > 1 && (
        <Section title={k.home}>
          <View style={styles.chips}>
            {systems.map((s) => (
              <Chip key={s.id} label={s.name} selected={s.id === c.systemId} onPress={() => pickSystem(s.id)} />
            ))}
          </View>
        </Section>
      )}

      <Section title={k.camerasTitle} footer={k.camerasFooter}>
        <View style={styles.chips}>
          {cams.length === 0 && <T muted>{k.noCameras}</T>}
          {cams.map((cam) => (
            <Chip key={cam.id} label={cam.name} selected={c.cameras.includes(cam.id)} onPress={() => set({ cameras: toggle(c.cameras, cam.id) })} />
          ))}
        </View>
        {cams
          .filter((cam) => c.cameras.includes(cam.id) && cam.zones.length > 0)
          .map((cam) => (
            <View key={cam.id} style={[styles.pad, { gap: space.sm }]}>
              <T v="label" muted>
                {(c.zones[cam.id] ?? []).length ? k.onlyCount(cam.name) : k.onlyCountWhole(cam.name)}
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
          label={k.peopleOnly}
          detail={k.peopleOnlyDetail}
          value={c.peopleOnly}
          onChange={(peopleOnly) => set({ peopleOnly })}
          last
        />
      </Section>

      <Section title={k.letMeKnow}>
        <ToggleRow
          label={k.noActivityBy}
          value={!!c.byTime}
          onChange={(v) => set({ byTime: v ? '10:00' : null })}
          last={!c.byTime}
        />
        {c.byTime && <TimeStepper label={k.time} value={c.byTime} onChange={(byTime) => set({ byTime })} last />}
      </Section>

      <Section>
        <ToggleRow
          label={k.quietLong}
          value={!!c.quietLimitHours}
          onChange={(v) => set({ quietLimitHours: v ? 6 : null })}
          last={!c.quietLimitHours}
        />
        {!!c.quietLimitHours && (
          <>
            <View style={styles.chips}>
              {QUIET_HOURS.map((h) => (
                <Chip key={h} label={t.common.hours(h)} selected={c.quietLimitHours === h} onPress={() => set({ quietLimitHours: h })} />
              ))}
            </View>
            <TimeStepper label={k.dayStarts} value={c.dayStart} onChange={(dayStart) => set({ dayStart })} />
            <TimeStepper label={k.dayEnds} value={c.dayEnd} onChange={(dayEnd) => set({ dayEnd })} last />
          </>
        )}
      </Section>

      <Section footer={c.summaryTime ? k.summaryExample(t.alerts.checkins.allNormal(placeName(c)), hhmmText('7:42')) : undefined}>
        <ToggleRow
          label={k.summary}
          value={!!c.summaryTime}
          onChange={(v) => set({ summaryTime: v ? '20:00' : null })}
          last={!c.summaryTime}
        />
        {c.summaryTime && <TimeStepper label={k.sendAt} value={c.summaryTime} onChange={(summaryTime) => set({ summaryTime })} last />}
      </Section>

      <Section footer={k.ignoresFooter}>
        <ToggleRow
          label={k.duringQuiet}
          detail={c.duringQuietHours ? k.duringQuietOn : k.duringQuietOff}
          value={c.duringQuietHours}
          onChange={(duringQuietHours) => set({ duringQuietHours })}
          last={!(theirZone && theirZone !== mine)}
        />
        {theirZone && theirZone !== mine && (
          <View style={styles.chips}>
            <Chip label={k.theirTime(theirZone)} selected={c.timezone === theirZone} onPress={() => set({ timezone: theirZone })} />
            <Chip label={k.myTime} selected={c.timezone === mine} onPress={() => set({ timezone: mine })} />
          </View>
        )}
      </Section>

      <T v="caption" muted style={{ marginHorizontal: space.xs }}>
        {hub || system?.kind === 'hub'
          ? k.hubNote
          : `${k.noHubNote}${c.byTime ? ` ${k.couldntCheck(hhmmText(c.byTime))}` : ''}`}
      </T>

      {existing && (
        <Section>
          <ToggleRow label={k.isOn} value={c.enabled} onChange={(enabled) => set({ enabled })} last />
        </Section>
      )}
      <Button title={t.common.save} onPress={onSave} />
      {existing && (
        <Button
          title={k.delete}
          kind="ghost"
          onPress={() =>
            Alert.alert(k.deleteConfirm, undefined, [
              { text: t.common.cancel, style: 'cancel' },
              {
                text: t.common.delete,
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

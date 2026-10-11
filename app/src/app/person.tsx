import * as ImagePicker from 'expo-image-picker';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';

import { Avatar } from '@/components/familiar/avatar';
import { showPrompt } from '@/components/ui/action-sheet';
import { Row, Screen, Section, T, ToggleRow } from '@/components/ui/primitives';
import { addPlate, forgetIdentity, nameSamples, renameIdentity, samplesFromPhoto } from '@/familiar/recognize';
import { useFamiliar, type FamiliarSample } from '@/familiar/store';
import { tr } from '@/i18n';
import { useT } from '@/i18n/use-t';
import { useApp } from '@/state/store';
import { useAllCameras } from '@/systems/registry';
import { space } from '@/theme/tokens';
import { formatRelative } from '@/util/format';

/** One familiar person or vehicle: recent sightings, alert choices, rename, forget. */
export default function PersonScreen() {
  const t = useT();
  const { id } = useLocalSearchParams<{ id: string }>();
  const identity = useFamiliar((s) => s.identities.find((i) => i.id === id));
  const allSightings = useFamiliar((s) => s.sightings);
  const sightings = useMemo(() => allSightings.filter((x) => x.identityId === id), [allSightings, id]);
  const alerts = useApp((s) => s.alerts);
  const setAlerts = useApp((s) => s.setAlerts);
  const { entries } = useAllCameras({ includeHidden: true });
  const [adding, setAdding] = useState(false);

  if (!identity) {
    return (
      <Screen>
        <T muted>{t.viewing.person.notFound}</T>
      </Screen>
    );
  }
  const name = identity.name;
  const isFace = identity.kind === 'face';
  const quiet = alerts.quietFor.includes(name);
  const always = (alerts.alwaysFor ?? []).includes(name);
  const cameraName = (systemId: string, cameraId: string) => entries.find((e) => e.camera.key === `${systemId}:${cameraId}`)?.camera.name ?? cameraId;

  const toggle = (list: 'quietFor' | 'alwaysFor', on: boolean) => {
    const cur = list === 'quietFor' ? alerts.quietFor : (alerts.alwaysFor ?? []);
    const next = on ? [...new Set([...cur, name])] : cur.filter((n) => n !== name);
    // The two choices contradict each other: turning one on turns the other off.
    const other = list === 'quietFor' ? 'alwaysFor' : 'quietFor';
    const otherList = (other === 'quietFor' ? alerts.quietFor : (alerts.alwaysFor ?? [])).filter((n) => !on || n !== name);
    setAlerts({ [list]: next, [other]: otherList });
  };

  const rename = () =>
    showPrompt(
      t.viewing.person.rename,
      undefined,
      (text) => {
        const clean = text?.trim();
        if (!clean || clean === name) return;
        renameIdentity(identity.id, clean);
        // Keep alert choices attached to the new name.
        const swap = (l: string[]) => l.map((n) => (n === name ? clean : n));
        setAlerts({ quietFor: swap(alerts.quietFor), alwaysFor: swap(alerts.alwaysFor ?? []) });
      },
      name,
    );

  const addPhotos = async () => {
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: true, selectionLimit: 6, quality: 0.9 });
    if (res.canceled || !res.assets.length) return;
    setAdding(true);
    try {
      const found: FamiliarSample[] = [];
      for (const a of res.assets) {
        const { samples } = await samplesFromPhoto(a.uri, identity.kind).catch(() => ({ samples: [] as FamiliarSample[] }));
        if (samples[0]) found.push(samples[0]);
      }
      if (found.length) nameSamples(found, name);
      else Alert.alert(isFace ? tr().viewing.people.noFace : tr().viewing.people.noVehicle, tr().viewing.person.noMatchBody);
    } finally {
      setAdding(false);
    }
  };

  return (
    <Screen>
      <Stack.Screen options={{ title: name }} />
      <View style={styles.crops}>
        {identity.samples.slice(-8).map((s) => (
          <Avatar key={s.id} uri={s.crop} size={56} />
        ))}
      </View>

      <Section title={t.viewing.person.alerts} footer={t.viewing.person.alertsFooter}>
        <ToggleRow
          label={t.viewing.person.quiet(name)}
          detail={isFace ? t.viewing.person.quietFace : t.viewing.person.quietVehicle}
          value={quiet}
          onChange={(v) => toggle('quietFor', v)}
        />
        <ToggleRow
          label={isFace ? t.viewing.person.alwaysFace(name) : t.viewing.person.alwaysVehicle(name)}
          detail={t.viewing.person.alwaysDetail}
          value={always}
          onChange={(v) => toggle('alwaysFor', v)}
          last
        />
      </Section>

      {!isFace && (
        <Section title={t.viewing.person.plates} footer={t.viewing.person.platesFooter}>
          {identity.plates.map((pl) => (
            <Row key={pl} label={pl} />
          ))}
          <Row
            label={t.viewing.person.addPlate}
            onPress={() => showPrompt(t.viewing.person.plate, t.viewing.person.plateHint, (text) => text && addPlate(identity.id, text))}
            last
          />
        </Section>
      )}

      <Section title={t.viewing.person.recent}>
        {sightings.length === 0 && (
          <View style={{ padding: space.lg }}>
            <T muted>{t.viewing.person.notSeenYet}</T>
          </View>
        )}
        {sightings.slice(0, 30).map((s, i) => (
          <Row
            key={`${s.systemId}:${s.reviewId}:${i}`}
            label={cameraName(s.systemId, s.cameraId)}
            detail={formatRelative(s.at)}
            icon={s.crop ? <Avatar uri={s.crop} /> : undefined}
            onPress={() =>
              router.push({ pathname: '/playback', params: { systemId: s.systemId, cameraId: s.cameraId, start: String(Math.floor(s.at - 5)), reviewId: s.reviewId } })
            }
            last={i === Math.min(sightings.length, 30) - 1}
          />
        ))}
      </Section>

      <Section>
        <Row label={t.viewing.person.rename} onPress={rename} />
        <Row label={adding ? t.viewing.people.adding : t.viewing.person.addPhotos} detail={t.viewing.person.addPhotosDetail} onPress={adding ? undefined : () => void addPhotos()} />
        <Row
          label={t.viewing.person.forget(name)}
          destructive
          onPress={() =>
            Alert.alert(t.viewing.person.forgetTitle(name), t.viewing.person.forgetBody, [
              { text: t.common.cancel, style: 'cancel' },
              {
                text: t.viewing.people.forget,
                style: 'destructive',
                onPress: () => {
                  forgetIdentity(identity.id);
                  router.back();
                },
              },
            ])
          }
          last
        />
      </Section>
    </Screen>
  );
}

const styles = StyleSheet.create({
  crops: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
});

import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Alert, Pressable, StyleSheet, View } from 'react-native';

import { Avatar } from '@/components/familiar/avatar';
import { showActionSheet, showPrompt } from '@/components/ui/action-sheet';
import { Button, Card, Chip, Row, Screen, Section, T, ToggleRow } from '@/components/ui/primitives';
import { clusterUnknowns, type FamiliarKind } from '@/familiar/match';
import {
  familiarSupported,
  forgetEverything,
  ignoreSamples,
  nameSamples,
  samplesFromPhoto,
  syncGallery,
} from '@/familiar/recognize';
import { useFamiliar, type FamiliarIdentity, type FamiliarSample } from '@/familiar/store';
import { scanRecent } from '@/familiar/use-familiar';
import { tr } from '@/i18n';
import { useT } from '@/i18n/use-t';
import { useAllCameras } from '@/systems/registry';
import { useLargeText } from '@/theme/text-scale';
import { space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';
import { formatRelative } from '@/util/format';

/**
 * People & vehicles: familiar faces and cars recognized on this iPhone, for every brand.
 * Unknown sightings cluster into "Who is this?" cards; naming one teaches the app.
 */
export default function PeopleScreen() {
  const p = usePalette();
  const t = useT();
  const large = useLargeText();
  const settings = useFamiliar((s) => s.settings);
  const setSettings = useFamiliar((s) => s.setSettings);
  const identities = useFamiliar((s) => s.identities);
  const unknown = useFamiliar((s) => s.unknown);
  const sightings = useFamiliar((s) => s.sightings);
  const { entries } = useAllCameras({ includeHidden: true });
  const cameraName = (systemId?: string, cameraId?: string) =>
    entries.find((e) => e.camera.key === `${systemId}:${cameraId}`)?.camera.name ?? cameraId ?? '';
  const [scanning, setScanning] = useState(false);
  const [adding, setAdding] = useState(false);

  const clusters = useMemo(() => clusterUnknowns(unknown).slice(0, 12), [unknown]);
  const named = identities.filter((i) => !i.ignored && i.name);
  const people = named.filter((i) => i.kind === 'face').sort((a, b) => a.name.localeCompare(b.name));
  const vehicles = named.filter((i) => i.kind === 'vehicle').sort((a, b) => a.name.localeCompare(b.name));
  const ignoredCount = identities.filter((i) => i.ignored).length;

  const update = (patch: Partial<typeof settings>) => {
    setSettings(patch);
    void syncGallery();
  };

  if (!familiarSupported()) {
    return (
      <Screen>
        <Section title={t.viewing.people.unsupportedTitle}>
          <View style={{ padding: space.lg, gap: space.sm }}>
            <T>{t.viewing.people.needsUpdate}</T>
            <T muted>{t.viewing.people.updateHow}</T>
          </View>
        </Section>
      </Screen>
    );
  }

  const scan = async () => {
    setScanning(true);
    try {
      const n = await scanRecent(48, 40);
      Alert.alert(n ? tr().viewing.people.lookedThrough(n) : tr().viewing.people.nothingNew, n ? tr().viewing.people.lookedThroughBody : undefined);
    } catch {
      Alert.alert(tr().viewing.people.scanFailed, tr().viewing.people.scanFailedBody);
    } finally {
      setScanning(false);
    }
  };

  const addFromPhotos = async (kind: FamiliarKind) => {
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: true, selectionLimit: 6, quality: 0.9 });
    if (res.canceled || !res.assets.length) return;
    setAdding(true);
    try {
      const found: FamiliarSample[] = [];
      for (const asset of res.assets) {
        const { samples } = await samplesFromPhoto(asset.uri, kind).catch(() => ({ samples: [] as FamiliarSample[] }));
        // One person per photo: the largest face (or the vehicle).
        if (samples[0]) found.push(samples[0]);
      }
      if (!found.length) {
        Alert.alert(
          kind === 'face' ? tr().viewing.people.noFace : tr().viewing.people.noVehicle,
          kind === 'face' ? tr().viewing.people.noFaceBody : tr().viewing.people.noVehicleBody,
        );
        return;
      }
      askName(found, kind);
    } finally {
      setAdding(false);
    }
  };

  const askName = (samples: FamiliarSample[], kind: FamiliarKind) => {
    const existing = (kind === 'face' ? people : vehicles).map((i) => i.name);
    const prompt = () =>
      showPrompt(kind === 'face' ? t.viewing.people.whoIsThis : t.viewing.people.whoseVehicle, kind === 'face' ? t.viewing.people.nameExampleFace : t.viewing.people.nameExampleVehicle, (text) => {
        if (text?.trim()) nameSamples(samples, text);
      });
    if (!existing.length) return prompt();
    showActionSheet(
      { title: kind === 'face' ? t.viewing.people.whoIsThis : t.viewing.people.whoseVehicle, options: [...existing, t.viewing.people.someoneNew, t.common.cancel], cancelButtonIndex: existing.length + 1 },
      (i) => {
        if (i < existing.length) nameSamples(samples, existing[i]);
        else if (i === existing.length) prompt();
      },
    );
  };

  const whoIsThis = (samples: FamiliarSample[]) => {
    const kind = samples[0].kind;
    const existing = (kind === 'face' ? people : vehicles).map((i) => i.name);
    const options = [
      ...existing,
      t.viewing.people.someoneNew,
      kind === 'face' ? t.viewing.people.stranger : t.viewing.people.notOurs,
      t.viewing.people.notFaceOrVehicle,
      t.common.cancel,
    ];
    showActionSheet(
      { title: kind === 'face' ? t.viewing.people.whoIsThis : t.viewing.people.whoseVehicle, options, cancelButtonIndex: options.length - 1, destructiveButtonIndex: options.length - 2 },
      (i) => {
        if (i < existing.length) nameSamples(samples, existing[i]);
        else if (i === existing.length) askName(samples, kind);
        else if (i === existing.length + 1) ignoreSamples(samples);
        else if (i === existing.length + 2) {
          const ids = new Set(samples.map((s) => s.id));
          useFamiliar.getState().setUnknown(useFamiliar.getState().unknown.filter((u) => !ids.has(u.id)));
        }
      },
    );
  };

  const lastSeen = (i: FamiliarIdentity) => sightings.find((s) => s.identityId === i.id);
  const seenCount = (i: FamiliarIdentity) => sightings.filter((s) => s.identityId === i.id).length;

  const identityRow = (i: FamiliarIdentity, last: boolean) => {
    const seen = lastSeen(i);
    const avatar = i.samples.find((s) => s.crop)?.crop;
    return (
      <Row
        key={i.id}
        label={i.name}
        detail={
          seen
            ? `${t.viewing.people.lastSeen(formatRelative(seen.at), cameraName(seen.systemId, seen.cameraId))}${seenCount(i) > 1 ? ` · ${t.viewing.people.times(seenCount(i))}` : ''}`
            : i.plates.length
              ? i.plates.join(', ')
              : t.viewing.people.notSeenYet
        }
        icon={<Avatar uri={avatar} />}
        onPress={() => router.push({ pathname: '/person', params: { id: i.id } })}
        last={last}
      />
    );
  };

  return (
    <Screen>
      <Section footer={t.viewing.people.privacyFooter}>
        <ToggleRow
          label={t.viewing.people.recognize}
          detail={t.viewing.people.recognizeDetail}
          value={settings.enabled}
          onChange={(enabled) => update({ enabled })}
          last={!settings.enabled}
        />
        {settings.enabled && <Row label={scanning ? t.viewing.people.looking : t.viewing.people.scanNow} onPress={scanning ? undefined : () => void scan()} last />}
      </Section>

      {settings.enabled && (
        <>
          {clusters.length > 0 && (
            <Section title={t.viewing.people.whoIsThis} footer={t.viewing.people.clustersFooter}>
              <View style={{ padding: space.md, gap: space.md }}>
                {clusters.map((c) => {
                  const newest = [...c].sort((a, b) => b.at - a.at);
                  return (
                    <Pressable key={c[0].id} onPress={() => whoIsThis(c)} accessibilityRole="button" accessibilityLabel={t.viewing.people.clusterA11y(c.length)}>
                      <Card style={large ? { ...styles.cluster, flexDirection: 'column', alignItems: 'flex-start' } : styles.cluster}>
                        <View style={styles.crops}>
                          {newest.slice(0, 3).map((s) => (
                            <Avatar key={s.id} uri={s.crop} size={48} />
                          ))}
                        </View>
                        <View style={{ flex: large ? undefined : 1, gap: 2 }}>
                          <T v="label">{c[0].kind === 'face' ? t.viewing.people.whoIsThis : t.viewing.people.whoseVehicle}</T>
                          <T v="caption" muted>
                            {t.viewing.people.clusterSeen(c.length, formatRelative(newest[0].at))}
                            {newest[0].cameraId ? ` · ${cameraName(newest[0].systemId, newest[0].cameraId)}` : ''}
                            {newest.find((s) => s.plate) ? ` · ${newest.find((s) => s.plate)!.plate}` : ''}
                          </T>
                        </View>
                      </Card>
                    </Pressable>
                  );
                })}
              </View>
            </Section>
          )}

          <Section title={t.viewing.people.people}>
            {people.map((i) => identityRow(i, false))}
            <Row label={adding ? t.viewing.people.adding : t.viewing.people.addPerson} detail={t.viewing.people.addPersonDetail} onPress={adding ? undefined : () => void addFromPhotos('face')} last />
          </Section>

          <Section title={t.viewing.people.vehicles}>
            {vehicles.map((i) => identityRow(i, false))}
            <Row label={adding ? t.viewing.people.adding : t.viewing.people.addVehicle} detail={t.viewing.people.addVehicleDetail} onPress={adding ? undefined : () => void addFromPhotos('vehicle')} last />
          </Section>

          <Section
            title={t.viewing.people.matching}
            footer={t.viewing.people.matchingFooter}>
            <View style={styles.chips}>
              <Chip label={t.viewing.people.careful} selected={settings.strictness === 'careful'} onPress={() => update({ strictness: 'careful' })} />
              <Chip label={t.viewing.people.relaxed} selected={settings.strictness === 'relaxed'} onPress={() => update({ strictness: 'relaxed' })} />
            </View>
          </Section>

          <Section footer={t.viewing.people.instantFooter}>
            <ToggleRow label={t.viewing.people.readPlates} detail={t.viewing.people.readPlatesDetail} value={settings.plates} onChange={(plates) => update({ plates })} />
            <ToggleRow label={t.viewing.people.instantNames} value={settings.instantTitles} onChange={(instantTitles) => update({ instantTitles })} last />
          </Section>

          <Section footer={ignoredCount ? t.viewing.people.ignored(ignoredCount) : undefined}>
            <Row
              label={t.viewing.people.forgetAll}
              destructive
              onPress={() =>
                Alert.alert(t.viewing.people.forgetAllTitle, t.viewing.people.forgetAllBody, [
                  { text: t.common.cancel, style: 'cancel' },
                  { text: t.viewing.people.forget, style: 'destructive', onPress: forgetEverything },
                ])
              }
              last
            />
          </Section>
        </>
      )}
      {!settings.enabled && (
        <View style={{ paddingHorizontal: space.lg }}>
          <Button title={t.viewing.people.turnOn} onPress={() => update({ enabled: true })} />
        </View>
      )}
      <View style={{ alignItems: 'center' }}>
        <T v="caption" color={p.textMuted} style={{ textAlign: 'center' }}>
          {t.viewing.people.everyBrand}
        </T>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  cluster: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  crops: { flexDirection: 'row', gap: 4 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, padding: space.md },
});

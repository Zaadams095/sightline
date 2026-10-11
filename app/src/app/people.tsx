import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { ActionSheetIOS, Alert, Pressable, StyleSheet, View } from 'react-native';

import { Avatar } from '@/components/familiar/avatar';
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
import { useAllCameras } from '@/systems/registry';
import { space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';
import { formatRelative } from '@/util/format';

/**
 * People & vehicles: familiar faces and cars recognized on this iPhone, for every brand.
 * Unknown sightings cluster into "Who is this?" cards; naming one teaches the app.
 */
export default function PeopleScreen() {
  const p = usePalette();
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
        <Section title="Familiar faces & vehicles">
          <View style={{ padding: space.lg, gap: space.sm }}>
            <T>This needs the newest version of Sightline.</T>
            <T muted>Update the app from TestFlight or the App Store, then come back here.</T>
          </View>
        </Section>
      </Screen>
    );
  }

  const scan = async () => {
    setScanning(true);
    try {
      const n = await scanRecent(48, 40);
      Alert.alert(n ? `Looked through ${n} events` : 'Nothing new to look through', n ? 'New faces and vehicles show up under “Who is this?”.' : undefined);
    } catch {
      Alert.alert('Couldn’t look through events', 'Make sure your cameras are reachable, then try again.');
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
          kind === 'face' ? 'No clear face found' : 'No vehicle found',
          kind === 'face' ? 'Pick photos where the face is large, sharp and looking at the camera.' : 'Pick a photo where the vehicle fills most of the picture.',
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
      Alert.prompt(kind === 'face' ? 'Who is this?' : 'Whose vehicle is this?', kind === 'face' ? 'For example “Dad” or “The dog walker”.' : 'For example “Our car”.', (text) => {
        if (text?.trim()) nameSamples(samples, text);
      });
    if (!existing.length) return prompt();
    ActionSheetIOS.showActionSheetWithOptions(
      { title: kind === 'face' ? 'Who is this?' : 'Whose vehicle is this?', options: [...existing, 'Someone new…', 'Cancel'], cancelButtonIndex: existing.length + 1 },
      (i) => {
        if (i < existing.length) nameSamples(samples, existing[i]);
        else if (i === existing.length) prompt();
      },
    );
  };

  const whoIsThis = (samples: FamiliarSample[]) => {
    const kind = samples[0].kind;
    const existing = (kind === 'face' ? people : vehicles).map((i) => i.name);
    const options = [...existing, 'Someone new…', kind === 'face' ? 'A stranger: don’t track' : 'Not ours: don’t track', 'Not a face or vehicle (remove)', 'Cancel'];
    ActionSheetIOS.showActionSheetWithOptions(
      { title: kind === 'face' ? 'Who is this?' : 'Whose vehicle is this?', options, cancelButtonIndex: options.length - 1, destructiveButtonIndex: options.length - 2 },
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
            ? `Last seen ${formatRelative(seen.at)} · ${cameraName(seen.systemId, seen.cameraId)}${seenCount(i) > 1 ? ` · ${seenCount(i)} times` : ''}`
            : i.plates.length
              ? i.plates.join(', ')
              : 'Not seen yet'
        }
        icon={<Avatar uri={avatar} />}
        onPress={() => router.push({ pathname: '/person', params: { id: i.id } })}
        last={last}
      />
    );
  };

  return (
    <Screen>
      <Section footer="Sightline looks at pictures from your own cameras on this iPhone with Apple’s built-in image recognition. Pictures and face data never leave your phone. It can be wrong: it only puts a name on someone when it’s quite sure.">
        <ToggleRow
          label="Recognize familiar faces & vehicles"
          detail="Name family, regular visitors and your own cars, so alerts can say who it is."
          value={settings.enabled}
          onChange={(enabled) => update({ enabled })}
          last={!settings.enabled}
        />
        {settings.enabled && <Row label={scanning ? 'Looking…' : 'Look through the last 2 days now'} onPress={scanning ? undefined : () => void scan()} last />}
      </Section>

      {settings.enabled && (
        <>
          {clusters.length > 0 && (
            <Section title="Who is this?" footer="Tap a card to name them. Sightline will recognize them from then on.">
              <View style={{ padding: space.md, gap: space.md }}>
                {clusters.map((c) => {
                  const newest = [...c].sort((a, b) => b.at - a.at);
                  return (
                    <Pressable key={c[0].id} onPress={() => whoIsThis(c)} accessibilityRole="button" accessibilityLabel={`Who is this? Seen ${c.length} times`}>
                      <Card style={styles.cluster}>
                        <View style={styles.crops}>
                          {newest.slice(0, 3).map((s) => (
                            <Avatar key={s.id} uri={s.crop} size={48} />
                          ))}
                        </View>
                        <View style={{ flex: 1, gap: 2 }}>
                          <T v="label">{c[0].kind === 'face' ? 'Who is this?' : 'Whose vehicle is this?'}</T>
                          <T v="caption" muted>
                            Seen {c.length === 1 ? 'once' : `${c.length} times`} · last {formatRelative(newest[0].at)}
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

          <Section title="People">
            {people.map((i) => identityRow(i, false))}
            <Row label={adding ? 'Adding…' : 'Add someone from photos'} detail="Pick a few clear photos of their face" onPress={adding ? undefined : () => void addFromPhotos('face')} last />
          </Section>

          <Section title="Vehicles">
            {vehicles.map((i) => identityRow(i, false))}
            <Row label={adding ? 'Adding…' : 'Add a vehicle from photos'} detail="A photo where the vehicle fills the picture" onPress={adding ? undefined : () => void addFromPhotos('vehicle')} last />
          </Section>

          <Section
            title="Matching"
            footer="Careful names someone only when it’s quite sure, and asks “Who is this?” more often. Relaxed names more, and can be wrong more often.">
            <View style={styles.chips}>
              <Chip label="Careful" selected={settings.strictness === 'careful'} onPress={() => update({ strictness: 'careful' })} />
              <Chip label="Relaxed" selected={settings.strictness === 'relaxed'} onPress={() => update({ strictness: 'relaxed' })} />
            </View>
          </Section>

          <Section footer="Instant Alerts come from your Sightline Hub, which can’t recognize faces. With this on, your iPhone looks at the alert’s picture when it arrives and adds the name, such as “Dad is at Front Door”. It only works when the picture is clear enough.">
            <ToggleRow label="Read licence plates" detail="Recognize your vehicles by their plate when it’s readable." value={settings.plates} onChange={(plates) => update({ plates })} />
            <ToggleRow label="Names on Instant Alerts" value={settings.instantTitles} onChange={(instantTitles) => update({ instantTitles })} last />
          </Section>

          <Section footer={ignoredCount ? `${ignoredCount} stranger${ignoredCount === 1 ? '' : 's'} you chose not to track.` : undefined}>
            <Row
              label="Forget all faces & vehicles"
              destructive
              onPress={() =>
                Alert.alert('Forget everyone?', 'Removes every name, face and vehicle Sightline learned on this iPhone.', [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Forget', style: 'destructive', onPress: forgetEverything },
                ])
              }
              last
            />
          </Section>
        </>
      )}
      {!settings.enabled && (
        <View style={{ paddingHorizontal: space.lg }}>
          <Button title="Turn on" onPress={() => update({ enabled: true })} />
        </View>
      )}
      <View style={{ alignItems: 'center' }}>
        <T v="caption" color={p.textMuted}>
          Works with every camera brand. Nothing is uploaded.
        </T>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  cluster: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  crops: { flexDirection: 'row', gap: 4 },
  chips: { flexDirection: 'row', gap: space.sm, padding: space.md },
});

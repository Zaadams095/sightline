import { CameraView, useCameraPermissions } from 'expo-camera';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Modal, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, Card, Field, Screen, T } from '@/components/ui/primitives';
import { useT } from '@/i18n/use-t';
import { finishHubJoin, joinAndSaveHub } from '@/systems/hub-join';
import { looksLikePairingCode, normalizeHubAddress, parseHubLink, type HubLink } from '@/systems/hub-links';
import { parseTvLink } from '@/tv/link';
import { space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';

/**
 * Join a Sightline Hub by QR code or link: the Hub's own pairing code (owner) or an invite
 * someone shared (guest). Deep links sightline://hub?… and sightline://invite?… land here.
 */
export default function Invite() {
  const p = usePalette();
  const t = useT();
  const s = t.onboarding.invite;
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ kind?: string; url?: string; code?: string; lan?: string; remote?: string; name?: string }>();
  const fromLink = useMemo<HubLink | null>(() => {
    if (!params.code || !params.url) return null;
    const q = Object.entries(params)
      .filter(([k, v]) => k !== 'kind' && typeof v === 'string')
      .map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`)
      .join('&');
    return parseHubLink(`sightline://${params.kind === 'pair' ? 'hub' : 'invite'}?${q}`);
  }, [params]);

  const [link, setLink] = useState<HubLink | null>(fromLink);
  const [scanning, setScanning] = useState(false);
  const [perm, requestPerm] = useCameraPermissions();
  const [manual, setManual] = useState(false);
  const [address, setAddress] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const scan = async () => {
    setError(null);
    if (!perm?.granted && !(await requestPerm()).granted) {
      setError(s.cameraNeeded);
      return;
    }
    setScanning(true);
  };

  const join = async (l: HubLink) => {
    setBusy(true);
    setError(null);
    try {
      const r = await joinAndSaveHub(l);
      setDone(l.kind === 'pair' ? t.onboarding.connectedToHub(r.hubName, r.cameras) : s.guestJoined(r.hubName, r.cameras));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const joinManual = () => {
    const url = normalizeHubAddress(address);
    const c = code.trim();
    void join({ kind: looksLikePairingCode(c) ? 'pair' : 'invite', url, code: c });
  };

  if (done) {
    return (
      <Screen style={{ paddingTop: insets.top + 56 }}>
        <T v="title">{s.allSet}</T>
        <T color={p.success}>{done}</T>
        <Button title={s.seeCameras} onPress={() => void finishHubJoin()} />
      </Screen>
    );
  }

  return (
    <Screen style={{ paddingTop: insets.top + 56 }}>
      <View style={{ gap: space.xs }}>
        <T v="title">{link?.kind === 'pair' ? s.titlePair : s.titleShared}</T>
        <T muted>
          {link ? (link.kind === 'pair' ? s.pairWith(link.name ?? s.yourHub) : s.sharedBy(link.name ?? s.someone)) : s.scanIntro}
        </T>
      </View>

      {link ? (
        <>
          <Card style={{ padding: space.lg, gap: space.xs }}>
            <T v="label">{link.name ?? 'Sightline Hub'}</T>
            <T v="caption" muted>
              {link.kind === 'pair' ? s.pairingCode(link.code) : s.inviteCode(link.code)}
            </T>
          </Card>
          <Button title={link.kind === 'pair' ? t.onboarding.connect.connect : s.join} onPress={() => void join(link)} loading={busy} />
          <Button
            title={s.scanDifferent}
            kind="ghost"
            onPress={() => {
              setLink(null);
              void scan();
            }}
          />
        </>
      ) : (
        <>
          <Button title={s.scanQr} onPress={scan} />
          {!manual ? (
            <Button title={s.typeCode} kind="ghost" onPress={() => setManual(true)} />
          ) : (
            <>
              <Field
                label={s.hubAddress}
                value={address}
                onChangeText={setAddress}
                placeholder={s.hubAddressPlaceholder}
                keyboardType="url"
                hint={s.hubAddressHint}
              />
              <Field label={s.code} value={code} onChangeText={setCode} placeholder={s.codePlaceholder} autoCapitalize="characters" />
              <Button title={s.join} onPress={joinManual} loading={busy} disabled={!address.trim() || !code.trim()} />
            </>
          )}
        </>
      )}

      {error && <T color={p.danger}>{error}</T>}

      <Modal visible={scanning} animationType="slide" presentationStyle="fullScreen" onRequestClose={() => setScanning(false)}>
        <View style={{ flex: 1, backgroundColor: '#000' }}>
          <CameraView
            style={StyleSheet.absoluteFill}
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={({ data }) => {
              if (!scanning) return;
              setScanning(false);
              const parsed = parseHubLink(data);
              // The code on the Apple TV app: connect that TV instead.
              const tv = parsed ? null : parseTvLink(data);
              if (tv) {
                router.push({ pathname: '/tv', params: { h: tv.host, k: tv.key, n: tv.name } });
                return;
              }
              if (!parsed) {
                setError(s.notSightlineCode);
                return;
              }
              setLink(parsed);
              void join(parsed);
            }}
          />
          <View style={[styles.scanFooter, { paddingBottom: insets.bottom + space.lg }]}>
            <T overlay color="#fff" style={{ textAlign: 'center' }}>
              {s.pointCamera}
            </T>
            <Button title={t.common.cancel} kind="secondary" onPress={() => setScanning(false)} />
          </View>
        </View>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  scanFooter: { position: 'absolute', left: space.lg, right: space.lg, bottom: 0, gap: space.md },
});

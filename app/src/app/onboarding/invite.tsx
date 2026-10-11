import { CameraView, useCameraPermissions } from 'expo-camera';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Modal, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, Card, Field, Screen, T } from '@/components/ui/primitives';
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
      setError('Camera access is needed to scan the code. You can type the code instead.');
      return;
    }
    setScanning(true);
  };

  const join = async (l: HubLink) => {
    setBusy(true);
    setError(null);
    try {
      const r = await joinAndSaveHub(l);
      setDone(
        l.kind === 'pair'
          ? `Connected to ${r.hubName}. Found ${r.cameras} camera${r.cameras === 1 ? '' : 's'}.`
          : `You're in. ${r.hubName} shared ${r.cameras} camera${r.cameras === 1 ? '' : 's'} with you.`,
      );
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
        <T v="title">All set</T>
        <T color={p.success}>{done}</T>
        <Button title="See cameras" onPress={() => void finishHubJoin()} />
      </Screen>
    );
  }

  return (
    <Screen style={{ paddingTop: insets.top + 56 }}>
      <View style={{ gap: space.xs }}>
        <T v="title">{link?.kind === 'pair' ? 'Connect to your Hub' : 'Shared cameras'}</T>
        <T muted>
          {link
            ? link.kind === 'pair'
              ? `Pair this phone with ${link.name ?? 'your Sightline Hub'}.`
              : `${link.name ?? 'Someone'} shared cameras with you. Tap Join to start watching.`
            : 'Scan the QR code someone shared with you, or the code on your Sightline Hub’s setup page.'}
        </T>
      </View>

      {link ? (
        <>
          <Card style={{ padding: space.lg, gap: space.xs }}>
            <T v="label">{link.name ?? 'Sightline Hub'}</T>
            <T v="caption" muted>
              {link.kind === 'pair' ? 'Pairing code' : 'Invite code'} {link.code}
            </T>
          </Card>
          <Button title={link.kind === 'pair' ? 'Connect' : 'Join'} onPress={() => void join(link)} loading={busy} />
          <Button
            title="Scan a different code"
            kind="ghost"
            onPress={() => {
              setLink(null);
              void scan();
            }}
          />
        </>
      ) : (
        <>
          <Button title="Scan QR code" onPress={scan} />
          {!manual ? (
            <Button title="Type a code instead" kind="ghost" onPress={() => setManual(true)} />
          ) : (
            <>
              <Field
                label="Hub address"
                value={address}
                onChangeText={setAddress}
                placeholder="192.168.1.20:8086 or https://….ts.net"
                keyboardType="url"
                hint="From the invite message, or the Hub’s setup page."
              />
              <Field label="Code" value={code} onChangeText={setCode} placeholder="ABCDE-FGHJK or 6 digits" autoCapitalize="characters" />
              <Button title="Join" onPress={joinManual} loading={busy} disabled={!address.trim() || !code.trim()} />
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
                setError('That QR code isn’t a Sightline code. Scan the code on the Hub’s setup page or in the invite.');
                return;
              }
              setLink(parsed);
              void join(parsed);
            }}
          />
          <View style={[styles.scanFooter, { paddingBottom: insets.bottom + space.lg }]}>
            <T color="#fff" style={{ textAlign: 'center' }}>
              Point the camera at the Sightline QR code
            </T>
            <Button title="Cancel" kind="secondary" onPress={() => setScanning(false)} />
          </View>
        </View>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  scanFooter: { position: 'absolute', left: space.lg, right: space.lg, bottom: 0, gap: space.md },
});

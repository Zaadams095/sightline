import { CameraView, useCameraPermissions } from 'expo-camera';
import * as DocumentPicker from 'expo-document-picker';
import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { Modal, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { Bundle } from '@/backup/bundle';
import { needsPasswordText, type RestoreResult } from '@/backup/restore';
import { applyBundle, readBackupFile, receiveTransfer } from '@/backup/transfer';
import { Button, Card, Field, Screen, T } from '@/components/ui/primitives';
import { space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';

/** "Moving from another phone?": scan the old phone's transfer code, or open a backup file. */
export default function MoveFromPhone() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const [perm, requestPerm] = useCameraPermissions();
  const [scanning, setScanning] = useState(false);
  const scanned = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<{ uri: string; name: string } | null>(null);
  const [passcode, setPasscode] = useState('');
  const [done, setDone] = useState<{ result: RestoreResult; from?: string } | null>(null);

  const finish = async (bundle: Bundle) => {
    const result = await applyBundle(bundle);
    setDone({ result, from: bundle.from });
  };

  const scan = async () => {
    setError(null);
    if (!perm?.granted && !(await requestPerm()).granted) {
      setError('Camera access is needed to scan the code. You can use a backup file instead.');
      return;
    }
    scanned.current = false;
    setScanning(true);
  };

  const onScanned = async (data: string) => {
    if (scanned.current) return;
    scanned.current = true;
    setScanning(false);
    setBusy(true);
    try {
      await finish(await receiveTransfer(data));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const pickFile = async () => {
    setError(null);
    const res = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true });
    if (res.canceled) return;
    setFile({ uri: res.assets[0].uri, name: res.assets[0].name });
  };

  const openFile = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      await finish(await readBackupFile(file.uri, passcode));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    const note = needsPasswordText(done.result);
    return (
      <Screen style={{ paddingTop: insets.top + 56 }}>
        <T v="title">You’re all set</T>
        <T color={p.success}>
          {done.result.systems === 1 ? 'Your recorder is' : `Your ${done.result.systems} recorders and cameras are`} set up
          {done.from ? `, just like on ${done.from}` : ''}.
        </T>
        {note && <T muted>{note}</T>}
        <Button title="See my cameras" onPress={() => router.replace('/')} />
      </Screen>
    );
  }

  return (
    <Screen style={{ paddingTop: insets.top + 56 }}>
      <View style={{ gap: space.xs }}>
        <T v="title">Moving from another phone?</T>
        <T muted>Bring your cameras, passwords and settings over in a minute. Nothing needs typing again.</T>
      </View>

      <Card style={{ padding: space.lg, gap: space.md }}>
        <T v="label">With your old phone nearby</T>
        <T muted>
          On the old phone, open Sightline, then Settings → Backup & new phone → Transfer to another phone. Keep both phones on the
          same home Wi-Fi, then scan the code it shows.
        </T>
        <Button title="Scan the code" onPress={() => void scan()} loading={busy && !file} />
      </Card>

      <Card style={{ padding: space.lg, gap: space.md }}>
        <T v="label">With a backup file</T>
        <T muted>If you saved a Sightline backup file (AirDrop, Files or iCloud Drive), open it here and type the passcode you chose.</T>
        {file ? (
          <>
            <T v="caption" muted>
              {file.name}
            </T>
            <Field label="Passcode" value={passcode} onChangeText={setPasscode} secureTextEntry autoFocus placeholder="The passcode you chose" />
            <Button title="Restore" onPress={() => void openFile()} loading={busy} disabled={!passcode} />
            <Button title="Choose a different file" kind="ghost" onPress={() => void pickFile()} />
          </>
        ) : (
          <Button title="Open a backup file" kind="secondary" onPress={() => void pickFile()} />
        )}
      </Card>

      {error && <T color={p.danger}>{error}</T>}

      <Modal visible={scanning} animationType="slide" presentationStyle="fullScreen" onRequestClose={() => setScanning(false)}>
        <View style={{ flex: 1, backgroundColor: '#000' }}>
          <CameraView
            style={StyleSheet.absoluteFill}
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={({ data }) => void onScanned(data)}
          />
          <View style={[styles.scanFooter, { paddingBottom: insets.bottom + space.lg }]}>
            <T color="#fff" style={{ textAlign: 'center' }}>
              Point the camera at the code on your old phone
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

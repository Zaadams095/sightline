import { CameraView, useCameraPermissions } from 'expo-camera';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { useState } from 'react';
import { Modal, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, Field, T } from '@/components/ui/primitives';
import { saveTunnelConfig } from '@/net/connection';
import { space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';

/** Import a WireGuard client config by QR code, .conf file, or pasted text. */
export function VpnSetup({ onSaved }: { onSaved: () => void }) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [perm, requestPerm] = useCameraPermissions();

  const save = async (conf: string) => {
    const err = await saveTunnelConfig(conf);
    if (err) setError(`That doesn't look like a valid WireGuard config: ${err}`);
    else {
      setError(null);
      onSaved();
    }
  };

  const pickFile = async () => {
    const res = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true });
    if (res.canceled) return;
    const conf = await new File(res.assets[0].uri).text();
    setText(conf);
    await save(conf);
  };

  const scan = async () => {
    if (!perm?.granted && !(await requestPerm()).granted) {
      setError('Camera access is needed to scan a QR code.');
      return;
    }
    setScanning(true);
  };

  return (
    <View style={{ gap: space.md }}>
      <View style={styles.row}>
        <Button title="Scan QR code" kind="secondary" onPress={scan} style={{ flex: 1 }} />
        <Button title="Choose .conf file" kind="secondary" onPress={pickFile} style={{ flex: 1 }} />
      </View>
      <Field
        label="Or paste config"
        value={text}
        onChangeText={setText}
        multiline
        placeholder={'[Interface]\nPrivateKey = …\nAddress = 10.6.0.2/32\n\n[Peer]\nPublicKey = …\nEndpoint = home.example.com:51820\nAllowedIPs = 192.168.1.0/24'}
      />
      {error && <T color={p.danger}>{error}</T>}
      <Button title="Save VPN" onPress={() => save(text)} disabled={!text.trim()} />
      <T v="caption" muted>
        Tip: set AllowedIPs to just your camera network (for example 192.168.1.0/24). Only camera traffic uses the
        VPN, and nothing else on your phone changes.
      </T>

      <Modal visible={scanning} animationType="slide" presentationStyle="fullScreen" onRequestClose={() => setScanning(false)}>
        <View style={{ flex: 1, backgroundColor: '#000' }}>
          <CameraView
            style={StyleSheet.absoluteFill}
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={({ data }) => {
              if (!scanning) return;
              setScanning(false);
              setText(data);
              void save(data);
            }}
          />
          <View style={[styles.scanFooter, { paddingBottom: insets.bottom + space.lg }]}>
            <T color="#fff" style={{ textAlign: 'center' }}>
              Scan the QR code from your router&apos;s WireGuard client setup
            </T>
            <Button title="Cancel" kind="secondary" onPress={() => setScanning(false)} />
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: space.sm },
  scanFooter: { position: 'absolute', left: space.lg, right: space.lg, bottom: 0, gap: space.md },
});

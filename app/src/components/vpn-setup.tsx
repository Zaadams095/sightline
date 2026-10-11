import { CameraView, useCameraPermissions } from 'expo-camera';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { useState } from 'react';
import { Modal, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, Field, T } from '@/components/ui/primitives';
import { useT } from '@/i18n/use-t';
import { saveTunnelConfig } from '@/net/connection';
import { space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';

/** Import a WireGuard client config by QR code, .conf file, or pasted text. */
export function VpnSetup({ onSaved }: { onSaved: () => void }) {
  const p = usePalette();
  const t = useT();
  const insets = useSafeAreaInsets();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [showOther, setShowOther] = useState(false);
  const [perm, requestPerm] = useCameraPermissions();

  const save = async (conf: string) => {
    const err = await saveTunnelConfig(conf);
    if (err) setError(t.home.vpn.invalid(err));
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
      setError(t.home.vpn.cameraNeeded);
      return;
    }
    setScanning(true);
  };

  return (
    <View style={{ gap: space.md }}>
      <Button title={t.home.vpn.scan} onPress={scan} />
      <T v="caption" muted>
        {t.home.vpn.scanHelp}
      </T>
      {error && <T color={p.danger}>{error}</T>}
      <Button title={showOther ? t.home.vpn.hideOther : t.home.vpn.otherWays} kind="ghost" onPress={() => setShowOther((v) => !v)} />
      {showOther && (
        <View style={{ gap: space.md }}>
          <Button title={t.home.vpn.chooseFile} kind="secondary" onPress={pickFile} />
          <Field
            label={t.home.vpn.pasteLabel}
            value={text}
            onChangeText={setText}
            multiline
            placeholder={'[Interface]\nPrivateKey = …\n…\n[Peer]\nEndpoint = …'}
          />
          <Button title={t.common.save} onPress={() => save(text)} disabled={!text.trim()} />
        </View>
      )}
      <T v="caption" muted>
        {t.home.vpn.onlySightline}
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
              {t.home.vpn.scanFooter}
            </T>
            <Button title={t.common.cancel} kind="secondary" onPress={() => setScanning(false)} />
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

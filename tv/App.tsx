import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, BackHandler, Pressable, StyleSheet, Text, TVEventControl, View } from 'react-native';

import { TvPairing } from './modules/tv-pairing';
import { GridScreen } from './src/GridScreen';
import { HubError, listCameras, pickBase, type HubCamera, type TvConfig } from './src/hub';
import { t } from './src/i18n';
import { LiveScreen } from './src/LiveScreen';
import { PairScreen } from './src/PairScreen';
import { TourScreen } from './src/TourScreen';
import { colors } from './src/theme';

type Phase =
  | { kind: 'loading' }
  | { kind: 'pair' }
  | { kind: 'error'; message: string; repair: boolean }
  | { kind: 'grid'; base: string; cameras: HubCamera[] };

function loadConfig(): TvConfig | null {
  try {
    const raw = TvPairing?.getSecret('config');
    return raw ? (JSON.parse(raw) as TvConfig) : null;
  } catch {
    return null;
  }
}

export default function App() {
  const [config, setConfig] = useState<TvConfig | null>(loadConfig);
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [columns, setColumns] = useState<2 | 3>(2);
  const [live, setLive] = useState<number | null>(null);
  const [tour, setTour] = useState(false);

  const connect = useCallback(async (c: TvConfig | null) => {
    if (!c) {
      setPhase({ kind: 'pair' });
      return;
    }
    setPhase({ kind: 'loading' });
    try {
      const base = await pickBase(c);
      const cameras = await listCameras(base, c.token);
      setPhase({ kind: 'grid', base, cameras });
      setColumns(cameras.length > 4 ? 3 : 2);
    } catch (e) {
      const removed = e instanceof HubError && (e.code === 'revoked' || e.code === 'expired' || e.code === 'unauthorized');
      setPhase({ kind: 'error', message: e instanceof Error ? e.message : String(e), repair: removed });
    }
  }, []);

  useEffect(() => {
    void connect(config);
  }, [config, connect]);

  // Menu on the remote: leave full screen. On the grid it goes back to the Home Screen.
  const fullScreen = live != null || tour;
  useEffect(() => {
    if (!fullScreen) {
      TVEventControl.disableTVMenuKey();
      return;
    }
    TVEventControl.enableTVMenuKey();
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setLive(null);
      setTour(false);
      return true;
    });
    return () => sub.remove();
  }, [fullScreen]);

  const disconnect = useCallback(() => {
    TvPairing?.removeSecret('config');
    setLive(null);
    setTour(false);
    setConfig(null);
  }, []);

  const onPaired = useCallback((c: TvConfig) => setConfig(c), []);

  let content;
  if (phase.kind === 'loading') {
    content = (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  } else if (phase.kind === 'pair' || !config) {
    content = <PairScreen onPaired={onPaired} />;
  } else if (phase.kind === 'error') {
    content = (
      <View style={styles.center}>
        <Text style={styles.message}>{phase.message}</Text>
        <View style={styles.row}>
          <Pressable hasTVPreferredFocus onPress={() => void connect(config)} style={({ focused }) => [styles.button, focused && styles.buttonFocused]}>
            <Text style={styles.buttonText}>{t.tryAgain}</Text>
          </Pressable>
          <Pressable onPress={disconnect} style={({ focused }) => [styles.button, focused && styles.buttonFocused]}>
            <Text style={styles.buttonText}>{phase.repair ? t.connectAgain : t.disconnect}</Text>
          </Pressable>
        </View>
      </View>
    );
  } else if (tour && phase.cameras.length) {
    content = <TourScreen base={phase.base} token={config.token} cameras={phase.cameras} />;
  } else if (live != null && phase.cameras[live]) {
    content = <LiveScreen key={live} base={phase.base} token={config.token} cameras={phase.cameras} index={live} onIndex={setLive} />;
  } else {
    content = (
      <GridScreen
        hubName={config.hubName}
        base={phase.base}
        token={config.token}
        cameras={phase.cameras}
        columns={columns}
        onColumns={setColumns}
        onOpen={setLive}
        onTour={() => setTour(true)}
        onDisconnect={disconnect}
      />
    );
  }

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      {content}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 40, padding: 120 },
  message: { color: colors.text, fontSize: 36, textAlign: 'center', maxWidth: 1200 },
  row: { flexDirection: 'row', gap: 24 },
  button: { paddingHorizontal: 36, paddingVertical: 18, borderRadius: 16, backgroundColor: colors.surfaceRaised },
  buttonFocused: { backgroundColor: colors.accent },
  buttonText: { color: colors.text, fontSize: 30, fontWeight: '600' },
});

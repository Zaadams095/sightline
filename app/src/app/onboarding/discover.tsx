import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, Screen, T } from '@/components/ui/primitives';
import { describe } from '@/systems/catalog';
import { discover, type Found } from '@/systems/discovery';
import { space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';

/** "Find my cameras": scans home Wi-Fi and lists what it recognized. Tap one to connect. */
export default function Discover() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const [found, setFound] = useState<Found[] | null>(null);
  const [status, setStatus] = useState('Starting…');
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState(0);

  useEffect(() => {
    let cancelled = false;
    discover((msg) => !cancelled && setStatus(msg))
      .then((r) => !cancelled && setFound(r))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [run]);

  const open = (f: Found) => {
    if (!f.kind || !describe(f.kind).available) {
      // An unrecognized camera: the generic camera setup (or stream link) handles it.
      router.push({ pathname: '/onboarding/connect', params: { kind: describe('onvif').available ? 'onvif' : 'rtsp', address: f.host } });
      return;
    }
    router.push({ pathname: '/onboarding/connect', params: { kind: f.kind, address: f.address } });
  };

  return (
    <Screen style={{ paddingTop: insets.top + 56 }}>
      <T v="title">Finding cameras</T>
      {!found && !error && (
        <View style={styles.center}>
          <ActivityIndicator size="large" />
          <T muted>{status}</T>
          <T v="caption" muted style={{ textAlign: 'center' }}>
            If your phone asks to find devices on your local network, tap Allow.
          </T>
        </View>
      )}
      {error && <T color={p.danger}>{error}</T>}
      {found && found.length === 0 && (
        <T muted>Nothing found. Make sure you’re on your home Wi-Fi, or choose your brand on the previous screen.</T>
      )}
      {found?.map((f) => {
        const supported = !!f.kind && describe(f.kind).available;
        return (
          <Pressable
            key={f.host}
            onPress={() => open(f)}
            style={({ pressed }) => [styles.item, { backgroundColor: pressed ? p.surfaceRaised : p.surface, borderColor: p.border }]}>
            <SymbolView name={f.kind === 'hub' ? 'server.rack' : f.kind ? 'externaldrive.connected.to.line.below' : 'video'} tintColor={p.accent} size={24} />
            <View style={{ flex: 1 }}>
              <T v="label">{f.label}</T>
              <T v="caption" muted>
                {f.address}
                {f.kind && !supported ? ' · support coming soon' : ''}
              </T>
            </View>
            <T muted>›</T>
          </Pressable>
        );
      })}
      {(found || error) && (
        <Button
          title="Look again"
          kind="secondary"
          onPress={() => {
            setFound(null);
            setError(null);
            setRun((n) => n + 1);
          }}
        />
      )}
      <Button title="Choose my brand instead" kind="ghost" onPress={() => router.back()} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', gap: space.md, paddingVertical: space.xxl },
  item: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.lg, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth },
});

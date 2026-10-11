import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, Screen, T } from '@/components/ui/primitives';
import { useT } from '@/i18n/use-t';
import { describe } from '@/systems/catalog';
import { discover, type Found } from '@/systems/discovery';
import { space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';

/** "Find my cameras": scans home Wi-Fi and lists what it recognized. Tap one to connect. */
export default function Discover() {
  const p = usePalette();
  const t = useT();
  const s = t.onboarding.discover;
  const insets = useSafeAreaInsets();
  const [found, setFound] = useState<Found[] | null>(null);
  const [status, setStatus] = useState(s.starting);
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
    if (!f.kind) {
      // An unrecognized camera: the generic camera setup (or stream link) handles it.
      router.push({ pathname: '/onboarding/connect', params: { kind: describe('onvif').available ? 'onvif' : 'rtsp', address: f.host } });
      return;
    }
    router.push({ pathname: '/onboarding/connect', params: { kind: f.kind, address: f.address } });
  };

  return (
    <Screen style={{ paddingTop: insets.top + 56 }}>
      <T v="title">{s.title}</T>
      {!found && !error && (
        <View style={styles.center}>
          <ActivityIndicator size="large" />
          <T muted>{status}</T>
          <T v="caption" muted style={{ textAlign: 'center' }}>
            {s.allowHint}
          </T>
        </View>
      )}
      {error && <T color={p.danger}>{error}</T>}
      {found && found.length === 0 && <T muted>{s.nothingFound}</T>}
      {found?.map((f) => {
        // A brand Sightline recognizes but can't connect to yet: shown, but not tappable.
        const unsupported = !!f.kind && !describe(f.kind).available;
        const note = unsupported
          ? s.cantConnectYet
          : f.kind
            ? f.address
            : s.unknownBrand(f.address);
        return (
          <Pressable
            key={f.host}
            onPress={() => open(f)}
            disabled={unsupported}
            accessibilityRole="button"
            accessibilityState={{ disabled: unsupported }}
            accessibilityLabel={`${f.label}. ${note}`}
            style={({ pressed }) => [
              styles.item,
              { backgroundColor: pressed ? p.surfaceRaised : p.surface, borderColor: p.border, opacity: unsupported ? 0.55 : 1 },
            ]}>
            <SymbolView name={f.kind === 'hub' ? 'server.rack' : f.kind ? 'externaldrive.connected.to.line.below' : 'video'} tintColor={p.accent} size={24} />
            <View style={{ flex: 1 }}>
              <T v="label">{f.label}</T>
              <T v="caption" muted>
                {note}
              </T>
            </View>
            {!unsupported && <SymbolView name="chevron.right" tintColor={p.textMuted} size={13} weight="semibold" />}
          </Pressable>
        );
      })}
      {(found || error) && (
        <Button
          title={s.lookAgain}
          kind="secondary"
          onPress={() => {
            setFound(null);
            setError(null);
            setRun((n) => n + 1);
          }}
        />
      )}
      <Button title={s.chooseBrand} kind="ghost" onPress={() => router.back()} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', gap: space.md, paddingVertical: space.xxl },
  item: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.lg, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth },
});

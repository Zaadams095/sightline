import { useMutation, useQuery } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { SymbolView } from 'expo-symbols';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, View } from 'react-native';

import { T } from '@/components/ui/primitives';
import { tr } from '@/i18n';
import { useT } from '@/i18n/use-t';
import type { CameraSystemAdapter, DeterAction } from '@/systems/types';
import { deterButtons, sirenConfirmText } from '@/talk/talk-core';

const AMBER = '#FFD60A';
const RED = '#FF453A';

/**
 * Spotlight and siren for cameras that have them (from the device's own capability flags).
 * Nothing renders for a camera without either. The siren always asks first.
 */
export function DeterControls({ adapter, systemId, cameraId }: { adapter: CameraSystemAdapter; systemId: string; cameraId: string }) {
  const t = useT();
  const supported = adapter.capabilities.deter && !!adapter.deterInfo && !!adapter.deter;
  const info = useQuery({
    queryKey: ['deter-info', systemId, cameraId],
    queryFn: () => adapter.deterInfo!(cameraId),
    enabled: supported,
    staleTime: 30 * 60_000,
    retry: false,
  });
  const buttons = deterButtons(adapter.capabilities, info.data);
  const [lightOn, setLightOn] = useState(false);
  const [error, setError] = useState<string>();

  // Lights that switch themselves off: show them off again when they do.
  const autoOff = info.data?.lightAutoOffSec ?? 0;
  useEffect(() => {
    if (!lightOn || autoOff <= 0) return;
    const t = setTimeout(() => setLightOn(false), autoOff * 1000);
    return () => clearTimeout(t);
  }, [lightOn, autoOff]);

  const run = useMutation({
    mutationFn: (action: DeterAction) => adapter.deter!(cameraId, action),
    onMutate: () => setError(undefined),
    onSuccess: (_, action) => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      if (action !== 'siren') setLightOn(action === 'light-on');
    },
    onError: (e) => setError(e instanceof Error ? e.message : tr().viewing.talk.noResponse),
  });

  if (!buttons.light && !buttons.siren) return null;

  const confirmSiren = () =>
    Alert.alert(t.viewing.talk.sirenTitle, sirenConfirmText(info.data!), [
      { text: t.common.cancel, style: 'cancel' },
      { text: t.viewing.talk.soundSiren, style: 'destructive', onPress: () => run.mutate('siren') },
    ]);

  const busy = (a: DeterAction | 'light') =>
    run.isPending && (a === 'light' ? run.variables !== 'siren' : run.variables === a);

  return (
    <View style={{ gap: 6 }}>
      <View style={styles.row}>
        {buttons.light && (
          <Pressable
            onPress={() => run.mutate(lightOn ? 'light-off' : 'light-on')}
            disabled={run.isPending}
            accessibilityRole="switch"
            accessibilityLabel={t.viewing.talk.spotlight}
            accessibilityState={{ checked: lightOn, busy: busy('light') }}
            style={[styles.btn, lightOn && { backgroundColor: 'rgba(255,214,10,0.28)' }]}>
            {busy('light') ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <SymbolView name={lightOn ? 'lightbulb.max.fill' : 'lightbulb'} tintColor={lightOn ? AMBER : '#fff'} size={20} />
            )}
            <T v="caption" color="#fff">
              {lightOn ? t.viewing.talk.spotlightOn : t.viewing.talk.spotlight}
            </T>
          </Pressable>
        )}
        {buttons.siren && (
          <Pressable
            onPress={confirmSiren}
            disabled={run.isPending}
            accessibilityRole="button"
            accessibilityLabel={t.viewing.talk.sirenA11y}
            accessibilityState={{ busy: busy('siren') }}
            style={styles.btn}>
            {busy('siren') ? <ActivityIndicator color="#fff" /> : <SymbolView name="light.beacon.max.fill" tintColor={RED} size={20} />}
            <T v="caption" color="#fff">
              {t.viewing.talk.siren}
            </T>
          </Pressable>
        )}
      </View>
      {error && (
        <T v="caption" color="rgba(255,255,255,0.7)">
          {error}
        </T>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  btn: {
    flex: 1,
    alignItems: 'center',
    gap: 6,
    paddingVertical: 12,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
});

import { useQuery } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { Chip, T } from '@/components/ui/primitives';
import { SymbolView, type SFSymbol } from '@/components/ui/symbol';
import type { Strings } from '@/i18n';
import { useT } from '@/i18n/use-t';
import type { CameraSystemAdapter, PtzAction } from '@/systems/types';
import { usePalette } from '@/theme/use-palette';

/** Hold-to-move PTZ pad: press sends a continuous move, release sends STOP. */
export function PtzPad({ adapter, cameraId }: { adapter: CameraSystemAdapter; cameraId: string }) {
  const t = useT();
  const info = useQuery({
    queryKey: ['ptz', adapter.config.id, cameraId],
    queryFn: () => adapter.ptzInfo!(cameraId),
    enabled: !!adapter.ptzInfo,
    staleTime: Infinity,
  });

  const [failed, setFailed] = useState(false);
  const send = (a: PtzAction | `preset_${string}`) => {
    if (!adapter.ptz) return;
    adapter
      .ptz(cameraId, a)
      .then(() => a !== 'STOP' && setFailed(false))
      .catch(() => setFailed(true));
  };

  const canMove = info.data?.canMove ?? true;
  const canZoom = info.data?.canZoom ?? false;

  if (info.isLoading) {
    return (
      <View style={[styles.root, styles.center]}>
        <ActivityIndicator color="#fff" />
        <T v="caption" color="rgba(255,255,255,0.6)">
          {t.home.ptz.loading}
        </T>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      {failed && (
        <T v="caption" color="#FF9F0A" style={{ textAlign: 'center', paddingHorizontal: 16 }}>
          {t.home.ptz.noResponse}
        </T>
      )}
      {info.isError && (
        <T v="caption" color="rgba(255,255,255,0.6)" style={{ textAlign: 'center', paddingHorizontal: 16 }}>
          {t.home.ptz.readFailed}
        </T>
      )}
      <View style={styles.controls}>
        {canMove && (
          <View style={styles.dpad}>
            <View style={styles.row}>
              <Btn icon="chevron.up" action="MOVE_UP" send={send} />
            </View>
            <View style={styles.row}>
              <Btn icon="chevron.left" action="MOVE_LEFT" send={send} />
              <View style={styles.spacer} />
              <Btn icon="chevron.right" action="MOVE_RIGHT" send={send} />
            </View>
            <View style={styles.row}>
              <Btn icon="chevron.down" action="MOVE_DOWN" send={send} />
            </View>
          </View>
        )}
        {canZoom && (
          <View style={styles.zoom}>
            <Btn icon="plus.magnifyingglass" action="ZOOM_IN" send={send} />
            <Btn icon="minus.magnifyingglass" action="ZOOM_OUT" send={send} />
          </View>
        )}
      </View>
      {!!info.data?.presets.length && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.presets}>
          {info.data.presets.map((name) => (
            <Chip key={name} label={name} selected={false} onPress={() => send(`preset_${name}`)} />
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const SPOKEN: Partial<Record<PtzAction, keyof Strings['home']['ptz']>> = {
  MOVE_UP: 'up',
  MOVE_DOWN: 'down',
  MOVE_LEFT: 'left',
  MOVE_RIGHT: 'right',
  ZOOM_IN: 'zoomIn',
  ZOOM_OUT: 'zoomOut',
};

function Btn({ icon, action, send }: { icon: SFSymbol; action: PtzAction; send: (a: PtzAction) => void }) {
  const p = usePalette();
  const t = useT();
  const spoken = SPOKEN[action];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={spoken ? t.home.ptz[spoken] : action}
      accessibilityHint={t.home.ptz.holdHint}
      onPressIn={() => {
        void Haptics.selectionAsync();
        send(action);
      }}
      onPressOut={() => send('STOP')}
      hitSlop={6}
      style={({ pressed }) => [styles.btn, { backgroundColor: pressed ? p.accent : 'rgba(255,255,255,0.12)' }]}>
      <SymbolView name={icon} tintColor="#fff" size={22} />
    </Pressable>
  );
}

const SIZE = 52;
const styles = StyleSheet.create({
  root: { gap: 14 },
  center: { alignItems: 'center', justifyContent: 'center', paddingVertical: 24 },
  controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 36 },
  dpad: { gap: 6 },
  row: { flexDirection: 'row', justifyContent: 'center', gap: 6 },
  spacer: { width: SIZE },
  zoom: { gap: 10 },
  btn: { width: SIZE, height: SIZE, borderRadius: SIZE / 2, alignItems: 'center', justifyContent: 'center' },
  presets: { gap: 8, paddingHorizontal: 16 },
});

import { useQuery } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { SymbolView, type SFSymbol } from 'expo-symbols';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { Chip } from '@/components/ui/primitives';
import type { CameraSystemAdapter, PtzAction } from '@/systems/types';
import { usePalette } from '@/theme/use-palette';

/** Hold-to-move PTZ pad: press sends a continuous move, release sends STOP. */
export function PtzPad({ adapter, cameraId }: { adapter: CameraSystemAdapter; cameraId: string }) {
  const info = useQuery({
    queryKey: ['ptz', adapter.config.id, cameraId],
    queryFn: () => adapter.ptzInfo!(cameraId),
    enabled: !!adapter.ptzInfo,
    staleTime: Infinity,
  });

  const send = (a: PtzAction | `preset_${string}`) => {
    adapter.ptz?.(cameraId, a).catch(() => {});
  };

  const canMove = info.data?.canMove ?? true;
  const canZoom = info.data?.canZoom ?? false;

  return (
    <View style={styles.root}>
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

function Btn({ icon, action, send }: { icon: SFSymbol; action: PtzAction; send: (a: PtzAction) => void }) {
  const p = usePalette();
  return (
    <Pressable
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
  controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 36 },
  dpad: { gap: 6 },
  row: { flexDirection: 'row', justifyContent: 'center', gap: 6 },
  spacer: { width: SIZE },
  zoom: { gap: 10 },
  btn: { width: SIZE, height: SIZE, borderRadius: SIZE / 2, alignItems: 'center', justifyContent: 'center' },
  presets: { gap: 8, paddingHorizontal: 16 },
});

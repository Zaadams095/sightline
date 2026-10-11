import { useEffect, useState } from 'react';
import { FlatList, Image, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { snapshotUrl, type HubCamera } from './hub';
import { colors } from './theme';

const REFRESH_MS = 5000;
const GAP = 24;
const PAD = 64;

/** A still that swaps in the next frame only once it has loaded (no flashing). */
function LiveStill({ uri }: { uri: string }) {
  const [shown, setShown] = useState(uri);
  useEffect(() => {
    let alive = true;
    Image.prefetch(uri)
      .then(() => alive && setShown(uri))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [uri]);
  return <Image source={{ uri: shown }} style={StyleSheet.absoluteFill} resizeMode="cover" />;
}

function Tile({
  camera,
  uri,
  width,
  preferred,
  onPress,
}: {
  camera: HubCamera;
  uri: string;
  width: number;
  preferred: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      hasTVPreferredFocus={preferred}
      style={({ focused }) => [
        styles.tile,
        { width, height: (width * 9) / 16 },
        focused && { borderColor: colors.accent, transform: [{ scale: 1.04 }] },
      ]}
    >
      <LiveStill uri={uri} />
      <View style={styles.label}>
        <Text style={styles.labelText} numberOfLines={1}>
          {camera.name}
        </Text>
      </View>
    </Pressable>
  );
}

export function GridScreen({
  hubName,
  base,
  token,
  cameras,
  columns,
  onColumns,
  onOpen,
  onTour,
  onDisconnect,
}: {
  hubName: string;
  base: string;
  token: string;
  cameras: HubCamera[];
  columns: 2 | 3;
  onColumns: (c: 2 | 3) => void;
  onOpen: (index: number) => void;
  /** Full-screen tour of every camera that switches to the doorbell on a ring. */
  onTour: () => void;
  onDisconnect: () => void;
}) {
  const { width } = useWindowDimensions();
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setTick(Date.now()), REFRESH_MS);
    return () => clearInterval(t);
  }, []);
  const tileWidth = (width - PAD * 2 - GAP * (columns - 1)) / columns;
  const height = columns === 2 ? 540 : 360;

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.title}>{hubName}</Text>
        <View style={styles.actions}>
          {cameras.length > 0 && (
            <Pressable onPress={onTour} style={({ focused }) => [styles.button, focused && styles.buttonFocused]}>
              <Text style={styles.buttonText}>Tour</Text>
            </Pressable>
          )}
          <Pressable onPress={() => onColumns(columns === 2 ? 3 : 2)} style={({ focused }) => [styles.button, focused && styles.buttonFocused]}>
            <Text style={styles.buttonText}>{columns === 2 ? '3 × 3' : '2 × 2'}</Text>
          </Pressable>
          <Pressable onPress={onDisconnect} style={({ focused }) => [styles.button, focused && styles.buttonFocused]}>
            <Text style={styles.buttonText}>Disconnect TV</Text>
          </Pressable>
        </View>
      </View>
      {cameras.length === 0 ? (
        <Text style={styles.empty}>No cameras are shared with this TV.</Text>
      ) : (
        <FlatList
          key={columns}
          data={cameras}
          numColumns={columns}
          keyExtractor={(c) => c.id}
          contentContainerStyle={{ paddingHorizontal: PAD, paddingBottom: PAD, gap: GAP }}
          columnWrapperStyle={{ gap: GAP }}
          renderItem={({ item, index }) => (
            <Tile camera={item} uri={snapshotUrl(base, token, item.id, height, tick)} width={tileWidth} preferred={index === 0} onPress={() => onOpen(index)} />
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: PAD, paddingTop: 48, paddingBottom: 24 },
  title: { color: colors.text, fontSize: 48, fontWeight: '700' },
  actions: { flexDirection: 'row', gap: 20 },
  button: { paddingHorizontal: 28, paddingVertical: 14, borderRadius: 14, backgroundColor: colors.surfaceRaised },
  buttonFocused: { backgroundColor: colors.accent },
  buttonText: { color: colors.text, fontSize: 28, fontWeight: '600' },
  tile: { borderRadius: 20, overflow: 'hidden', backgroundColor: colors.surface, borderWidth: 6, borderColor: 'transparent' },
  label: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 20, paddingVertical: 12, backgroundColor: 'rgba(0,0,0,0.5)' },
  labelText: { color: '#FFFFFF', fontSize: 30, fontWeight: '600' },
  empty: { color: colors.textMuted, fontSize: 32, paddingHorizontal: PAD },
});

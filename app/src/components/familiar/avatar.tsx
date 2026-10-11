import { Image } from 'expo-image';
import { StyleSheet, View } from 'react-native';

import { usePalette } from '@/theme/use-palette';

/** A round face / vehicle crop (stored on this iPhone), or a blank circle. */
export function Avatar({ uri, size = 36 }: { uri?: string; size?: number }) {
  const p = usePalette();
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, overflow: 'hidden', backgroundColor: p.surfaceRaised }}>
      {uri ? <Image source={{ uri }} style={StyleSheet.absoluteFill} contentFit="cover" /> : null}
    </View>
  );
}

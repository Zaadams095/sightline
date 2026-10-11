import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { IconButton, T } from '@/components/ui/primitives';
import { useT } from '@/i18n/use-t';
import { space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';
import { Ask } from '@modules/ask';

/** Search-bar style entry to "Ask your cameras", at the top of the Recordings tab. */
export function AskBar() {
  const p = usePalette();
  const t = useT();
  const [canListen] = useState(() => {
    try {
      return !!Ask?.speechAvailable();
    } catch {
      return false;
    }
  });
  return (
    <View style={[styles.bar, { backgroundColor: p.surface, borderColor: p.border }]}>
      <Pressable
        onPress={() => router.push('/ask')}
        accessibilityRole="search"
        accessibilityLabel={t.ask.bar.label}
        style={styles.tap}>
        <SymbolView name="sparkles" tintColor={p.accent} size={16} />
        <T muted style={{ flex: 1 }}>
          {t.ask.bar.hint}
        </T>
      </Pressable>
      {canListen && (
        <IconButton icon="mic.fill" label={t.ask.bar.speak} onPress={() => router.push({ pathname: '/ask', params: { listen: '1' } })} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: space.lg,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    minHeight: 44,
  },
  tap: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingLeft: space.md, paddingVertical: space.sm, minHeight: 44 },
});

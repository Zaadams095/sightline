import { Image } from 'expo-image';
import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet, View } from 'react-native';

import { T } from '@/components/ui/primitives';
import { useT } from '@/i18n/use-t';
import { formatSpan, storyTitle, type Story } from '@/stories/group';
import { openStory } from '@/stories/open';
import type { ReviewItem } from '@/systems/types';
import { space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';
import { formatClock } from '@/util/format';

/** A story in the Recordings list: the steps' pictures, who, the path and how long it took. */
export function StoryRow({ story, nameOf }: { story: Story<ReviewItem>; nameOf: (cameraKey: string) => string }) {
  const p = usePalette();
  const t = useT();
  const thumbs = story.steps
    .map((s) => s.items.find((i) => i.thumbnailUrl)?.thumbnailUrl)
    .filter((u): u is string => !!u)
    .slice(0, 4);
  return (
    <Pressable
      onPress={() => openStory(story)}
      accessibilityRole="button"
      accessibilityLabel={t.viewing.story.openA11y(storyTitle(story))}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: p.surface }]}>
      <View style={styles.strip}>
        {thumbs.length ? (
          thumbs.map((u, i) => (
            <View key={`${u}:${i}`} style={[styles.thumb, { backgroundColor: p.surface }]}>
              <Image source={{ uri: u }} style={StyleSheet.absoluteFill} contentFit="cover" />
            </View>
          ))
        ) : (
          <View style={[styles.thumb, styles.center, { backgroundColor: p.surface }]}>
            <SymbolView name="figure.walk" tintColor={p.textMuted} size={18} />
          </View>
        )}
      </View>
      <View style={{ gap: 2 }}>
        <T v="label">
          {storyTitle(story)} · {formatClock(story.start)}
        </T>
        <T v="caption" muted>
          {story.steps.map((s) => nameOf(s.cameraKey)).join(' → ')} ({formatSpan(story.end - story.start)})
        </T>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.sm },
  strip: { flexDirection: 'row', gap: 4 },
  thumb: { flex: 1, maxWidth: 110, aspectRatio: 16 / 9, borderRadius: 8, overflow: 'hidden' },
  center: { alignItems: 'center', justifyContent: 'center' },
});

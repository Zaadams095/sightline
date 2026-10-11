import { useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';

import type { RecordingSegment, ReviewItem } from '@/systems/types';
import { usePalette } from '@/theme/use-palette';

interface Props {
  dayStart: number;
  dayEnd: number;
  time: number;
  segments: RecordingSegment[];
  events: ReviewItem[];
  /** Part of the day currently loaded in the detail timeline. */
  window: [number, number];
  onSeek: (t: number) => void;
}

/** Whole-day strip: recording coverage, event ticks, and the loaded window. Tap or drag to jump. */
export function DayOverview({ dayStart, dayEnd, time, segments, events, window, onSeek }: Props) {
  const p = usePalette();
  const [w, setW] = useState(0);
  const span = dayEnd - dayStart;
  const x = (t: number) => ((t - dayStart) / span) * w;
  const tAt = (px: number) => dayStart + Math.min(1, Math.max(0, px / Math.max(1, w))) * span;

  const tap = Gesture.Tap().runOnJS(true).onEnd((e) => onSeek(tAt(e.x)));
  const pan = Gesture.Pan().runOnJS(true).onEnd((e) => onSeek(tAt(e.x)));

  return (
    <GestureDetector gesture={Gesture.Exclusive(pan, tap)}>
      <View style={[styles.root, { backgroundColor: p.surface }]} onLayout={(e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width)}>
        {w > 0 && (
          <>
            {segments.map((s) => (
              <View key={s.start} style={[styles.rec, { left: x(s.start), width: Math.max(1, x(s.end) - x(s.start)), backgroundColor: p.surfaceRaised }]} />
            ))}
            <View style={[styles.window, { left: x(window[0]), width: Math.max(2, x(window[1]) - x(window[0])), borderColor: p.accent }]} />
            {events.map((e) => (
              <View key={e.id} style={[styles.event, { left: x(e.startTime), backgroundColor: e.severity === 'alert' ? p.danger : p.warning }]} />
            ))}
            {[6, 12, 18].map((h) => (
              <View key={h} style={[styles.hour, { left: (h / 24) * w, backgroundColor: p.border }]} />
            ))}
            <View style={[styles.now, { left: x(time) - 1, backgroundColor: p.text }]} />
          </>
        )}
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  root: { height: 22, borderRadius: 6, overflow: 'hidden', marginHorizontal: 16 },
  rec: { position: 'absolute', top: 4, bottom: 4 },
  window: { position: 'absolute', top: 1, bottom: 1, borderWidth: 1.5, borderRadius: 4 },
  event: { position: 'absolute', top: 6, bottom: 6, width: 2, borderRadius: 1 },
  hour: { position: 'absolute', top: 0, bottom: 0, width: StyleSheet.hairlineWidth },
  now: { position: 'absolute', top: 0, bottom: 0, width: 2 },
});

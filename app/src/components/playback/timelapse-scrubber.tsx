import { useMemo, useState } from 'react';
import { StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';

import type { RecordingSegment, ReviewItem } from '@/systems/types';
import { hourTicks } from '@/util/timelapse';

interface Props {
  start: number;
  end: number;
  time: number;
  segments: RecordingSegment[];
  events: ReviewItem[];
  onSeek: (t: number) => void;
}

const DOT = { doorbell: '#7C5CFF', package: '#FFB020', person: '#FF453A', other: 'rgba(255,255,255,0.55)' };

function colorFor(e: ReviewItem) {
  if (e.objects.includes('doorbell')) return DOT.doorbell;
  if (e.objects.includes('package')) return DOT.package;
  if (e.objects.includes('person') || e.severity === 'alert') return DOT.person;
  return DOT.other;
}

/** Timelapse scrubber: hour ticks with labels, recorded spans, event markers. Tap or drag to jump. */
export function TimelapseScrubber({ start, end, time, segments, events, onSeek }: Props) {
  const [w, setW] = useState(0);
  const span = Math.max(1, end - start);
  const x = (t: number) => ((t - start) / span) * w;
  const tAt = (px: number) => start + Math.min(1, Math.max(0, px / Math.max(1, w))) * span;
  const ticks = useMemo(() => hourTicks(start, end), [start, end]);

  const tap = Gesture.Tap().runOnJS(true).onEnd((e) => onSeek(tAt(e.x)));
  const pan = Gesture.Pan().runOnJS(true).onEnd((e) => onSeek(tAt(e.x)));

  return (
    <View style={styles.wrap}>
      <GestureDetector gesture={Gesture.Exclusive(pan, tap)}>
        <View style={styles.bar} onLayout={(e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width)}>
          {w > 0 && (
            <>
              {segments.map((s) => (
                <View key={s.start} style={[styles.rec, { left: x(Math.max(start, s.start)), width: Math.max(1, x(Math.min(end, s.end)) - x(Math.max(start, s.start))) }]} />
              ))}
              {ticks.map((t) => (
                <View key={t.t} style={[styles.tick, { left: x(t.t), top: t.label ? 0 : 10 }]} />
              ))}
              {events.map((e) => (
                <View key={e.id} style={[styles.event, { left: x(e.startTime) - 3, backgroundColor: colorFor(e) }]} />
              ))}
              <View style={[styles.played, { width: Math.max(0, x(time)) }]} />
              <View style={[styles.head, { left: x(time) - 1.5 }]} />
            </>
          )}
        </View>
      </GestureDetector>
      <View style={styles.labels}>
        {w > 0 &&
          ticks
            .filter((t) => t.label)
            .map((t) => (
              <Text key={t.t} maxFontSizeMultiplier={1.3} style={[styles.label, { left: Math.min(w - 44, Math.max(0, x(t.t) - 22)) }]}>
                {t.label}
              </Text>
            ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginHorizontal: 16, gap: 4 },
  bar: { height: 36, borderRadius: 8, overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.08)' },
  rec: { position: 'absolute', top: 12, bottom: 12, backgroundColor: 'rgba(255,255,255,0.18)', borderRadius: 2 },
  tick: { position: 'absolute', bottom: 0, width: StyleSheet.hairlineWidth, backgroundColor: 'rgba(255,255,255,0.35)' },
  event: { position: 'absolute', top: 4, width: 6, height: 6, borderRadius: 3 },
  played: { position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: 'rgba(124,92,255,0.18)' },
  head: { position: 'absolute', top: 0, bottom: 0, width: 3, borderRadius: 2, backgroundColor: '#fff' },
  labels: { height: 18 },
  label: { position: 'absolute', width: 44, textAlign: 'center', fontSize: 10, fontWeight: '600', color: 'rgba(255,255,255,0.6)' },
});

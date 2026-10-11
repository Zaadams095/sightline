import { useEffect, useRef } from 'react';
import { ScrollView, StyleSheet, Text, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';

import type { MotionPoint, RecordingSegment, ReviewItem } from '@/systems/types';
import { OVERLAY_MAX_SCALE } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';
import { formatClock } from '@/util/format';

interface Props {
  width: number;
  start: number;
  end: number;
  /** Current playhead (unix seconds). */
  time: number;
  segments: RecordingSegment[];
  events: ReviewItem[];
  motion: MotionPoint[];
  motionScaleSec: number;
  pxPerSec: number;
  /** Fired continuously while dragging (for the time readout). */
  onScrub?: (t: number) => void;
  /** Fired when the user lets go: seek here. */
  onSeek: (t: number) => void;
}

const HEIGHT = 84;

function tickEvery(pxPerSec: number) {
  if (pxPerSec >= 3) return 60;
  if (pxPerSec >= 1) return 300;
  return 900;
}

/**
 * Detail scrubber with a fixed center playhead. Recording spans are bars, motion is a
 * small histogram, and review items are colored pins. Follows the playhead unless dragged.
 */
export function Timeline({ width, start, end, time, segments, events, motion, motionScaleSec, pxPerSec, onScrub, onSeek }: Props) {
  const p = usePalette();
  const scroll = useRef<ScrollView>(null);
  const dragging = useRef(false);
  const half = width / 2;
  const contentW = Math.max(1, (end - start) * pxPerSec);
  const x = (t: number) => (t - start) * pxPerSec;

  useEffect(() => {
    if (!dragging.current) scroll.current?.scrollTo({ x: x(time), animated: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [time, start, pxPerSec]);

  const tAt = (e: NativeSyntheticEvent<NativeScrollEvent>) =>
    Math.min(end, Math.max(start, start + e.nativeEvent.contentOffset.x / pxPerSec));

  const every = tickEvery(pxPerSec);
  const ticks: number[] = [];
  for (let t = Math.ceil(start / every) * every; t <= end; t += every) ticks.push(t);
  const labelEvery = every * (pxPerSec >= 3 ? 5 : 3);
  const barW = Math.max(1, motionScaleSec * pxPerSec - 1);

  return (
    <View style={{ width, height: HEIGHT }}>
      <ScrollView
        ref={scroll}
        horizontal
        showsHorizontalScrollIndicator={false}
        scrollEventThrottle={32}
        decelerationRate="fast"
        onScrollBeginDrag={() => (dragging.current = true)}
        onScroll={(e) => dragging.current && onScrub?.(tAt(e))}
        onScrollEndDrag={(e) => {
          if ((e.nativeEvent.velocity?.x ?? 0) === 0) {
            dragging.current = false;
            onSeek(tAt(e));
          }
        }}
        onMomentumScrollEnd={(e) => {
          if (!dragging.current) return;
          dragging.current = false;
          onSeek(tAt(e));
        }}
        contentContainerStyle={{ width: contentW + width }}>
        <View style={{ marginLeft: half, width: contentW, height: HEIGHT }}>
          {ticks.map((t) => (
            <View key={t} style={[styles.tick, { left: x(t) }]}>
              <View style={[styles.tickLine, { backgroundColor: p.border, height: t % labelEvery === 0 ? 12 : 6 }]} />
              {t % labelEvery === 0 && (
                // The scrubber has a fixed height, so its time marks grow only a little.
                <Text style={[styles.tickLabel, { color: p.textMuted }]} maxFontSizeMultiplier={OVERLAY_MAX_SCALE}>
                  {formatClock(t)}
                </Text>
              )}
            </View>
          ))}
          {segments.map((s) => (
            <View
              key={s.start}
              style={[styles.segment, { left: x(s.start), width: Math.max(2, (s.end - s.start) * pxPerSec), backgroundColor: p.surfaceRaised }]}
            />
          ))}
          {motion.map((m) =>
            m.v > 3 ? (
              <View
                key={m.t}
                style={[styles.motion, { left: x(m.t), width: barW, height: 2 + (m.v / 100) * 18, backgroundColor: p.accent }]}
              />
            ) : null,
          )}
          {events.map((ev) => (
            <View
              key={ev.id}
              style={[
                styles.event,
                {
                  left: x(ev.startTime),
                  width: Math.max(4, ((ev.endTime ?? end) - ev.startTime) * pxPerSec),
                  backgroundColor: ev.severity === 'alert' ? p.danger : p.warning,
                },
              ]}>
              <View style={[styles.pin, { backgroundColor: ev.severity === 'alert' ? p.danger : p.warning }]} />
            </View>
          ))}
        </View>
      </ScrollView>
      <View pointerEvents="none" style={[styles.playhead, { left: half - 1, backgroundColor: p.text }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  tick: { position: 'absolute', top: 0, alignItems: 'center' },
  tickLine: { width: 1 },
  tickLabel: { fontSize: 10, marginTop: 2, fontVariant: ['tabular-nums'] },
  segment: { position: 'absolute', top: 30, height: 30, borderRadius: 4 },
  motion: { position: 'absolute', bottom: 24, borderRadius: 1, opacity: 0.55 },
  event: { position: 'absolute', top: 62, height: 6, borderRadius: 3 },
  pin: { position: 'absolute', left: -3, top: -8, width: 8, height: 8, borderRadius: 4 },
  playhead: { position: 'absolute', top: 16, bottom: 4, width: 2, borderRadius: 1 },
});

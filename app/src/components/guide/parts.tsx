import { SymbolView } from 'expo-symbols';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { Button, T } from '@/components/ui/primitives';
import { useT } from '@/i18n/use-t';
import { discoverFor, type Found } from '@/systems/discovery';
import type { StreamTarget, SystemTarget } from '@/systems/guides';
import { space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';

/** "Step 2 of 3" as a segmented bar, with a spoken label. */
export function GuideProgress({ step, total, label }: { step: number; total: number; label: string }) {
  const p = usePalette();
  const t = useT();
  return (
    <View accessible accessibilityRole="progressbar" accessibilityLabel={t.guides.parts.stepOfA11y(step, total, label)} style={{ gap: space.xs }}>
      <View style={{ flexDirection: 'row', gap: 6 }}>
        {Array.from({ length: total }, (_, i) => (
          <View key={i} style={[styles.segment, { backgroundColor: i < step ? p.accent : p.surfaceRaised, borderColor: p.border }]} />
        ))}
      </View>
      <T v="caption" muted>
        {t.guides.parts.stepOf(step, total, label)}
      </T>
    </View>
  );
}

/** Numbered steps, big and easy to follow. */
export function StepList({ steps }: { steps: string[] }) {
  const p = usePalette();
  return (
    <View style={{ gap: space.md }}>
      {steps.map((s, i) => (
        <View key={i} style={{ flexDirection: 'row', gap: space.md, alignItems: 'flex-start' }}>
          <View style={[styles.num, { backgroundColor: p.accent }]}>
            <T v="label" color={p.accentText}>
              {i + 1}
            </T>
          </View>
          <T style={{ flex: 1, paddingTop: 3 }}>{s}</T>
        </View>
      ))}
    </View>
  );
}

/** A big tappable row with a title, a detail line and a chevron. */
export function ChoiceRow({ title, detail, onPress, muted }: { title: string; detail?: string; onPress: () => void; muted?: boolean }) {
  const p = usePalette();
  const t = useT();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={detail ? t.guides.parts.titleDetail(title, detail) : title}
      style={({ pressed }) => [styles.row, { backgroundColor: pressed ? p.surfaceRaised : p.surface, borderColor: p.border }]}>
      <View style={{ flex: 1, gap: 2 }}>
        <T v="label" color={muted ? p.textMuted : undefined}>
          {title}
        </T>
        {detail && (
          <T v="caption" muted>
            {detail}
          </T>
        )}
      </View>
      <SymbolView name="chevron.right" tintColor={p.textMuted} size={13} weight="semibold" />
    </Pressable>
  );
}

/**
 * "Find it for me": scans the home Wi-Fi for devices that look like this brand and lets the
 * user tap one instead of typing an address.
 */
export function FindOnNetwork({ target, onPick, autoStart }: { target: StreamTarget | SystemTarget; onPick: (f: Found) => void; autoStart?: boolean }) {
  const p = usePalette();
  const t = useT();
  const [state, setState] = useState<'idle' | 'busy' | 'done'>(autoStart ? 'busy' : 'idle');
  const [status, setStatus] = useState(t.guides.parts.starting);
  const [found, setFound] = useState<Found[]>([]);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const scan = () =>
    discoverFor(target, (m) => alive.current && setStatus(m))
      .then((r) => alive.current && setFound(r))
      .catch((e) => alive.current && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => alive.current && setState('done'));

  const run = () => {
    setState('busy');
    setError(null);
    setStatus(t.guides.parts.starting);
    void scan();
  };

  useEffect(() => {
    alive.current = true;
    if (autoStart) void scan();
    return () => {
      alive.current = false;
    };
    // Only on first show.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (state === 'idle') return <Button title={t.guides.parts.findIt} kind="secondary" onPress={run} />;

  if (state === 'busy')
    return (
      <View style={[styles.row, { backgroundColor: p.surface, borderColor: p.border }]}>
        <ActivityIndicator />
        <View style={{ flex: 1 }}>
          <T v="label">{t.guides.parts.looking}</T>
          <T v="caption" muted>
            {t.guides.parts.lookingDetail(status)}
          </T>
        </View>
      </View>
    );

  return (
    <View style={{ gap: space.sm }}>
      {error && <T color={p.danger}>{error}</T>}
      {!error && found.length === 0 && (
        <T muted>{t.guides.parts.notFound}</T>
      )}
      {found.length > 0 && (
        <T v="caption" muted>
          {t.guides.parts.found(found.length)}
        </T>
      )}
      {found.map((f) => (
        <ChoiceRow key={f.host} title={f.label} detail={f.host} onPress={() => onPick(f)} />
      ))}
      <Button title={t.guides.parts.lookAgain} kind="ghost" onPress={run} />
    </View>
  );
}

const styles = StyleSheet.create({
  segment: { flex: 1, height: 6, borderRadius: 3, borderWidth: StyleSheet.hairlineWidth },
  // min sizes: the number grows with the text size instead of spilling out of its circle.
  num: { minWidth: 28, minHeight: 28, paddingHorizontal: 4, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.lg, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, minHeight: 56 },
});

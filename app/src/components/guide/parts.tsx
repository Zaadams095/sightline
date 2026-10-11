import { SymbolView } from 'expo-symbols';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { Button, T } from '@/components/ui/primitives';
import { discoverFor, type Found } from '@/systems/discovery';
import type { StreamTarget, SystemTarget } from '@/systems/guides';
import { space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';

/** "Step 2 of 3" as a segmented bar, with a spoken label. */
export function GuideProgress({ step, total, label }: { step: number; total: number; label: string }) {
  const p = usePalette();
  return (
    <View accessible accessibilityRole="progressbar" accessibilityLabel={`Step ${step} of ${total}: ${label}`} style={{ gap: space.xs }}>
      <View style={{ flexDirection: 'row', gap: 6 }}>
        {Array.from({ length: total }, (_, i) => (
          <View key={i} style={[styles.segment, { backgroundColor: i < step ? p.accent : p.surfaceRaised, borderColor: p.border }]} />
        ))}
      </View>
      <T v="caption" muted>
        Step {step} of {total} · {label}
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
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={detail ? `${title}. ${detail}` : title}
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
  const [state, setState] = useState<'idle' | 'busy' | 'done'>(autoStart ? 'busy' : 'idle');
  const [status, setStatus] = useState('Starting…');
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
    setStatus('Starting…');
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

  if (state === 'idle') return <Button title="Find it on my Wi-Fi" kind="secondary" onPress={run} />;

  if (state === 'busy')
    return (
      <View style={[styles.row, { backgroundColor: p.surface, borderColor: p.border }]}>
        <ActivityIndicator />
        <View style={{ flex: 1 }}>
          <T v="label">Looking for it…</T>
          <T v="caption" muted>
            {status} If your phone asks to find devices on your network, tap Allow.
          </T>
        </View>
      </View>
    );

  return (
    <View style={{ gap: space.sm }}>
      {error && <T color={p.danger}>{error}</T>}
      {!error && found.length === 0 && (
        <T muted>Didn’t spot it. Make sure the camera is on and your phone is on the same Wi-Fi, or type its address below.</T>
      )}
      {found.length > 0 && (
        <T v="caption" muted>
          {found.length === 1 ? 'Found one. Is this it?' : `Found ${found.length}. Tap the one you’re setting up.`}
        </T>
      )}
      {found.map((f) => (
        <ChoiceRow key={f.host} title={f.label} detail={f.host} onPress={() => onPick(f)} />
      ))}
      <Button title="Look again" kind="ghost" onPress={run} />
    </View>
  );
}

const styles = StyleSheet.create({
  segment: { flex: 1, height: 6, borderRadius: 3, borderWidth: StyleSheet.hairlineWidth },
  num: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.lg, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, minHeight: 56 },
});

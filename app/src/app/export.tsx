import { useQuery } from '@tanstack/react-query';
import { useKeepAwake } from 'expo-keep-awake';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Switch, View } from 'react-native';

import { Button, Chip, Row, Screen, Section, T, TimeStepper } from '@/components/ui/primitives';
import { ExportCancelled, methodNote, probeMethod, pruneExports, runExport, shareExport, type ExportProgress, type ExportResult } from '@/export/run';
import {
  customWindow,
  dayLabel,
  defaultSelection,
  describeWindow,
  estimateBytes,
  PRESETS,
  presetWindow,
  replayWarning,
  sizeText,
  sizeWarning,
  windowProblem,
  type TimeWindow,
  type VideoMethod,
  type WindowPreset,
} from '@/export/window';
import { useAllCameras, type CameraEntry } from '@/systems/registry';
import { space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';

interface Probe {
  method: VideoMethod;
  hasRecordings: boolean | null;
  events: number;
}

async function probeCamera(e: CameraEntry, w: TimeWindow): Promise<Probe> {
  const { adapter, camera } = e;
  const [segs, events, method] = await Promise.all([
    adapter.recordingSegments ? adapter.recordingSegments(camera.id, w.start, w.end).catch(() => null) : Promise.resolve(null),
    adapter.listReview
      ? adapter
          .listReview({ cameras: [camera.id], after: w.start, before: w.end, limit: 500 })
          .then((items) => items.filter((i) => i.cameraId === camera.id).length)
          .catch(() => 0)
      : Promise.resolve(0),
    probeMethod(adapter, camera.id, w).catch((): VideoMethod => 'none'),
  ]);
  return { method, hasRecordings: segs == null ? null : segs.length > 0, events };
}

function methodText(p: Probe | undefined): string {
  if (!p) return 'Checkingâ€¦';
  if (p.hasRecordings === false && p.events === 0) return 'No recordings in this time';
  const ev = p.events ? ` Â· ${p.events} event${p.events === 1 ? '' : 's'}` : '';
  if (p.method === 'clip' || p.method === 'files') return `Video${ev}`;
  if (p.method === 'replay') return `Video, copied at normal speed${ev}`;
  return `Snapshots only â€” this recorder doesnâ€™t let apps save video${ev}`;
}

const DAYS = [0, 1, 2, 3, 4, 5, 6];

/**
 * "Export for police or insurance": pick a time and cameras; Sightline gathers the video,
 * snapshots, a PDF summary and fingerprints into one .zip to AirDrop, save or mail.
 */
export default function ExportScreen() {
  const p = usePalette();
  const params = useLocalSearchParams<{ start?: string; end?: string; camera?: string }>();
  const { entries } = useAllCameras({ includeHidden: true });
  const recordable = useMemo(() => entries.filter((e) => e.adapter.capabilities.review || e.adapter.playback || e.adapter.clip), [entries]);

  const given = params.start && params.end ? { start: Math.floor(Number(params.start)), end: Math.ceil(Number(params.end)) } : null;
  const [preset, setPreset] = useState<WindowPreset>(given ? 'custom' : 'last30');
  const [now] = useState(() => new Date());
  const [day, setDay] = useState(0);
  const [startHHMM, setStartHHMM] = useState(() => hhmm(given ? new Date(given.start * 1000) : new Date(now.getTime() - 3600_000)));
  const [endHHMM, setEndHHMM] = useState(() => hhmm(given ? new Date(given.end * 1000) : now));
  const [useGiven, setUseGiven] = useState(!!given);

  const win: TimeWindow = useMemo(() => {
    if (preset !== 'custom') return presetWindow(preset, now);
    if (useGiven && given) return given;
    return customWindow(day, startHHMM, endHHMM, now);
  }, [preset, now, useGiven, given?.start, given?.end, day, startHHMM, endHHMM]); // eslint-disable-line react-hooks/exhaustive-deps
  const problem = windowProblem(win, now.getTime() / 1000);

  const probes = useQuery({
    queryKey: ['export-probe', win.start, win.end, recordable.map((e) => e.camera.key).join('|')],
    enabled: !problem && recordable.length > 0,
    staleTime: 60_000,
    queryFn: async () => {
      const out: Record<string, Probe> = {};
      await Promise.all(recordable.map(async (e) => (out[e.camera.key] = await probeCamera(e, win))));
      return out;
    },
  });

  // Default choice once the probe answers; the user's own picks win after that.
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const defaults = useMemo(() => {
    if (params.camera) return new Set([params.camera]);
    if (!probes.data) return null;
    return new Set(defaultSelection(recordable.map((e) => ({ key: e.camera.key, ...probes.data[e.camera.key] }))));
  }, [probes.data, recordable, params.camera]);
  const selected = picked ?? defaults ?? new Set<string>();
  const toggle = (key: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(key);
    else next.delete(key);
    setPicked(next);
  };

  const chosen = recordable.filter((e) => selected.has(e.camera.key));
  const methodOf = (e: CameraEntry): VideoMethod => probes.data?.[e.camera.key]?.method ?? 'none';
  const videoCams = chosen.filter((e) => methodOf(e) !== 'none').length;
  const snapOnly = chosen.filter((e) => methodOf(e) === 'none').map((e) => e.camera.name);
  const replayCams = chosen.filter((e) => methodOf(e) === 'replay').length;
  const estimate = estimateBytes(win, videoCams);
  const bigWarning = sizeWarning(estimate);
  const slowWarning = replayWarning(win, replayCams);

  // Running.
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);
  const ctrl = useRef<AbortController | null>(null);
  useEffect(() => {
    pruneExports();
    return () => ctrl.current?.abort();
  }, []);

  const start = async () => {
    const c = new AbortController();
    ctrl.current = c;
    setResult(null);
    setProgress({ fraction: 0, label: 'Getting readyâ€¦', bytes: 0 });
    try {
      const r = await runExport({
        jobs: chosen.map((entry) => ({ entry, method: methodOf(entry) })),
        // "Last 30 minutes" means up to the moment Export is tapped.
        window: preset === 'custom' ? win : presetWindow(preset, new Date()),
        signal: c.signal,
        onProgress: setProgress,
      });
      setResult(r);
      setProgress(null);
      await shareExport(r.zipUri).catch(() => {});
    } catch (e) {
      setProgress(null);
      if (e instanceof ExportCancelled) return;
      Alert.alert('The export didnâ€™t finish', e instanceof Error ? e.message : String(e));
    } finally {
      ctrl.current = null;
    }
  };

  const confirmStart = () => {
    const warnings = [bigWarning, slowWarning].filter(Boolean);
    if (!warnings.length) return void start();
    Alert.alert('Before you start', warnings.join('\n\n'), [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Start export', onPress: () => void start() },
    ]);
  };

  if (progress) return <Running progress={progress} onCancel={() => ctrl.current?.abort()} />;

  if (result) {
    const missing = result.cameras.filter((c) => c.video === 'none');
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Export ready' }} />
        <View style={{ alignItems: 'center', gap: space.md, paddingTop: space.xl }}>
          <SymbolView name="checkmark.seal.fill" tintColor={p.success} size={48} />
          <T v="heading">Your export is ready</T>
          <T muted style={{ textAlign: 'center' }}>
            {sizeText(result.bytes)} Â· {result.cameras.length} camera{result.cameras.length === 1 ? '' : 's'}
            {result.signed ? ' Â· signed by this iPhone' : ''}
          </T>
        </View>
        {missing.length > 0 && (
          <Section title="No video from">
            {missing.map((c, i) => (
              <Row key={c.name} label={c.name} detail={c.note} last={i === missing.length - 1} />
            ))}
          </Section>
        )}
        <Button title="Share or save again" onPress={() => void shareExport(result.zipUri)} />
        <Button title="Done" kind="ghost" onPress={() => router.back()} />
      </Screen>
    );
  }

  return (
    <Screen>
      <Stack.Screen options={{ title: 'Export for police or insurance' }} />
      <T muted>
        Sightline gathers video from every camera for the time you pick, with a PDF summary for whoever you send it to. Itâ€™s made on this iPhone and only leaves it when you share it.
      </T>

      <Section title="When">
        <View style={styles.chips}>
          {PRESETS.map((pr) => (
            <Chip key={pr.id} label={pr.label} selected={preset === pr.id} onPress={() => setPreset(pr.id)} />
          ))}
          <Chip label="Pick a time" selected={preset === 'custom'} onPress={() => setPreset('custom')} />
        </View>
        {preset === 'custom' && useGiven && given ? (
          <Row label="From the recording you were watching" detail="Tap to pick a different time" onPress={() => setUseGiven(false)} last />
        ) : preset === 'custom' ? (
          <>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={[styles.chips, { paddingVertical: space.sm }]}>
              {DAYS.map((d) => (
                <Chip key={d} label={dayLabel(d, now)} selected={day === d} onPress={() => setDay(d)} />
              ))}
            </ScrollView>
            <TimeStepper label="From" value={startHHMM} onChange={setStartHHMM} />
            <TimeStepper label="Until" value={endHHMM} onChange={setEndHHMM} last />
          </>
        ) : null}
      </Section>
      <T v="caption" muted color={problem ? p.danger : undefined} style={{ marginTop: -space.sm, marginHorizontal: space.xs }}>
        {problem ?? describeWindow(win, { timeZone: tzName(), offsetMin: -new Date(win.start * 1000).getTimezoneOffset() })}
      </T>

      <Section title="Cameras" footer={recordable.length ? 'Cameras with recordings or events in this time are picked for you.' : undefined}>
        {recordable.length === 0 ? (
          <Row label="No cameras with recordings" detail="Exports need a recorder (NVR, Frigate, Sightline Hubâ€¦)." last />
        ) : (
          recordable.map((e, i) => (
            <Row
              key={e.camera.key}
              label={e.camera.name}
              detail={`${e.adapter.config.name} Â· ${problem ? '' : methodText(probes.data?.[e.camera.key])}`}
              last={i === recordable.length - 1}
              right={
                probes.isLoading && !problem ? (
                  <ActivityIndicator />
                ) : (
                  <Switch value={selected.has(e.camera.key)} onValueChange={(v) => toggle(e.camera.key, v)} trackColor={{ true: p.accent }} />
                )
              }
            />
          ))
        )}
      </Section>

      {chosen.length > 0 && !problem && (
        <View style={{ gap: space.sm }}>
          <T v="caption" muted>
            {videoCams ? `About ${sizeText(estimate)} of video.` : ''}
            {snapOnly.length ? ` Snapshots only from ${snapOnly.join(', ')}: ${methodNote('none')?.replace(/^This recorder/, 'the recorder')}.` : ''}
          </T>
          {bigWarning && <T v="caption" color={p.warning}>{bigWarning}</T>}
          {slowWarning && <T v="caption" color={p.warning}>{slowWarning}</T>}
        </View>
      )}

      <Button title="Make export" onPress={confirmStart} disabled={!!problem || chosen.length === 0 || probes.isLoading} />
    </Screen>
  );
}

function Running({ progress, onCancel }: { progress: ExportProgress; onCancel: () => void }) {
  const p = usePalette();
  useKeepAwake();
  return (
    <Screen scroll={false} style={{ justifyContent: 'center' }}>
      <Stack.Screen options={{ title: 'Making your export', headerBackVisible: false, gestureEnabled: false }} />
      <View style={{ gap: space.lg, alignItems: 'stretch' }}>
        <T v="heading" style={{ textAlign: 'center' }}>
          {progress.label}
        </T>
        <View style={[styles.bar, { backgroundColor: p.surfaceRaised }]} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: Math.round(progress.fraction * 100) }}>
          <View style={{ width: `${Math.max(2, progress.fraction * 100)}%`, height: '100%', backgroundColor: p.accent, borderRadius: 6 }} />
        </View>
        <T muted style={{ textAlign: 'center' }}>
          {Math.round(progress.fraction * 100)}%{progress.bytes ? ` Â· ${sizeText(progress.bytes)} so far` : ''}
        </T>
        <T v="caption" muted style={{ textAlign: 'center' }}>
          Keep Sightline open until this finishes. The screen stays on.
        </T>
        <Button title="Cancel" kind="secondary" onPress={onCancel} />
      </View>
    </Screen>
  );
}

function hhmm(d: Date): string {
  const m = Math.floor(d.getMinutes() / 15) * 15;
  return `${String(d.getHours()).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function tzName(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  } catch {
    return '';
  }
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.md },
  bar: { height: 12, borderRadius: 6, overflow: 'hidden' },
});

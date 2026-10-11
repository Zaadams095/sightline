import { Directory, File, Paths } from 'expo-file-system';
import { Image } from 'expo-image';
import { useKeepAwake } from 'expo-keep-awake';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect, useRef, useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';

import { Button, Chip, Screen, Section, T, ToggleRow } from '@/components/ui/primitives';
import { fileStamp } from '@/export/manifest';
import { useAdapter } from '@/systems/registry';
import { space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';
import { Redact } from '@modules/redact';

type Kind = 'video' | 'photo';
type Phase = { step: 'idle' } | { step: 'working'; label: string; fraction: number } | { step: 'ready'; uri: string; kind: Kind; note: string };

const workDir = () => {
  const d = new Directory(Paths.cache, 'neighbors');
  if (!d.exists) d.create({ intermediates: true });
  return d;
};

function fresh(name: string): File {
  const f = new File(workDir(), name);
  if (f.exists) f.delete();
  return f;
}

function foundText(faces: number, plates: number): string {
  if (!faces && !plates) return 'No faces or license plates were found. Look it over before you share.';
  const parts = [faces ? `${faces} face${faces === 1 ? '' : 's'}` : '', plates ? `${plates} license plate${plates === 1 ? '' : 's'}` : ''].filter(Boolean);
  return `Blurred ${parts.join(' and ')}. Automatic blurring can miss some, so look it over before you share.`;
}

/**
 * "Share with neighbors": a clip or photo for a neighborhood group, with faces and license
 * plates blurred on this iPhone first (Vision). The original recording is never changed.
 */
export default function ShareWithNeighbors() {
  const p = usePalette();
  const params = useLocalSearchParams<{ systemId: string; cameraId: string; start: string; end: string; thumb?: string }>();
  const adapter = useAdapter(params.systemId);
  const start = Number(params.start);
  const end = Number(params.end);
  const canVideo = !!adapter?.clip;
  const [kind, setKind] = useState<Kind>(canVideo ? 'video' : 'photo');
  const [blur, setBlur] = useState(!!Redact);
  const [phase, setPhase] = useState<Phase>({ step: 'idle' });
  const job = useRef<{ id: string; abort: AbortController } | null>(null);

  const cancel = () => {
    const j = job.current;
    if (!j) return;
    j.abort.abort();
    Redact?.cancel(j.id);
    job.current = null;
  };

  useEffect(() => {
    const sub = Redact?.addListener('onRedactProgress', (e) => {
      if (e.jobId === job.current?.id) setPhase({ step: 'working', label: 'Blurring faces and plates…', fraction: 0.3 + 0.7 * e.progress });
    });
    // Leaving the screen stops any work in progress.
    return () => {
      sub?.remove();
      const j = job.current;
      if (j) {
        j.abort.abort();
        Redact?.cancel(j.id);
      }
    };
  }, []);

  const prepare = async () => {
    if (!adapter) return;
    const id = `${Date.now()}`;
    const abort = new AbortController();
    job.current = { id, abort };
    const name = fileStamp('Sightline', start, -new Date(start * 1000).getTimezoneOffset());
    try {
      let source: File | null = null;
      let photo: File | null = null;
      // A photo comes from the clip when the iPhone can pull a frame out of it (sharper and at
      // the right moment); otherwise from the event's snapshot or the camera's current one.
      if (canVideo && (kind === 'video' || Redact)) {
        setPhase({ step: 'working', label: 'Getting the video…', fraction: 0 });
        const src = adapter.clip!(params.cameraId, start, end);
        source = await File.downloadFileAsync(src.uri, fresh(`${id}-original.mp4`), {
          headers: src.headers,
          signal: abort.signal,
          onProgress: ({ bytesWritten, totalBytes }) =>
            totalBytes > 0 && setPhase({ step: 'working', label: 'Getting the video…', fraction: 0.3 * (bytesWritten / totalBytes) }),
        });
      }
      if (kind === 'photo') {
        setPhase({ step: 'working', label: 'Getting the photo…', fraction: 0.2 });
        photo = fresh(`${id}-original.jpg`);
        if (source && Redact) {
          await Redact.frameAt(source.uri, Math.min(5, Math.max(0, (end - start) / 2)), photo.uri);
        } else {
          const snap = params.thumb ? { uri: params.thumb, headers: undefined } : adapter.snapshot(params.cameraId, { height: 1080 });
          photo = await File.downloadFileAsync(snap.uri, photo, { headers: snap.headers, signal: abort.signal });
        }
      }
      if (abort.signal.aborted) return;

      const input = kind === 'photo' ? photo! : source!;
      if (!blur || !Redact) {
        setPhase({ step: 'ready', uri: input.uri, kind, note: 'Not blurred. Faces and license plates will be visible.' });
        return;
      }
      setPhase({ step: 'working', label: 'Blurring faces and plates…', fraction: 0.3 });
      if (kind === 'photo') {
        const out = fresh(`${name} blurred.jpg`);
        const n = await Redact.redactImage(input.uri, out.uri, true, true);
        setPhase({ step: 'ready', uri: out.uri, kind, note: foundText(n.faces, n.plates) });
      } else {
        const out = fresh(`${name} blurred.mp4`);
        const n = await Redact.redactVideo(id, input.uri, out.uri, true, true);
        setPhase({ step: 'ready', uri: out.uri, kind, note: foundText(n.faces, n.plates) });
      }
    } catch (e) {
      if (abort.signal.aborted || (e instanceof Error && /cancel/i.test(e.message))) {
        setPhase({ step: 'idle' });
        return;
      }
      setPhase({ step: 'idle' });
      Alert.alert('Couldn’t prepare it', e instanceof Error ? e.message : String(e));
    } finally {
      if (job.current?.id === id) job.current = null;
    }
  };

  const share = async (uri: string, k: Kind) => {
    await Sharing.shareAsync(uri, k === 'video' ? { mimeType: 'video/mp4', UTI: 'public.mpeg-4' } : { mimeType: 'image/jpeg', UTI: 'public.jpeg' });
  };

  if (phase.step === 'working') {
    const stop = () => {
      cancel();
      setPhase({ step: 'idle' });
    };
    return <Working label={phase.label} fraction={phase.fraction} onCancel={stop} />;
  }

  if (phase.step === 'ready') {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Check before sharing' }} />
        {phase.kind === 'photo' ? (
          <Image source={{ uri: phase.uri }} style={styles.preview} contentFit="contain" />
        ) : (
          <VideoPreview uri={phase.uri} />
        )}
        <T muted>{phase.note}</T>
        <Button title="Share" onPress={() => void share(phase.uri, phase.kind)} />
        <Button title="Start over" kind="ghost" onPress={() => setPhase({ step: 'idle' })} />
      </Screen>
    );
  }

  return (
    <Screen>
      <Stack.Screen options={{ title: 'Share with neighbors' }} />
      <T muted>For a neighborhood group or a neighbor. Blurring happens on this iPhone; nothing is uploaded until you share.</T>
      <Section title="What to share">
        <View style={styles.chips}>
          <Chip label="Video clip" selected={kind === 'video'} onPress={() => setKind('video')} disabled={!canVideo} />
          <Chip label="Photo" selected={kind === 'photo'} onPress={() => setKind('photo')} />
        </View>
      </Section>
      {!canVideo && (
        <T v="caption" muted style={{ marginTop: -space.sm }}>
          This recorder can’t make video clips for sharing, so a photo is shared instead.
        </T>
      )}
      <Section
        footer={
          Redact
            ? 'Faces and license plates are found automatically and blurred in a copy. It can miss some, so you’ll see the result first.'
            : 'Blurring needs the newest version of Sightline. Update the app to use it.'
        }>
        <ToggleRow label="Blur faces and license plates" value={blur && !!Redact} onChange={(v) => setBlur(v && !!Redact)} last />
      </Section>
      <Button title={blur && Redact ? 'Blur and preview' : 'Preview'} onPress={() => void prepare()} disabled={!adapter} />
      <Button title="Cancel" kind="ghost" onPress={() => router.back()} />
      {!blur && <T v="caption" color={p.warning}>Faces and license plates will be visible to everyone you share with.</T>}
    </Screen>
  );
}

function VideoPreview({ uri }: { uri: string }) {
  const player = useVideoPlayer(uri, (pl) => {
    pl.loop = true;
    pl.muted = true;
    pl.play();
  });
  return <VideoView player={player} style={styles.preview} contentFit="contain" nativeControls />;
}

function Working({ label, fraction, onCancel }: { label: string; fraction: number; onCancel: () => void }) {
  const p = usePalette();
  useKeepAwake();
  return (
    <Screen scroll={false} style={{ justifyContent: 'center' }}>
      <Stack.Screen options={{ title: 'Preparing' }} />
      <View style={{ gap: space.lg }}>
        <T v="heading" style={{ textAlign: 'center' }}>
          {label}
        </T>
        <View style={[styles.bar, { backgroundColor: p.surfaceRaised }]} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: Math.round(fraction * 100) }}>
          <View style={{ width: `${Math.max(2, fraction * 100)}%`, height: '100%', backgroundColor: p.accent }} />
        </View>
        <Button title="Cancel" kind="secondary" onPress={onCancel} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', gap: space.sm, padding: space.lg },
  preview: { width: '100%', aspectRatio: 16 / 9, backgroundColor: '#000', borderRadius: 12, overflow: 'hidden' },
  bar: { height: 12, borderRadius: 6, overflow: 'hidden' },
});

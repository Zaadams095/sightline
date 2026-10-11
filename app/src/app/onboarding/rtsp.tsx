import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, Card, Field, Screen, T, ToggleRow } from '@/components/ui/primitives';
import { useT } from '@/i18n/use-t';
import { useApp } from '@/state/store';
import { space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';
import { friendlyNetError } from '@/util/errors';
import { WgTunnel } from '@modules/wg-tunnel';

/** host:port of a stream link, or null when it isn't one. */
function streamTarget(link: string): string | null {
  const s = link.trim();
  if (!/^rtsps?:\/\//i.test(s)) return null;
  try {
    // URL doesn't know rtsp://, so parse it as http to read the host and port.
    const u = new URL(s.replace(/^rtsps?:/i, 'http:'));
    return `${u.hostname}:${u.port || (/^rtsps:/i.test(s) ? '322' : '554')}`;
  } catch {
    return null;
  }
}

export default function RtspSetup() {
  const p = usePalette();
  const t = useT();
  const r = t.onboarding.rtsp;
  const insets = useSafeAreaInsets();
  const upsert = useApp((s) => s.upsertSystem);
  const existing = useApp((s) => s.systems.find((x) => x.kind === 'rtsp'));
  const [name, setName] = useState('');
  const [rtsp, setRtsp] = useState('');
  const [snapshot, setSnapshot] = useState('');
  const [useTunnel, setUseTunnel] = useState(true);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const test = async () => {
    setResult(null);
    const target = streamTarget(rtsp);
    if (!target) {
      setResult({ ok: false, msg: r.notLink });
      return;
    }
    if (!WgTunnel) {
      setResult({ ok: false, msg: r.previewOnly });
      return;
    }
    setTesting(true);
    try {
      const err = await WgTunnel.probeError(target, false, 4000);
      const friendly = err ? friendlyNetError(err, r.theCamera) : '';
      setResult(
        err
          ? { ok: false, msg: friendly.charAt(0).toUpperCase() + friendly.slice(1) }
          : { ok: true, msg: r.answered },
      );
    } finally {
      setTesting(false);
    }
  };

  const add = () => {
    const id = existing?.id ?? `rtsp-${Date.now().toString(36)}`;
    const cam = { id: Date.now().toString(36), name: name.trim() || r.defaultCamera, rtspUrl: rtsp.trim(), snapshotUrl: snapshot.trim() || undefined };
    upsert({
      id,
      kind: 'rtsp',
      name: r.systemName,
      endpoint: existing?.endpoint ?? { lanUrl: '', useTunnel },
      manualCameras: [...(existing?.manualCameras ?? []), cam],
    });
    router.push('/onboarding/vpn');
  };

  return (
    <Screen style={{ paddingTop: insets.top + 56 }}>
      <View style={{ gap: space.xs }}>
        <T v="title">{r.title}</T>
        <T muted>{r.intro}</T>
      </View>
      <Field label={t.onboarding.connect.name} value={name} onChangeText={setName} placeholder={r.namePlaceholder} autoCapitalize="words" />
      <Field
        label={r.streamLink}
        value={rtsp}
        onChangeText={(v) => {
          setRtsp(v);
          setResult(null);
        }}
        placeholder="rtsp://user:pass@192.168.1.50:554/stream1"
        keyboardType="url"
        hint={r.streamHint}
      />
      <Button title={r.testLink} kind="secondary" onPress={test} loading={testing} disabled={!rtsp.trim()} />
      {result && <T color={result.ok ? p.success : p.danger}>{result.msg}</T>}
      <Field
        label={r.pictureLink}
        value={snapshot}
        onChangeText={setSnapshot}
        placeholder="http://192.168.1.50/snapshot.jpg"
        keyboardType="url"
        hint={r.pictureHint}
      />
      <Card>
        <ToggleRow
          label={t.onboarding.connect.reachAway}
          detail={r.reachAwayDetail}
          value={useTunnel}
          onChange={setUseTunnel}
          last
        />
      </Card>
      <Button title={r.addCamera} onPress={add} disabled={!rtsp.trim()} />
    </Screen>
  );
}

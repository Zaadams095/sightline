import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, Card, Field, Screen, T, ToggleRow } from '@/components/ui/primitives';
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
      setResult({ ok: false, msg: 'That doesn’t look like a stream link. It should start with rtsp://' });
      return;
    }
    if (!WgTunnel) {
      setResult({ ok: false, msg: 'Testing works in the full app, not the preview.' });
      return;
    }
    setTesting(true);
    try {
      const err = await WgTunnel.probeError(target, false, 4000);
      const friendly = err ? friendlyNetError(err, 'the camera') : '';
      setResult(
        err
          ? { ok: false, msg: friendly.charAt(0).toUpperCase() + friendly.slice(1) }
          : { ok: true, msg: 'The camera answered. If the picture doesn’t show, check the link’s username, password and path.' },
      );
    } finally {
      setTesting(false);
    }
  };

  const add = () => {
    const id = existing?.id ?? `rtsp-${Date.now().toString(36)}`;
    const cam = { id: Date.now().toString(36), name: name.trim() || 'Camera', rtspUrl: rtsp.trim(), snapshotUrl: snapshot.trim() || undefined };
    upsert({
      id,
      kind: 'rtsp',
      name: 'IP cameras',
      endpoint: existing?.endpoint ?? { lanUrl: '', useTunnel },
      manualCameras: [...(existing?.manualCameras ?? []), cam],
    });
    router.push('/onboarding/vpn');
  };

  return (
    <Screen style={{ paddingTop: insets.top + 56 }}>
      <View style={{ gap: space.xs }}>
        <T v="title">Add a camera by stream link</T>
        <T muted>
          Cameras added this way show live video only. To look back at recordings, add the recorder or camera software they
          record to instead.
        </T>
      </View>
      <Field label="Name" value={name} onChangeText={setName} placeholder="Driveway" autoCapitalize="words" />
      <Field
        label="Stream link"
        value={rtsp}
        onChangeText={(v) => {
          setRtsp(v);
          setResult(null);
        }}
        placeholder="rtsp://user:pass@192.168.1.50:554/stream1"
        keyboardType="url"
        hint="A video link that starts with rtsp:// (often called an RTSP link). Find it in the camera’s manual or its app, usually under Network or Streaming."
      />
      <Button title="Test link" kind="secondary" onPress={test} loading={testing} disabled={!rtsp.trim()} />
      {result && <T color={result.ok ? p.success : p.danger}>{result.msg}</T>}
      <Field
        label="Picture link (optional)"
        value={snapshot}
        onChangeText={setSnapshot}
        placeholder="http://192.168.1.50/snapshot.jpg"
        keyboardType="url"
        hint="A still-picture link from the camera’s manual. Makes the camera grid load faster."
      />
      <Card>
        <ToggleRow
          label="Reach it when I’m away"
          detail="Uses your own VPN, if you set one up (Settings → Away from home)."
          value={useTunnel}
          onChange={setUseTunnel}
          last
        />
      </Card>
      <Button title="Add camera" onPress={add} disabled={!rtsp.trim()} />
    </Screen>
  );
}

import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, Card, Field, Screen, T, ToggleRow } from '@/components/ui/primitives';
import { useApp } from '@/state/store';
import { space } from '@/theme/tokens';

export default function RtspSetup() {
  const insets = useSafeAreaInsets();
  const upsert = useApp((s) => s.upsertSystem);
  const existing = useApp((s) => s.systems.find((x) => x.kind === 'rtsp'));
  const [name, setName] = useState('');
  const [rtsp, setRtsp] = useState('');
  const [snapshot, setSnapshot] = useState('');
  const [useTunnel, setUseTunnel] = useState(true);

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
        <T v="title">Add an IP camera</T>
        <T muted>
          Cameras added by stream link have live view only. To look back at recordings, add the recorder (NVR) or camera software instead.
        </T>
      </View>
      <Field label="Name" value={name} onChangeText={setName} placeholder="Driveway" autoCapitalize="words" />
      <Field
        label="Stream URL"
        value={rtsp}
        onChangeText={setRtsp}
        placeholder="rtsp://user:pass@192.168.1.50:554/stream1"
        keyboardType="url"
      />
      <Field
        label="Snapshot URL (optional)"
        value={snapshot}
        onChangeText={setSnapshot}
        placeholder="http://192.168.1.50/snapshot.jpg"
        keyboardType="url"
        hint="Used for fast thumbnails on the camera grid."
      />
      <Card>
        <ToggleRow label="Use VPN when away" value={useTunnel} onChange={setUseTunnel} last />
      </Card>
      <Button title="Add camera" onPress={add} disabled={!rtsp.trim()} />
    </Screen>
  );
}

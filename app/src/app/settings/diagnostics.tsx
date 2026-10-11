import * as Clipboard from 'expo-clipboard';
import Constants from 'expo-constants';
import { useLocalSearchParams } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Button, Card, Chip, Disclosure, Field, Screen, T } from '@/components/ui/primitives';
import { useT } from '@/i18n/use-t';
import { connectSystem, hasTunnelConfig, useLinks } from '@/net/connection';
import { describeStartup, useLiveStats } from '@/state/live-stats';
import { useApp } from '@/state/store';
import { describe, usesGateway } from '@/systems/catalog';
import { getAdapter } from '@/systems/registry';
import type { SystemConfig, SystemKind } from '@/systems/types';
import { space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';
import { friendlyNetError } from '@/util/errors';
import { fetchWithTimeout } from '@/util/fetch';
import { normalizeUrl } from '@/util/url';
import { parseStatus, WgTunnel } from '@modules/wg-tunnel';

type State = 'ok' | 'fail' | 'skip';

interface Step {
  name: string;
  state: State;
  /** Plain-language result. */
  detail: string;
  /** Raw details for support (shown under "Technical details" and in the copied report). */
  tech: string[];
}

const OTHER = '__other__';
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The HTTP path a brand answers on without signing in (from the catalog's fingerprints). */
function probePath(kind: SystemKind | undefined, url: string): string {
  if (!kind) return '/';
  const prints = describe(kind)?.fingerprints ?? [];
  let port = '';
  try {
    const u = new URL(url);
    port = u.port || (u.protocol === 'https:' ? '443' : '80');
  } catch {}
  return (prints.find((f) => String(f.port) === port) ?? prints[0])?.path ?? '/';
}

/** host:port to test for a system (stream-link cameras use their first stream address). */
function targetOf(system: SystemConfig | undefined, address: string): { url: string; hostport: string } | null {
  try {
    const raw = system?.kind === 'rtsp' ? (system.manualCameras?.[0]?.rtspUrl ?? '') : address;
    if (!raw.trim()) return null;
    const url = system?.kind === 'rtsp' ? raw.trim() : normalizeUrl(raw);
    const u = new URL(url);
    const port = u.port || (u.protocol === 'https:' ? '443' : u.protocol === 'rtsp:' ? '554' : '80');
    return { url: url.replace(/\/+$/, ''), hostport: `${u.hostname}:${port}` };
  } catch {
    return null;
  }
}

/**
 * Step-by-step connection check for any brand: the phone's network, reaching the recorder,
 * signing in, and video. Plain answers first; the exact errors are one tap away for support.
 */
export default function Diagnostics() {
  const p = usePalette();
  const t = useT();
  const dg = t.settings.diagnostics;
  const params = useLocalSearchParams<{ id?: string; kind?: SystemKind; address?: string }>();
  const systems = useApp((s) => s.systems);
  const links = useLinks((s) => s.links);
  const lastLive = useLiveStats((s) => s.last);

  const [pick, setPick] = useState<string>(() =>
    params.address ? OTHER : (params.id ?? systems[0]?.id ?? OTHER),
  );
  const [address, setAddress] = useState(params.address ?? '');
  const [steps, setSteps] = useState<Step[]>([]);
  const [running, setRunning] = useState(false);

  const system = pick === OTHER ? undefined : systems.find((s) => s.id === pick);
  const kind: SystemKind | undefined = system?.kind ?? params.kind;
  const name = system?.name ?? (kind ? describe(kind)?.label : undefined) ?? dg.theRecorder;
  const typedAddress = system ? system.endpoint.lanUrl : address;
  const target = targetOf(system, typedAddress);

  const run = async () => {
    if (!target) return;
    setRunning(true);
    setSteps([]);
    const out: Step[] = [];
    const push = (s: Step) => {
      out.push(s);
      setSteps([...out]);
    };

    // 1. Your phone's network: can the app use the network, and is away-from-home set up?
    {
      const tech = [`Address: ${target.url} (${target.hostport})`];
      let detail = dg.ready;
      let state: State = 'ok';
      if (!WgTunnel) {
        state = 'skip';
        detail = dg.previewOnly;
        tech.push('Native networking module not available');
      } else {
        const vpn = await hasTunnelConfig();
        const st = parseStatus(WgTunnel.tunnelStatus());
        tech.push(`Own VPN: ${vpn ? (st.running ? `running, last handshake ${st.lastHandshake || 'never'}` : 'idle') : 'not set up'}`);
        if (vpn && st.running) detail = dg.vpnOn;
      }
      push({ name: dg.stepNetwork, state, detail, tech });
    }

    // 2. Reaching the recorder: a plain connection, then an HTTP answer from its usual page.
    let reached = false;
    {
      const tech: string[] = [];
      let raw = '';
      if (WgTunnel) {
        const tcp = await WgTunnel.probeError(target.hostport, false, 3000);
        tech.push(`Direct connection: ${tcp || 'connected'}`);
        reached = !tcp;
        raw = tcp;
        const st = parseStatus(WgTunnel.tunnelStatus());
        if (!reached && st.running) {
          const via = await WgTunnel.probeError(target.hostport, true, 5000);
          tech.push(`Through your VPN: ${via || 'connected'}`);
          reached = !via;
          if (via) raw = via;
        }
      }
      if (system?.kind !== 'rtsp' && (kind ? usesGateway(kind) : true)) {
        const path = probePath(kind, target.url);
        if (WgTunnel) {
          const http = await WgTunnel.httpCheck(`${target.url}${path}`, false, 5000);
          tech.push(`App GET ${path}: ${http}`);
          if (http.startsWith('HTTP')) reached = true;
          else raw ||= http;
        }
        try {
          // iOS's own networking (what Safari uses). A certificate error still proves it's there.
          const res = await fetchWithTimeout(`${target.url}${path}`, {}, 5000);
          tech.push(`iOS GET ${path}: HTTP ${res.status}`);
          reached = true;
        } catch (e) {
          tech.push(`iOS GET ${path}: ${msg(e)}`);
          raw ||= msg(e);
        }
      }
      push({
        name: dg.stepReach,
        state: reached ? 'ok' : 'fail',
        detail: reached ? dg.found(name) : friendlyNetError(raw || 'no response', name),
        tech,
      });
    }

    // 3. Signing in, and 4. Video: only for a saved system (it holds the sign-in).
    if (!system) {
      push({ name: dg.stepSignIn, state: 'skip', detail: dg.addFirst, tech: [] });
      push({ name: dg.stepVideo, state: 'skip', detail: dg.checkedAfterSignIn, tech: [] });
    } else {
      let signedIn = false;
      let firstCamera: string | undefined;
      const adapterTech: string[] = [];
      let adapter: ReturnType<typeof getAdapter> = null;
      try {
        const link = links[system.id]?.baseUrl ? links[system.id] : await connectSystem(system);
        adapterTech.push(`Link: ${link.mode}${link.error ? ` · ${link.error}` : ''}`);
        if (link.mode === 'offline') throw new Error(link.error ?? 'offline');
        adapter = getAdapter(system, link);
        if (!adapter) throw new Error('No adapter for this system');
        await adapter.connect();
        const cams = await adapter.listCameras();
        firstCamera = cams[0]?.id;
        adapterTech.push(`Cameras: ${cams.length}`);
        signedIn = true;
        push({
          name: dg.stepSignIn,
          state: 'ok',
          detail: dg.signedIn(cams.length),
          tech: adapterTech,
        });
      } catch (e) {
        adapterTech.push(`Error: ${msg(e)}`);
        const m = msg(e).toLowerCase();
        const auth = /401|403|unauthori|forbidden|password|login|credential|sign in/.test(m);
        push({
          name: dg.stepSignIn,
          state: 'fail',
          detail: auth
            ? dg.refused(name, system.name)
            : reached
              ? dg.reachedNoSignIn(name, friendlyNetError(msg(e), name))
              : dg.skippedUnreachable,
          tech: adapterTech,
        });
      }

      if (!signedIn || !adapter) {
        push({ name: dg.stepVideo, state: 'skip', detail: dg.checkedAfterSignIn, tech: [] });
      } else if (!firstCamera) {
        push({ name: dg.stepVideo, state: 'fail', detail: dg.noCameras(name), tech: [] });
      } else {
        try {
          const src = await adapter.liveStream(firstCamera, { quality: 'sub' });
          push({ name: dg.stepVideo, state: 'ok', detail: dg.videoOk, tech: [`Live source: ${src.kind}`] });
        } catch (e) {
          push({ name: dg.stepVideo, state: 'fail', detail: dg.videoFail, tech: [msg(e)] });
        }
      }
    }
    setRunning(false);
  };

  const build = `Sightline v${Constants.expoConfig?.version} (${Constants.expoConfig?.ios?.buildNumber ?? ''})`;
  const report = [
    build,
    `Checking: ${name}${kind ? ` (${describe(kind)?.label})` : ''}`,
    ...steps.flatMap((s) => [`${s.state === 'ok' ? 'OK  ' : s.state === 'fail' ? 'FAIL' : 'SKIP'} ${s.name}: ${s.detail}`, ...s.tech.map((t) => `     ${t}`)]),
    ...(lastLive ? ['', 'Last live view startup:', describeStartup(lastLive)] : []),
  ].join('\n');

  return (
    <Screen>
      <T muted>{dg.intro}</T>

      <View style={{ gap: space.sm }}>
        <T v="label" muted>
          {dg.whatToCheck}
        </T>
        <View style={styles.chips}>
          {systems.map((s) => (
            <Chip key={s.id} label={s.name} selected={pick === s.id} onPress={() => setPick(s.id)} />
          ))}
          <Chip label={dg.anotherAddress} selected={pick === OTHER} onPress={() => setPick(OTHER)} />
        </View>
      </View>
      {pick === OTHER && (
        <Field
          label={dg.address}
          value={address}
          onChangeText={setAddress}
          placeholder="192.168.1.20"
          keyboardType="url"
          hint={dg.addressHint}
        />
      )}

      <Button title={running ? dg.checking : dg.start} onPress={run} loading={running} disabled={!target} />

      {steps.length > 0 && (
        <Card style={{ padding: space.md, gap: space.md }}>
          {steps.map((s, i) => (
            <View key={i} style={styles.step}>
              <SymbolView
                name={s.state === 'ok' ? 'checkmark.circle.fill' : s.state === 'fail' ? 'xmark.circle.fill' : 'minus.circle'}
                tintColor={s.state === 'ok' ? p.success : s.state === 'fail' ? p.danger : p.textMuted}
                size={20}
                accessibilityLabel={s.state === 'ok' ? dg.passed : s.state === 'fail' ? dg.problem : dg.skipped}
              />
              <View style={{ flex: 1, gap: 2 }}>
                <T v="label">{s.name}</T>
                <T muted>{s.detail}</T>
              </View>
            </View>
          ))}
        </Card>
      )}

      {(steps.length > 0 || lastLive) && !running && (
        <Disclosure title={dg.techDetails}>
          <Card style={{ padding: space.md }}>
            <Text selectable style={[styles.detail, { color: p.textMuted }]}>
              {report}
            </Text>
          </Card>
          <Button title={dg.copy} kind="secondary" onPress={() => Clipboard.setStringAsync(report)} />
        </Disclosure>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  step: { flexDirection: 'row', gap: space.sm, alignItems: 'flex-start' },
  detail: { fontFamily: 'Menlo', fontSize: 12 },
});

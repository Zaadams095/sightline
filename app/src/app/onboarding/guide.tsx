import * as Clipboard from 'expo-clipboard';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ChoiceRow, FindOnNetwork, GuideProgress, StepList } from '@/components/guide/parts';
import { Button, Card, Disclosure, Field, Screen, T, ToggleRow } from '@/components/ui/primitives';
import { SymbolView } from '@/components/ui/symbol';
import { useT } from '@/i18n/use-t';
import { useApp } from '@/state/store';
import {
  buildStreamUrl,
  guideById,
  isStreamLink,
  redactStreamUrl,
  stepsFor,
  type Alternative,
  type BrandGuide,
  type StreamTarget,
  type SystemTarget,
  type UnsupportedTarget,
} from '@/systems/guides';
import { space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';
import { friendlyNetError } from '@/util/errors';
import { WgTunnel } from '@modules/wg-tunnel';

const newId = () => Date.now().toString(36);

/**
 * Guided setup for one brand, generated from systems/guides.ts: which camera you have →
 * a few steps in the brand's app → Sightline connects (building the stream link for you, or
 * handing over to the right recorder setup with the brand prefilled).
 */
export default function Guide() {
  const params = useLocalSearchParams<{ brand: string; option?: string }>();
  const guide = guideById(params.brand);
  const insets = useSafeAreaInsets();
  const t = useT();
  const [optionId, setOptionId] = useState<string | undefined>(() =>
    params.option ?? (guide && guide.options.length === 1 ? guide.options[0]!.id : undefined),
  );
  const [phase, setPhase] = useState<'steps' | 'connect'>('steps');

  if (!guide) {
    return (
      <Screen style={{ paddingTop: insets.top + 56 }}>
        <T v="title">{t.guides.screen.missingTitle}</T>
        <T muted>{t.guides.screen.missingBody}</T>
        <Button title={t.guides.screen.pickBrand} onPress={() => router.replace('/onboarding/brands')} />
        <Button title={t.guides.screen.findOnWifi} kind="secondary" onPress={() => router.push('/onboarding/discover')} />
      </Screen>
    );
  }

  const option = guide.options.find((o) => o.id === optionId);
  const choose = guide.options.length > 1;
  const { stageWhich, stageReady, stageConnect } = t.guides.screen;
  const stages = [choose ? stageWhich : null, stageReady, stageConnect].filter((s): s is string => !!s);
  const progress = (label: string) => <GuideProgress step={stages.indexOf(label) + 1} total={stages.length} label={label} />;

  const pickOption = (id: string) => {
    setOptionId(id);
    setPhase('steps');
  };

  return (
    <Screen style={{ paddingTop: insets.top + 56 }}>
      {!option ? (
        <>
          {progress(stageWhich)}
          <T v="title">{t.guides.screen.whichOne(guide.name)}</T>
          <View style={{ gap: space.sm }}>
            {guide.options.map((o) => (
              <ChoiceRow key={o.id} title={o.title} detail={o.detail} onPress={() => pickOption(o.id)} />
            ))}
          </View>
          <T v="caption" muted>
            {t.guides.screen.notSure}
          </T>
        </>
      ) : option.target.type === 'unsupported' ? (
        <Unsupported guide={guide} target={option.target} onSwitch={pickOption} />
      ) : phase === 'steps' ? (
        <>
          {progress(stageReady)}
          <T v="title">{guide.name}</T>
          {choose && <T muted>{option.title}</T>}
          <StepList steps={stepsFor(option)} />
          <Button title={t.common.next} onPress={() => setPhase('connect')} />
          {choose && <Button title={t.guides.screen.differentOne} kind="ghost" onPress={() => setOptionId(undefined)} />}
        </>
      ) : (
        <>
          {progress(stageConnect)}
          {option.target.type === 'stream' ? (
            <StreamConnect guide={guide} target={option.target} />
          ) : (
            <SystemConnect guide={guide} target={option.target} />
          )}
          <Button title={t.guides.screen.stepsAgain} kind="ghost" onPress={() => setPhase('steps')} />
        </>
      )}
    </Screen>
  );
}

function Unsupported({ guide, target, onSwitch }: { guide: BrandGuide; target: UnsupportedTarget; onSwitch: (option: string) => void }) {
  const p = usePalette();
  const t = useT();
  const go = (a: Alternative) => {
    switch (a.action) {
      case 'brands':
        return router.dismissTo('/onboarding/brands');
      case 'discover':
        return router.push('/onboarding/discover');
      case 'stream':
        return router.push('/onboarding/rtsp');
      case 'guide':
        if (a.guide === guide.id && a.option) return onSwitch(a.option);
        return router.push({ pathname: '/onboarding/guide', params: { brand: a.guide, ...(a.option ? { option: a.option } : {}) } });
    }
  };
  return (
    <>
      <SymbolView name="heart.text.square" tintColor={p.accent} size={44} />
      <T v="title">{t.guides.unsupported.title}</T>
      <T>{target.why}</T>
      <T muted>{t.guides.unsupported.nothingWrong}</T>
      <View style={{ gap: space.sm }}>
        <T v="heading">{t.guides.unsupported.whatYouCanDo}</T>
        {target.alternatives.map((a, i) => (
          <Button key={a.label} title={a.label} kind={i === 0 ? 'primary' : 'secondary'} onPress={() => go(a)} />
        ))}
      </View>
    </>
  );
}

/** Recorder brands: find it on the network, then the regular setup screen with the brand prefilled. */
function SystemConnect({ guide, target }: { guide: BrandGuide; target: SystemTarget }) {
  const t = useT();
  const open = (address?: string) =>
    router.push({
      pathname: '/onboarding/connect',
      params: { kind: target.system, name: target.name, ...(target.username ? { username: target.username } : {}), ...(address ? { address } : {}) },
    });
  return (
    <>
      <T v="title">{t.guides.system.where(guide.name)}</T>
      <T muted>{t.guides.system.body}</T>
      <FindOnNetwork target={target} autoStart onPick={(f) => open(f.address)} />
      <Button title={t.guides.system.typeAddress} kind="secondary" onPress={() => open()} />
    </>
  );
}

/** Cameras added by stream: address + the account just made; Sightline builds the link. */
function StreamConnect({ guide, target }: { guide: BrandGuide; target: StreamTarget }) {
  const p = usePalette();
  const t = useT();
  const upsert = useApp((s) => s.upsertSystem);
  const existing = useApp((s) => s.systems.find((x) => x.kind === 'rtsp'));
  const [address, setAddress] = useState('');
  const [username, setUsername] = useState(target.username ?? '');
  const [password, setPassword] = useState('');
  const [name, setName] = useState(target.cameraName);
  const [useTunnel, setUseTunnel] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [failed, setFailed] = useState(false);

  const pasted = isStreamLink(address);
  const linkHasAccount = pasted && /^rtsps?:\/\/[^/?#]*@/i.test(address.trim());
  const needsAccount = !linkHasAccount;
  let url = '';
  let addressError: string | null = null;
  try {
    url = address.trim() ? buildStreamUrl(target, { address, username, password }) : '';
  } catch (e) {
    addressError = e instanceof Error ? e.message : String(e);
  }
  const ready = !!url && (!needsAccount || (!!username.trim() && !!password));

  const paste = async () => {
    const text = (await Clipboard.getStringAsync()).trim();
    if (isStreamLink(text)) {
      setAddress(text);
      setResult(null);
    } else {
      setResult({ ok: false, msg: t.guides.connect.noLink(guide.app ?? guide.name) });
    }
  };

  const save = () => {
    const id = existing?.id ?? `rtsp-${newId()}`;
    const cam = { id: newId(), name: name.trim() || target.cameraName, rtspUrl: url };
    upsert({
      id,
      kind: 'rtsp',
      name: t.guides.connect.ipCameras,
      endpoint: existing?.endpoint ?? { lanUrl: '', useTunnel },
      manualCameras: [...(existing?.manualCameras ?? []), cam],
    });
    router.push('/onboarding/vpn');
  };

  const connect = async () => {
    setResult(null);
    setFailed(false);
    // In the preview there's no network module to test with; save it as entered.
    if (!WgTunnel) return save();
    setBusy(true);
    try {
      const u = new URL(url.replace(/^rtsps?:/i, 'http:'));
      const hostport = `${u.hostname}:${u.port || (/^rtsps:/i.test(url) ? '322' : '554')}`;
      const err = await WgTunnel.probeError(hostport, false, 4000);
      if (!err) return save();
      const friendly = friendlyNetError(err, t.guides.connect.theCamera);
      setResult({ ok: false, msg: friendly.charAt(0).toUpperCase() + friendly.slice(1) });
      setFailed(true);
    } catch {
      setResult({ ok: false, msg: t.guides.connect.badAddress });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <View style={{ gap: space.xs }}>
        <T v="title">{t.guides.connect.title(target.cameraName)}</T>
        <T muted>{t.guides.connect.body}</T>
      </View>

      {target.pasteLink && (
        <Card>
          <View style={{ gap: space.sm }}>
            <T v="label">{t.guides.connect.copiedFrom(guide.app ?? guide.name)}</T>
            <Button title={t.guides.connect.paste} kind="secondary" onPress={paste} />
            {pasted && (
              <T v="caption" color={p.success}>
                {linkHasAccount ? t.guides.connect.pastedWithAccount : t.guides.connect.pastedNoAccount}
              </T>
            )}
          </View>
        </Card>
      )}

      {!pasted && (
        <>
          <FindOnNetwork target={target} onPick={(f) => setAddress(f.host)} />
          <Field
            label={t.guides.connect.address}
            value={address}
            onChangeText={(v) => {
              setAddress(v);
              setResult(null);
            }}
            placeholder="192.168.1.50"
            keyboardType="url"
            hint={t.guides.connect.addressHint(guide.app ?? guide.name)}
          />
        </>
      )}
      {addressError && address.trim().length > 6 && <T color={p.danger}>{addressError}</T>}

      {needsAccount && (
        <>
          <Field
            label={target.usernameLabel ?? t.guides.connect.username}
            value={username}
            onChangeText={setUsername}
            hint={target.usernameHint}
            textContentType="username"
          />
          <Field
            label={target.passwordLabel ?? t.guides.connect.password}
            value={password}
            onChangeText={setPassword}
            hint={target.passwordHint}
            secureTextEntry
            textContentType="password"
          />
        </>
      )}

      <Field
        label={t.guides.connect.name}
        value={name}
        onChangeText={setName}
        placeholder={t.guides.connect.namePlaceholder}
        autoCapitalize="words"
      />

      <Card>
        <ToggleRow
          label={t.guides.connect.away}
          detail={t.guides.connect.awayDetail}
          value={useTunnel}
          onChange={setUseTunnel}
          last
        />
      </Card>

      {!!url && (
        <Disclosure title={t.guides.connect.showLink}>
          <T v="caption" muted style={{ fontFamily: 'Menlo' }}>
            {redactStreamUrl(url)}
          </T>
        </Disclosure>
      )}

      {result && <T color={result.ok ? p.success : p.danger}>{result.msg}</T>}
      {failed && <Button title={t.guides.connect.addAnyway} kind="secondary" onPress={save} />}
      <Button title={t.guides.connect.connect} onPress={connect} loading={busy} disabled={!ready} />
    </>
  );
}

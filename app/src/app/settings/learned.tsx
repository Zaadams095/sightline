import { Stack } from 'expo-router';
import { useMemo } from 'react';
import { Alert, View } from 'react-native';

import { learnRules, ruleExplanation, ruleTitle, type LearnedRule } from '@/alerts/learning';
import { Button, Card, Screen, Section, T } from '@/components/ui/primitives';
import { useT } from '@/i18n/use-t';
import { useSmart } from '@/state/smart';
import { useAllCameras } from '@/systems/registry';
import { useLargeText } from '@/theme/text-scale';
import { space } from '@/theme/tokens';
import { nowSec } from '@/util/format';

/** Settings → Alerts → What Sightline learned: every learned item, each removable. */
export default function LearnedScreen() {
  const t = useT();
  const k = t.alertSettings.learned;
  const large = useLargeText();
  const learning = useSmart((s) => s.learning);
  const forget = useSmart((s) => s.forget);
  const confirm = useSmart((s) => s.confirm);
  const { entries } = useAllCameras({ includeHidden: true });
  const names = useMemo(() => new Map(entries.map((e) => [e.camera.key, e.camera.name])), [entries]);
  const rules = useMemo(() => learnRules(learning, nowSec()), [learning]);
  const name = (r: LearnedRule) => names.get(r.camera) ?? r.camera.split(':').slice(1).join(':');

  const waiting = rules.filter((r) => r.needsConfirm && !r.confirmed);
  const quiet = rules.filter((r) => r.kind === 'quiet' && !(r.needsConfirm && !r.confirmed));
  const always = rules.filter((r) => r.kind === 'always');

  const remove = (r: LearnedRule) =>
    Alert.alert(k.forgetTitle, k.forgetBody, [
      { text: t.common.cancel, style: 'cancel' },
      { text: k.forget, style: 'destructive', onPress: () => forget(r) },
    ]);

  return (
    <Screen>
      <Stack.Screen options={{ title: k.title }} />
      {rules.length === 0 && (
        <Card>
          <View style={{ gap: space.sm }}>
            <T v="heading">{k.emptyTitle}</T>
            <T muted>{k.emptyBody}</T>
          </View>
        </Card>
      )}

      {waiting.length > 0 && (
        <Section title={k.waiting} footer={k.waitingFooter}>
          {waiting.map((r) => (
            <View key={r.key} style={{ padding: space.lg, gap: space.sm }}>
              <T v="label">{ruleTitle(r, name(r))}</T>
              <T muted>{ruleExplanation(r, name(r))}</T>
              <View style={{ flexDirection: large ? 'column' : 'row', gap: space.sm }}>
                <Button title={k.stop} kind="secondary" onPress={() => confirm(r.key)} style={large ? undefined : { flex: 1 }} />
                <Button title={k.keep} kind="ghost" onPress={() => forget(r)} style={large ? undefined : { flex: 1 }} />
              </View>
            </View>
          ))}
        </Section>
      )}

      {quiet.length > 0 && (
        <Section title={k.quiet} footer={k.quietFooter}>
          {quiet.map((r) => (
            <RuleRow key={r.key} title={ruleTitle(r, name(r))} detail={ruleExplanation(r, name(r))} onRemove={() => remove(r)} />
          ))}
        </Section>
      )}

      {always.length > 0 && (
        <Section title={k.always}>
          {always.map((r) => (
            <RuleRow key={r.key} title={ruleTitle(r, name(r))} detail={ruleExplanation(r, name(r))} onRemove={() => remove(r)} />
          ))}
        </Section>
      )}
    </Screen>
  );
}

function RuleRow({ title, detail, onRemove }: { title: string; detail: string; onRemove: () => void }) {
  const t = useT();
  return (
    <View style={{ padding: space.lg, gap: space.xs }}>
      <T v="label">{title}</T>
      <T v="caption" muted>
        {detail}
      </T>
      <Button title={t.alertSettings.learned.forgetThis} kind="ghost" onPress={onRemove} style={{ minHeight: 40, alignSelf: 'flex-start', paddingHorizontal: space.md }} />
    </View>
  );
}

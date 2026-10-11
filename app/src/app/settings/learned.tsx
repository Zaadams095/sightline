import { useMemo } from 'react';
import { Alert, View } from 'react-native';

import { learnRules, ruleExplanation, ruleTitle, type LearnedRule } from '@/alerts/learning';
import { Button, Card, Screen, Section, T } from '@/components/ui/primitives';
import { useSmart } from '@/state/smart';
import { useAllCameras } from '@/systems/registry';
import { space } from '@/theme/tokens';
import { nowSec } from '@/util/format';

/** Settings → Alerts → What Sightline learned: every learned item, each removable. */
export default function LearnedScreen() {
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
    Alert.alert('Forget this?', 'Sightline will alert for these again, and forget the feedback behind it.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Forget', style: 'destructive', onPress: () => forget(r) },
    ]);

  return (
    <Screen>
      {rules.length === 0 && (
        <Card>
          <View style={{ gap: space.sm }}>
            <T v="heading">Nothing learned yet</T>
            <T muted>
              When an alert isn’t worth your attention, long-press it and choose “Not important”, or tap the thumbs-down in Recordings. After a few of the same kind on the same camera, Sightline stops alerting for them, and lists it here so you can undo it any time.
            </T>
          </View>
        </Card>
      )}

      {waiting.length > 0 && (
        <Section title="Waiting for you" footer="Sightline never stops alerting for people on its own.">
          {waiting.map((r) => (
            <View key={r.key} style={{ padding: space.lg, gap: space.sm }}>
              <T v="label">{ruleTitle(r, name(r))}</T>
              <T muted>{ruleExplanation(r, name(r))}</T>
              <View style={{ flexDirection: 'row', gap: space.sm }}>
                <Button title="Stop alerting" kind="secondary" onPress={() => confirm(r.key)} style={{ flex: 1 }} />
                <Button title="Keep alerting" kind="ghost" onPress={() => forget(r)} style={{ flex: 1 }} />
              </View>
            </View>
          ))}
        </Section>
      )}

      {quiet.length > 0 && (
        <Section title="No longer alerting for" footer="Anything that looks different (another time of day, another area, someone recognized, or staying longer) still alerts.">
          {quiet.map((r) => (
            <RuleRow key={r.key} title={ruleTitle(r, name(r))} detail={ruleExplanation(r, name(r))} onRemove={() => remove(r)} />
          ))}
        </Section>
      )}

      {always.length > 0 && (
        <Section title="Always tell me about">
          {always.map((r) => (
            <RuleRow key={r.key} title={ruleTitle(r, name(r))} detail={ruleExplanation(r, name(r))} onRemove={() => remove(r)} />
          ))}
        </Section>
      )}
    </Screen>
  );
}

function RuleRow({ title, detail, onRemove }: { title: string; detail: string; onRemove: () => void }) {
  return (
    <View style={{ padding: space.lg, gap: space.xs }}>
      <T v="label">{title}</T>
      <T v="caption" muted>
        {detail}
      </T>
      <Button title="Forget this" kind="ghost" onPress={onRemove} style={{ height: 40, alignSelf: 'flex-start', paddingHorizontal: space.md }} />
    </View>
  );
}

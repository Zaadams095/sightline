import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { askQuestion, modelAvailability, simpleModeReason, useEventIndex, type AskResult } from '@/ask/ask';
import { eventSubject, type EventRecord } from '@/ask/engine';
import { Card, Chip, IconButton, T, useScaledFont } from '@/components/ui/primitives';
import { SymbolView } from '@/components/ui/symbol';
import { useT } from '@/i18n/use-t';
import { useApp } from '@/state/store';
import { useLargeText } from '@/theme/text-scale';
import { space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';
import { formatRelative } from '@/util/format';
import { Ask } from '@modules/ask';

/**
 * Example questions. The question parser understands English only, so each chip shows the
 * translated label but asks this English question (the answer comes back in the app's language).
 */
const EXAMPLES = {
  package: 'Did a package come today?',
  backyard: 'Was anyone in the backyard last night?',
  kids: 'When did the kids get home?',
  cars: 'How many cars came by this week?',
  delivery: 'Show me the delivery driver',
  door: 'Who came to the door today?',
};
const EXAMPLE_KEYS = Object.keys(EXAMPLES) as (keyof typeof EXAMPLES)[];

/**
 * "Ask your cameras": plain questions about what the cameras saw, answered on the iPhone from
 * the events the user's own recorders already keep (any brand). Opened from the Recordings
 * tab, or by Siri ("Ask Sightline…") as sightline://ask?q=…
 */
export default function AskScreen() {
  const p = usePalette();
  const t = useT();
  const large = useLargeText();
  const body = useScaledFont('body');
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ q?: string; listen?: string }>();
  const radius = useApp((s) => s.appearance.radius);
  const index = useEventIndex();
  const [question, setQuestion] = useState(params.q ?? '');
  const [result, setResult] = useState<AskResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canListen] = useState(() => {
    try {
      return !!Ask?.speechAvailable();
    } catch {
      return false;
    }
  });
  // Opened from the mic button: start listening right away.
  const [autoListen] = useState(() => params.listen === '1' && canListen);
  const [listening, setListening] = useState(autoListen);
  const [availability] = useState(modelAvailability);
  const pending = useRef<string | null>(params.q?.trim() || null);
  const [waiting, setWaiting] = useState(!!params.q?.trim());
  const reason = simpleModeReason(availability);

  // `shown`: what the search field shows (a chip's translated label) when it differs from the question asked.
  const run = async (q: string, shown?: string) => {
    const text = q.trim();
    if (!text) return;
    setQuestion(shown ?? text);
    if (!index.data) {
      // Still loading the week’s events: answer as soon as they’re here.
      pending.current = text;
      setWaiting(true);
      return;
    }
    setWaiting(false);
    setBusy(true);
    setError(null);
    try {
      setResult(await askQuestion(text, index.data.index, index.data.ctx));
    } catch (e) {
      setResult(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const runLater = useEffectEvent((q: string) => {
    void run(q);
  });

  // A question that arrived before the events did (from Siri, a chip, or the mic).
  useEffect(() => {
    if (index.data && pending.current) {
      const q = pending.current;
      pending.current = null;
      runLater(q);
    }
  }, [index.data]);

  const onSpeech = useEffectEvent((text: string, final: boolean) => {
    if (text) setQuestion(text);
    if (final) {
      setListening(false);
      if (text.trim()) void run(text);
    }
  });

  const listen = () => {
    Ask?.startListening().catch((e: unknown) => {
      setListening(false);
      setError(e instanceof Error ? e.message : String(e));
    });
  };
  const listenLater = useEffectEvent(listen);

  useEffect(() => {
    const ask = Ask;
    if (!ask) return;
    const sub = ask.addListener('onSpeech', (e) => onSpeech(e.text, e.final));
    if (autoListen) listenLater();
    return () => {
      sub.remove();
      ask.stopListening();
    };
  }, [autoListen]);

  const toggleMic = () => {
    if (!Ask) return;
    if (listening) {
      Ask.stopListening();
      return;
    }
    setError(null);
    setResult(null);
    setQuestion('');
    setListening(true);
    listen();
  };

  const open = (e: EventRecord) =>
    router.push({
      pathname: '/playback',
      params: { systemId: e.systemId, cameraId: e.cameraId, start: String(Math.floor(e.start - 5)), reviewId: e.id },
    });

  const loadingIndex = index.isLoading && index.canReview;

  return (
    <View style={{ flex: 1, backgroundColor: p.bg }}>
      <View style={[styles.header, { paddingTop: insets.top + space.sm }]}>
        <T v="title" style={{ flex: 1 }}>
          {t.ask.screen.title}
        </T>
        <IconButton icon="xmark.circle.fill" label={t.common.close} color={p.textMuted} size={24} onPress={() => router.back()} />
      </View>

      <View style={{ paddingHorizontal: space.lg, gap: space.sm }}>
        <View style={[styles.bar, { backgroundColor: p.surface, borderColor: listening ? p.accent : p.border }]}>
          <SymbolView name="sparkles" tintColor={p.accent} size={17} />
          <TextInput
            value={question}
            onChangeText={setQuestion}
            placeholder={listening ? t.ask.screen.listening : t.ask.screen.examples.package}
            placeholderTextColor={p.textMuted}
            style={[body.style, styles.input, { color: p.text }]}
            maxFontSizeMultiplier={body.maxFontSizeMultiplier}
            returnKeyType="search"
            autoFocus={!params.q && params.listen !== '1'}
            onSubmitEditing={() => void run(question)}
            accessibilityLabel={t.ask.screen.questionLabel}
            clearButtonMode="while-editing"
          />
          {canListen && (
            <IconButton
              icon={listening ? 'stop.circle.fill' : 'mic.fill'}
              label={listening ? t.ask.screen.stopListening : t.ask.screen.speak}
              color={listening ? p.danger : p.accent}
              onPress={toggleMic}
            />
          )}
        </View>
        <View style={styles.privacy}>
          <SymbolView name="lock.fill" tintColor={p.success} size={12} />
          <T v="caption" muted style={{ flex: 1 }}>
            {t.ask.screen.privacy}
          </T>
        </View>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: space.lg, paddingBottom: insets.bottom + space.xxl, gap: space.md }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag">
        {!index.hasSystems ? (
          <T muted>{t.ask.screen.noSystems}</T>
        ) : !index.canReview && !index.isLoading ? (
          <T muted>{t.ask.screen.liveOnly}</T>
        ) : null}

        {(busy || (loadingIndex && waiting)) && (
          <View style={styles.busy}>
            <ActivityIndicator />
            <T muted style={{ flex: 1 }}>
              {loadingIndex ? t.ask.screen.loadingIndex : t.ask.screen.searching}
            </T>
          </View>
        )}

        {error && <T color={p.danger}>{error}</T>}
        {!!index.data?.failed.length && (
          <T v="caption" muted>
            {t.ask.screen.failed(index.data.failed.join(', '))}
          </T>
        )}

        {result && !busy && (
          <>
            <Card style={{ padding: space.lg, gap: space.sm }}>
              <T v="heading">{result.text}</T>
              <T v="caption" muted>
                {result.usedModel ? t.ask.screen.usedModel : t.ask.screen.usedLocal}
                {result.query.kind === 'count' && result.matches.length > 1 ? t.ask.screen.countNote : ''}
              </T>
            </Card>
            {result.matches.length > 0 && (
              <T v="label" muted>
                {t.ask.screen.recordings(result.matches.length)}
                {result.matches.length > 40 ? t.ask.screen.showingLatest(40) : ''}
              </T>
            )}
            {result.matches.slice(0, 40).map((e) => (
              <Pressable
                key={`${e.systemId}:${e.id}`}
                onPress={() => open(e)}
                accessibilityRole="button"
                accessibilityLabel={t.ask.screen.rowLabel(eventSubject(e, result.query), e.camera, formatRelative(e.start))}
                style={({ pressed }) => [styles.row, large && styles.rowLarge, pressed && { backgroundColor: p.surface }]}>
                <View style={[styles.thumb, { borderRadius: Math.min(radius, 12), backgroundColor: p.surface }]}>
                  {e.thumbnailUrl && <Image source={{ uri: e.thumbnailUrl }} style={StyleSheet.absoluteFill} contentFit="cover" />}
                </View>
                <View style={large ? { gap: 3 } : { flex: 1, gap: 3 }}>
                  <T v="label" numberOfLines={large ? undefined : 2}>
                    {capitalize(eventSubject(e, result.query))}
                  </T>
                  <T v="caption" muted numberOfLines={large ? undefined : 2}>
                    {e.camera} · {formatRelative(e.start)}
                  </T>
                </View>
                <SymbolView name="play.circle.fill" tintColor={p.accent} size={24} />
              </Pressable>
            ))}
          </>
        )}

        {!result && !busy && !error && (
          <View style={{ gap: space.sm }}>
            <T v="caption" muted>
              {t.ask.screen.tryAsking}
            </T>
            <View style={styles.chips}>
              {EXAMPLE_KEYS.map((k) => (
                <Chip key={k} label={t.ask.screen.examples[k]} selected={false} onPress={() => void run(EXAMPLES[k], t.ask.screen.examples[k])} />
              ))}
            </View>
          </View>
        )}

        {reason && (
          <T v="caption" muted>
            {reason}
          </T>
        )}
      </ScrollView>
    </View>
  );
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.lg, paddingBottom: space.sm },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    paddingLeft: space.md,
    minHeight: 50,
  },
  input: { flex: 1, paddingVertical: 12 },
  privacy: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 4 },
  busy: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.sm, borderRadius: 12 },
  // Big text: picture on top, words below at full width.
  rowLarge: { flexDirection: 'column', alignItems: 'flex-start' },
  thumb: { width: 112, height: 63, overflow: 'hidden' },
});

import type { ErrorBoundaryProps } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, useColorScheme, View } from 'react-native';

import { useT } from '../i18n/use-t';
import { noteProblem } from './log';
import { buildReport, emailReport, shareReportFile, supportEmailSet } from './send';

/**
 * The root ErrorBoundary (exported from app/_layout.tsx): shown instead of a blank or frozen
 * app when a screen crashes. Self-contained on purpose (plain React Native, no theme or
 * navigation), since whatever broke may be one of those.
 */
export function ErrorScreen({ error, retry }: ErrorBoundaryProps) {
  const dark = useColorScheme() !== 'light';
  const c = dark
    ? { bg: '#0B0D12', text: '#F2F3F7', muted: '#9AA0AE', button: '#7C5CFF', buttonText: '#FFFFFF', secondary: '#1C2030' }
    : { bg: '#F6F7FB', text: '#11131A', muted: '#5B6070', button: '#7C5CFF', buttonText: '#FFFFFF', secondary: '#E6E8F0' };
  const t = useT();
  const e = t.settings.errorScreen;
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<string | null>(null);

  useEffect(() => {
    noteProblem('js', `${error.name}: ${error.message}`, { category: 'screen-crash', keepDetail: true, flush: true });
  }, [error]);

  const send = async () => {
    setSending(true);
    try {
      const report = await buildReport({ error, includeHub: false });
      if (supportEmailSet && (await emailReport(report))) setSent(t.settings.report.mailOpened);
      else {
        await shareReportFile(report);
        setSent(null);
      }
    } catch {
      setSent(e.makeFailed);
    } finally {
      setSending(false);
    }
  };

  return (
    <ScrollView style={{ backgroundColor: c.bg }} contentContainerStyle={styles.root}>
      <Text style={[styles.title, { color: c.text }]} accessibilityRole="header">
        {e.title}
      </Text>
      <Text style={[styles.body, { color: c.muted }]}>
        {e.body}
      </Text>

      <Pressable
        accessibilityRole="button"
        onPress={() => void retry()}
        style={({ pressed }) => [styles.button, { backgroundColor: c.button, opacity: pressed ? 0.8 : 1 }]}>
        <Text style={[styles.buttonText, { color: c.buttonText }]}>{t.common.retry}</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        disabled={sending}
        onPress={() => void send()}
        style={({ pressed }) => [styles.button, { backgroundColor: c.secondary, opacity: pressed ? 0.8 : 1 }]}>
        {sending ? <ActivityIndicator color={c.text} /> : <Text style={[styles.buttonText, { color: c.text }]}>{e.send}</Text>}
      </Pressable>

      {sent && <Text style={[styles.small, { color: c.text }]}>{sent}</Text>}
      <View style={{ height: 8 }} />
      <Text style={[styles.small, { color: c.muted }]}>
        {e.footnote}
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flexGrow: 1, justifyContent: 'center', padding: 24, paddingTop: 80, gap: 14 },
  title: { fontSize: 28, fontWeight: '700' },
  body: { fontSize: 17, lineHeight: 23, marginBottom: 10 },
  button: { minHeight: 50, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  buttonText: { fontSize: 17, fontWeight: '600' },
  small: { fontSize: 13, lineHeight: 18 },
});

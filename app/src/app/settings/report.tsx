import { useQueryClient } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text } from 'react-native';

import { Button, Card, Disclosure, Field, Screen, Section, T, ToggleRow } from '@/components/ui/primitives';
import { SUPPORT_EMAIL } from '@/config';
import { formatReport, type ReportInput } from '@/diagnostics/core';
import { useDiagnostics } from '@/diagnostics/log';
import { emailReport, gatherReport, shareReportFile, supportEmailSet } from '@/diagnostics/send';
import { space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';

/**
 * Settings → Help → Report a problem. Shows exactly what will be sent, lets the user add a
 * note, then hands it to Mail or the share sheet. Nothing leaves the phone until they tap Send.
 */
export default function ReportProblem() {
  const p = usePalette();
  const qc = useQueryClient();
  const include = useDiagnostics((s) => s.includeDiagnostics);
  const setInclude = useDiagnostics((s) => s.setIncludeDiagnostics);
  const eventCount = useDiagnostics((s) => s.events.length);
  const clear = useDiagnostics((s) => s.clear);
  const [note, setNote] = useState('');
  const [input, setInput] = useState<ReportInput | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // Gather once (and again when the toggle or the problem list changes); the note is
  // formatted in as the user types, so the preview is always exactly what will be sent.
  useEffect(() => {
    let live = true;
    void gatherReport({ queryClient: qc }).then((i) => live && setInput(i), () => live && setMsg('Couldn’t gather diagnostics.'));
    return () => {
      live = false;
    };
  }, [qc, include, eventCount]);

  const report = useMemo(() => (input ? formatReport({ ...input, note }) : null), [input, note]);

  const send = async (how: 'mail' | 'file') => {
    if (!report) return;
    setMsg(null);
    setBusy(true);
    try {
      if (how === 'file') await shareReportFile(report);
      else if (await emailReport(report)) setMsg('Mail opened. Check the message, then tap Send.');
      else setMsg('Mail isn’t set up on this phone. Use “Share as file” instead.');
    } catch {
      setMsg('Couldn’t open the report. Try again in a moment.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Stack.Screen options={{ title: 'Report a problem' }} />
      <T muted>
        Tell us what went wrong. You can read the whole report below before it’s sent, and nothing leaves your phone
        until you tap Send.
      </T>

      <Field
        label="What happened?"
        value={note}
        onChangeText={setNote}
        placeholder="For example: the driveway camera won’t play when I’m away"
        multiline
        style={{ minHeight: 90, textAlignVertical: 'top' }}
        hint="Please don’t type passwords. Addresses and camera names are removed automatically."
      />

      <Section footer="Recent connection problems by brand, plus crash reports from iOS and your Hub. Never camera names, addresses, passwords, pictures or video.">
        <ToggleRow label="Include diagnostics automatically when I report a problem" value={include} onChange={setInclude} last />
      </Section>

      {supportEmailSet ? (
        <Button title="Email report" onPress={() => void send('mail')} loading={busy} disabled={!report} />
      ) : (
        <T v="caption" muted>
          This version doesn’t have a support email address yet, so use “Share as file” and send it however you like.
        </T>
      )}
      <Button title="Share as file" kind="secondary" onPress={() => void send('file')} disabled={!report || busy} />
      {msg && <T muted>{msg}</T>}

      <Disclosure title="See what will be sent">
        <Card style={{ padding: space.md }}>
          {report ? (
            <Text selectable style={[styles.preview, { color: p.textMuted }]}>
              {report.text}
            </Text>
          ) : (
            <ActivityIndicator />
          )}
        </Card>
        {report && report.file !== report.text && (
          <T v="caption" muted>
            “Share as file” also adds iOS’s technical crash data (app code locations, no personal information).
          </T>
        )}
        {supportEmailSet && (
          <T v="caption" muted>
            Sent to {SUPPORT_EMAIL}.
          </T>
        )}
        {eventCount > 0 && <Button title="Clear recent problems" kind="ghost" onPress={clear} />}
      </Disclosure>
    </Screen>
  );
}

const styles = StyleSheet.create({
  preview: { fontFamily: 'Menlo', fontSize: 11, lineHeight: 15 },
});

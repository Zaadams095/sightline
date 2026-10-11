import { useQueryClient } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text } from 'react-native';

import { Button, Card, Disclosure, Field, Screen, Section, T, ToggleRow } from '@/components/ui/primitives';
import { SUPPORT_EMAIL } from '@/config';
import { formatReport, type ReportInput } from '@/diagnostics/core';
import { useDiagnostics } from '@/diagnostics/log';
import { emailReport, gatherReport, shareReportFile, supportEmailSet } from '@/diagnostics/send';
import { tr } from '@/i18n';
import { useT } from '@/i18n/use-t';
import { space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';

/**
 * Settings → Help → Report a problem. Shows exactly what will be sent, lets the user add a
 * note, then hands it to Mail or the share sheet. Nothing leaves the phone until they tap Send.
 */
export default function ReportProblem() {
  const p = usePalette();
  const r = useT().settings.report;
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
    void gatherReport({ queryClient: qc }).then((i) => live && setInput(i), () => live && setMsg(tr().settings.report.gatherFailed));
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
      else if (await emailReport(report)) setMsg(r.mailOpened);
      else setMsg(r.noMail);
    } catch {
      setMsg(r.openFailed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Stack.Screen options={{ title: r.title }} />
      <T muted>{r.intro}</T>

      <Field
        label={r.whatHappened}
        value={note}
        onChangeText={setNote}
        placeholder={r.placeholder}
        multiline
        style={{ minHeight: 90, textAlignVertical: 'top' }}
        hint={r.hint}
      />

      <Section footer={r.footer}>
        <ToggleRow label={r.include} value={include} onChange={setInclude} last />
      </Section>

      {supportEmailSet ? (
        <Button title={r.email} onPress={() => void send('mail')} loading={busy} disabled={!report} />
      ) : (
        <T v="caption" muted>
          {r.noSupportEmail}
        </T>
      )}
      <Button title={r.shareFile} kind="secondary" onPress={() => void send('file')} disabled={!report || busy} />
      {msg && <T muted>{msg}</T>}

      <Disclosure title={r.seeWhat}>
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
            {r.fileExtra}
          </T>
        )}
        {supportEmailSet && (
          <T v="caption" muted>
            {r.sentTo(SUPPORT_EMAIL)}
          </T>
        )}
        {eventCount > 0 && <Button title={r.clearRecent} kind="ghost" onPress={clear} />}
      </Disclosure>
    </Screen>
  );
}

const styles = StyleSheet.create({
  preview: { fontFamily: 'Menlo', fontSize: 11, lineHeight: 15 },
});

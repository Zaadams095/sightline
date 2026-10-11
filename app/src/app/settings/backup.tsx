import { Image } from 'expo-image';
import { useEffect, useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';

import { MIN_PASSCODE, passcodeProblem } from '@/backup/bundle';
import { backupNow, cloudBackupSupported, deleteCloudBackup, iCloudSignedIn, setCloudBackupEnabled } from '@/backup/icloud';
import { useBackup } from '@/backup/settings';
import { exportBackupFile, fileBackupSupported, startTransfer, stopTransfer, transferStatus, transferSupported, type OutgoingTransfer } from '@/backup/transfer';
import { Button, Card, Field, Row, Screen, Section, T, ToggleRow } from '@/components/ui/primitives';
import { useT } from '@/i18n/use-t';
import { formatRelative } from '@/util/format';
import { space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';

/** Settings → Backup & new phone. */
export default function BackupSettings() {
  const p = usePalette();
  const t = useT();
  const b = t.settings.backup;
  const enabled = useBackup((s) => s.enabled);
  const lastBackupAt = useBackup((s) => s.lastBackupAt);
  const lastError = useBackup((s) => s.lastError);
  const [mode, setMode] = useState<'none' | 'transfer' | 'export'>('none');
  const transfer = useTransferSession();
  const closeTransfer = () => {
    transfer.stop();
    setMode('none');
  };

  const supported = cloudBackupSupported();
  const signedIn = supported && iCloudSignedIn();
  const status = !supported
    ? b.needsUpdate
    : !signedIn
      ? b.signInICloud
      : !enabled
        ? t.common.off
        : (lastError ?? (lastBackupAt ? b.backedUp(formatRelative(Math.floor(lastBackupAt / 1000))) : b.backingUpSoon));

  const confirmDelete = () =>
    Alert.alert(
      b.deleteTitle,
      b.deleteBody,
      [
        { text: t.common.cancel, style: 'cancel' },
        { text: t.common.delete, style: 'destructive', onPress: () => void deleteCloudBackup() },
      ],
    );

  return (
    <Screen>
      <Section
        title="iCloud"
        footer={b.icloudFooter}>
        <ToggleRow
          label={b.backUpToICloud}
          detail={status}
          value={enabled && supported}
          onChange={(v) => {
            setCloudBackupEnabled(v);
            if (v) void backupNow();
          }}
        />
        {enabled && signedIn && <Row label={b.backUpNow} onPress={() => void backupNow()} />}
        <Row label={b.deleteBackup} destructive onPress={confirmDelete} last />
      </Section>

      <Section
        title={b.movingTitle}
        footer={b.movingFooter}>
        <Row
          label={b.transfer}
          detail={b.transferDetail}
          onPress={() => {
            if (mode === 'transfer') return closeTransfer();
            setMode('transfer');
            if (transferSupported()) void transfer.start();
          }}
        />
        <Row
          label={b.exportFile}
          detail={b.exportDetail}
          onPress={() => {
            if (mode === 'transfer') transfer.stop();
            setMode(mode === 'export' ? 'none' : 'export');
          }}
          last
        />
      </Section>

      {mode === 'transfer' && <TransferCard session={transfer} onClose={closeTransfer} />}
      {mode === 'export' && <ExportCard onClose={() => setMode('none')} />}

      {!transferSupported() && mode !== 'none' && (
        <T v="caption" color={p.warning}>
          {b.needsUpdateLong}
        </T>
      )}
    </Screen>
  );
}

/** One QR transfer at a time; stopped when the screen closes. */
function useTransferSession() {
  const [t, setT] = useState<OutgoingTransfer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    setError(null);
    setT(null);
    try {
      setT(await startTransfer());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const stop = () => {
    stopTransfer();
    setT(null);
    setError(null);
  };
  useEffect(() => () => stopTransfer(), []);
  return { t, error, busy, start, stop };
}

function TransferCard({ session, onClose }: { session: ReturnType<typeof useTransferSession>; onClose: () => void }) {
  const p = usePalette();
  const tt = useT();
  const b = tt.settings.backup;
  const { t, error, busy } = session;
  const make = session.start;
  const [served, setServed] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!t || served) return;
    const id = setInterval(() => {
      setNow(Date.now());
      if (transferStatus().served) setServed(true);
    }, 1000);
    return () => clearInterval(id);
  }, [t, served]);

  const left = t ? Math.max(0, Math.round((t.expiresAt - now) / 1000)) : 0;
  const expired = !!t && left === 0 && !served;

  return (
    <Card style={{ padding: space.lg, gap: space.md, alignItems: 'stretch' }}>
      {served ? (
        <>
          <T v="label" color={p.success}>
            {b.transferDone}
          </T>
          <T muted>{b.keepUsing}</T>
          <Button title={tt.common.close} onPress={onClose} />
        </>
      ) : (
        <>
          <T v="label">{b.onNewPhone}</T>
          <T muted>{b.newPhoneSteps}</T>
          {t && !expired && (
            <View style={styles.qrWrap}>
              <Image source={{ uri: t.qr }} style={styles.qr} contentFit="contain" accessibilityLabel={b.transferCode} />
            </View>
          )}
          {t && !expired && (
            <T v="caption" muted style={{ textAlign: 'center' }}>
              {b.worksOnce(`${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`)}
            </T>
          )}
          {expired && <T muted>{b.codeRanOut}</T>}
          {(expired || error) && <Button title={b.makeNewCode} onPress={() => void make()} loading={busy} />}
          {busy && !t && <Button title={b.preparing} onPress={() => {}} loading />}
          {error && <T color={p.danger}>{error}</T>}
          <Button
            title={tt.common.cancel}
            kind="ghost"
            onPress={() => {
              stopTransfer();
              onClose();
            }}
          />
        </>
      )}
    </Card>
  );
}

function ExportCard({ onClose }: { onClose: () => void }) {
  const p = usePalette();
  const b = useT().settings.backup;
  const [pass, setPass] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = pass ? passcodeProblem(pass) : null;
  const mismatch = !!again && again !== pass;

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await exportBackupFile(pass);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card style={{ padding: space.lg, gap: space.md }}>
      <T muted>
        {b.exportIntro(MIN_PASSCODE)}
      </T>
      <Field label={b.passcode} value={pass} onChangeText={setPass} secureTextEntry hint={problem ?? undefined} />
      <Field label={b.typeAgain} value={again} onChangeText={setAgain} secureTextEntry hint={mismatch ? b.noMatch : undefined} />
      <Button title={b.exportButton} onPress={() => void go()} loading={busy} disabled={!fileBackupSupported() || !pass || !!problem || again !== pass} />
      {error && <T color={p.danger}>{error}</T>}
    </Card>
  );
}

const styles = StyleSheet.create({
  qrWrap: { alignSelf: 'center', backgroundColor: '#fff', padding: space.md, borderRadius: 16 },
  qr: { width: 240, height: 240 },
});

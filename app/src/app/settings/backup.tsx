import { Image } from 'expo-image';
import { useEffect, useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';

import { MIN_PASSCODE, passcodeProblem } from '@/backup/bundle';
import { backupNow, cloudBackupSupported, deleteCloudBackup, iCloudSignedIn, setCloudBackupEnabled } from '@/backup/icloud';
import { useBackup } from '@/backup/settings';
import { exportBackupFile, fileBackupSupported, startTransfer, stopTransfer, transferStatus, transferSupported, type OutgoingTransfer } from '@/backup/transfer';
import { Button, Card, Field, Row, Screen, Section, T, ToggleRow } from '@/components/ui/primitives';
import { formatRelative } from '@/util/format';
import { space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';

/** Settings → Backup & new phone. */
export default function BackupSettings() {
  const p = usePalette();
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
    ? 'Needs the latest version of Sightline.'
    : !signedIn
      ? 'Sign in to iCloud in the Settings app to back up.'
      : !enabled
        ? 'Off'
        : (lastError ?? (lastBackupAt ? `Backed up ${formatRelative(Math.floor(lastBackupAt / 1000))}` : 'Backing up soon'));

  const confirmDelete = () =>
    Alert.alert(
      'Delete your iCloud backup?',
      'This removes your Sightline settings and camera passwords from iCloud and turns backup off. Everything stays on this phone.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => void deleteCloudBackup() },
      ],
    );

  return (
    <Screen>
      <Section
        title="iCloud"
        footer="Your recorders, camera order, groups, layouts and alert settings are saved in your own iCloud, and camera passwords in iCloud Keychain. A new iPhone signed in to your Apple Account sets itself up from them. Videos are never uploaded, and Sightline has no servers of its own.">
        <ToggleRow
          label="Back up to iCloud"
          detail={status}
          value={enabled && supported}
          onChange={(v) => {
            setCloudBackupEnabled(v);
            if (v) void backupNow();
          }}
        />
        {enabled && signedIn && <Row label="Back up now" onPress={() => void backupNow()} />}
        <Row label="Delete iCloud backup" destructive onPress={confirmDelete} last />
      </Section>

      <Section
        title="Moving to a new phone"
        footer="No iCloud? Move everything straight to the new phone over your home Wi-Fi, or save an encrypted backup file to AirDrop or keep in Files.">
        <Row
          label="Transfer to another phone"
          detail="Show a code for the new phone to scan"
          onPress={() => {
            if (mode === 'transfer') return closeTransfer();
            setMode('transfer');
            if (transferSupported()) void transfer.start();
          }}
        />
        <Row
          label="Export backup file"
          detail="Protected with a passcode you choose"
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
          This needs the latest version of Sightline. Update from TestFlight or the App Store.
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
            Done! Your cameras are on the new phone.
          </T>
          <T muted>You can keep using this phone too.</T>
          <Button title="Close" onPress={onClose} />
        </>
      ) : (
        <>
          <T v="label">On the new phone</T>
          <T muted>Open Sightline, tap “Moving from another phone?”, then “Scan the code”. Keep both phones on the same Wi-Fi.</T>
          {t && !expired && (
            <View style={styles.qrWrap}>
              <Image source={{ uri: t.qr }} style={styles.qr} contentFit="contain" accessibilityLabel="Transfer code" />
            </View>
          )}
          {t && !expired && (
            <T v="caption" muted style={{ textAlign: 'center' }}>
              Works once, for {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')} more. It includes your camera passwords, so only show it to your
              own phone.
            </T>
          )}
          {expired && <T muted>That code ran out.</T>}
          {(expired || error) && <Button title="Make a new code" onPress={() => void make()} loading={busy} />}
          {busy && !t && <Button title="Preparing…" onPress={() => {}} loading />}
          {error && <T color={p.danger}>{error}</T>}
          <Button
            title="Cancel"
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
        Choose a passcode for the file (at least {MIN_PASSCODE} letters or numbers). You’ll type it on the new phone. Write it down: without it the
        file can’t be opened, not even by us.
      </T>
      <Field label="Passcode" value={pass} onChangeText={setPass} secureTextEntry hint={problem ?? undefined} />
      <Field label="Type it again" value={again} onChangeText={setAgain} secureTextEntry hint={mismatch ? 'The two don’t match yet.' : undefined} />
      <Button title="Export" onPress={() => void go()} loading={busy} disabled={!fileBackupSupported() || !pass || !!problem || again !== pass} />
      {error && <T color={p.danger}>{error}</T>}
    </Card>
  );
}

const styles = StyleSheet.create({
  qrWrap: { alignSelf: 'center', backgroundColor: '#fff', padding: space.md, borderRadius: 16 },
  qr: { width: 240, height: 240 },
});

import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useEffect, useState } from 'react';
import { Alert, Pressable, View } from 'react-native';

import { cloudBackupSupported, findCloudBackup, restoreFromCloud, type CloudBackupInfo } from '@/backup/icloud';
import { needsPasswordText } from '@/backup/restore';
import { useBackup } from '@/backup/settings';
import { Button, Card, T } from '@/components/ui/primitives';
import { useT } from '@/i18n/use-t';
import { formatRelative } from '@/util/format';
import { space } from '@/theme/tokens';
import { usePalette } from '@/theme/use-palette';

/**
 * Top of the first-run welcome screen: offers to restore from iCloud when a backup exists,
 * and links to moving from another phone (QR transfer or backup file).
 */
export function WelcomeBack() {
  const p = usePalette();
  const w = useT().settings.welcomeBack;
  const dismissed = useBackup((s) => s.restoreDismissed);
  const [info, setInfo] = useState<CloudBackupInfo | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!cloudBackupSupported() || dismissed) return;
    let live = true;
    // A brand-new phone may take a while to download iCloud data: keep looking for a minute.
    void findCloudBackup(60_000).then((found) => {
      if (live) setInfo(found);
    });
    return () => {
      live = false;
    };
  }, [dismissed]);

  const restore = async () => {
    if (!info) return;
    setBusy(true);
    try {
      const result = await restoreFromCloud(info);
      router.replace('/');
      const note = needsPasswordText(result);
      if (note) Alert.alert(w.almostThere, note);
    } catch (e) {
      Alert.alert(w.couldntRestore, e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ gap: space.sm }}>
      {info && !dismissed && (
        <Card style={{ padding: space.lg, gap: space.md }}>
          <View style={{ flexDirection: 'row', gap: space.md, alignItems: 'center' }}>
            <SymbolView name="icloud.and.arrow.down" tintColor={p.accent} size={28} />
            <View style={{ flex: 1, gap: 2 }}>
              <T v="label">{w.title}</T>
              <T v="caption" muted>
                {info.summary}
                {info.from ? ` · ${w.from(info.from)}` : ''}
                {info.updatedAt ? `, ${formatRelative(Math.floor(info.updatedAt / 1000))}` : ''}
              </T>
            </View>
          </View>
          <Button title={w.restore} onPress={() => void restore()} loading={busy} />
          <Button title={w.startFresh} kind="ghost" onPress={() => useBackup.getState().set({ restoreDismissed: true })} />
        </Card>
      )}
      <Pressable
        onPress={() => router.push('/onboarding/move')}
        accessibilityRole="button"
        hitSlop={8}
        style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <SymbolView name="iphone.and.arrow.forward" tintColor={p.accent} size={20} />
        <T color={p.accent} style={{ flexShrink: 1 }}>
          {w.moving}
        </T>
      </Pressable>
    </View>
  );
}

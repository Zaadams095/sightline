import * as Device from 'expo-device';

import { registerBackgroundAlerts, requestNotificationPermission } from '@/alerts/background';
import { bridgeSecret, syncBridge, syncHubDevices } from '@/alerts/bridge';
import { migrateMasks } from '@/alerts/zones';
import { makeBundle, type Bundle } from '@/backup/bundle';
import { applySections, extractSections, secretRefs, SECTIONS, type LegacySections, type SecretRef, type SecretValue, type Sections } from '@/backup/sections';
import { useBackup } from '@/backup/settings';
import { pullSecretsFromCloud, readSecrets, SECRET, writeSecrets } from '@/state/secrets';
import { smartBackupSource, smartHydrated, useSmart } from '@/state/smart';
import { useApp } from '@/state/store';
import { migrateStreamCredentials, restoreSnapshotCredentials } from '@/systems/stream-credentials';
import type { SystemConfig } from '@/systems/types';
import { WgTunnel } from '@modules/wg-tunnel';

/** Everything needed to set up another phone: settings plus every secret (for an encrypted bundle). */
export async function buildBundle(): Promise<Bundle> {
  // Stream-link passwords travel as secrets, never inside the settings.
  await migrateStreamCredentials();
  await smartHydrated();
  const st = useApp.getState();
  const sections = extractSections({ ...st, smart: smartBackupSource() });
  const values = await readSecrets(secretRefs(st.systems));
  return makeBundle(sections, values, Device.deviceName ?? undefined);
}

export interface RestoreResult {
  systems: number;
  /** Systems whose password or Hub token hasn't arrived (iCloud Keychain off, or still syncing). */
  needsPassword: string[];
}

/** Secrets a system can't connect without. */
function expectedSecrets(systems: SystemConfig[]): (SecretRef & { system: string })[] {
  const out: (SecretRef & { system: string })[] = [];
  for (const s of systems) {
    if (s.kind === 'hub') out.push({ scope: s.id, name: SECRET.token, system: s.name });
    else if (s.username) out.push({ scope: s.id, name: SECRET.password, system: s.name });
  }
  return out;
}

/**
 * Applies a backup (from iCloud, the Wi-Fi transfer or a backup file) to this phone and
 * finishes setup, so the cameras connect as soon as the Live tab opens.
 */
export async function applyBackup(sections: Sections & LegacySections, received?: SecretValue[]): Promise<RestoreResult> {
  // A late load of the smart-alerts store from disk would undo the restore: wait for it.
  await smartHydrated();
  const { smart, ...patch } = applySections(sections, { ...useApp.getState(), smart: smartBackupSource() }, migrateMasks);
  useApp.setState(patch);
  // Learned feedback, the rain/wind setting and check-ins. Changing the store re-syncs them to
  // the Hub (alerts/bridge.ts watchBridgeSync); the syncHubDevices / syncBridge calls below
  // cover a restore during first-run setup, before that watcher runs.
  if (smart) useSmart.setState(smart);
  if (received?.length) await writeSecrets(received);
  await restoreSnapshotCredentials().catch(() => {});

  const st = useApp.getState();
  const missing = await pullSecretsFromCloud(expectedSecrets(st.systems));
  const needsPassword = [...new Set(missing.map((m) => (m as SecretRef & { system: string }).system))];

  // The notification extension reads the bridge secret from the App Group keychain, which is
  // per device: put this phone's copy there. Only when the real one is already here, so a
  // still-syncing iCloud Keychain can't be replaced by a new random secret.
  void (async () => {
    try {
      const hasHub = st.systems.some((s) => s.kind === 'hub');
      if (st.alerts.bridge) WgTunnel?.setShared('bridge.url', st.alerts.bridge.url);
      if (st.alerts.bridge || hasHub) await bridgeSecret();
    } catch {}
  })();

  if (!st.onboarded) {
    await requestNotificationPermission().catch(() => false);
    await registerBackgroundAlerts().catch(() => {});
    st.setOnboarded(true);
  }
  // This phone registers for push on its own (push tokens are per phone, never in a backup).
  void syncHubDevices().catch(() => {});
  if (st.alerts.mode === 'instant' && st.alerts.bridge) void syncBridge().catch(() => {});

  return { systems: st.systems.length, needsPassword };
}

/** After applying a transfer or file: back the new settings up as this phone's own edit. */
export function markAllChanged() {
  const now = Date.now();
  useBackup.getState().set({ meta: Object.fromEntries(SECTIONS.map((s) => [s, { hash: 'received', updatedAt: now }])) });
}

/** Plain-language follow-up for passwords that didn't come over. */
export function needsPasswordText(r: RestoreResult): string | null {
  if (!r.needsPassword.length) return null;
  const names = r.needsPassword.join(', ');
  return `Passwords for ${names} haven’t arrived from iCloud Keychain yet. They usually do within a few minutes. If not, open Settings, tap the system and type its password again.`;
}

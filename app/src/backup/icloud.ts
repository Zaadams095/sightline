import * as Device from 'expo-device';

import {
  countCameras,
  decodeSection,
  encodeSection,
  extractSections,
  fitToBudget,
  hashSection,
  KV_PREFIX,
  KV_SUMMARY,
  LEGACY_SECTIONS,
  localNewerSections,
  planUpload,
  readHeader,
  secretRefs,
  SECTIONS,
  staleParts,
  summaryText,
  type LegacySections,
  type SectionName,
  type Sections,
  type SectionStamp,
} from '@/backup/sections';
import { applyBackup, type RestoreResult } from '@/backup/restore';
import { backupDeviceId, backupHydrated, useBackup } from '@/backup/settings';
import { copySecretsToCloud, removeCloudSecrets } from '@/state/secrets';
import { smartBackupSource, smartHydrated, useSmart } from '@/state/smart';
import { tr } from '@/i18n';
import { useApp } from '@/state/store';
import { migrateStreamCredentials } from '@/systems/stream-credentials';
import { CLOUD_CHANGE, CloudBackup } from '@modules/cloud-backup';

/**
 * Automatic iCloud backup of settings (iCloud key-value storage; passwords go through iCloud
 * Keychain, see state/secrets.ts). Apple's servers only; Sightline has no server of its own.
 *
 * Why key-value storage and not CloudKit: the settings are small (well under its 1 MB), it
 * needs no CloudKit container/schema to manage, works offline and syncs on its own, and Apple
 * resolves each key last-writer-wins, which is the policy we want per section anyway.
 */

export const cloudBackupSupported = () => !!CloudBackup;
export const iCloudSignedIn = () => !!CloudBackup?.isSignedIn();

const kvGet = (k: string) => CloudBackup?.kvGet(k) ?? null;

export interface CloudBackupInfo {
  sections: Sections & LegacySections;
  stamps: Partial<Record<SectionName, SectionStamp>>;
  /** "3 systems, 14 cameras". */
  summary: string;
  /** "Zach's iPhone". */
  from: string | null;
  updatedAt: number;
}

/** The backup in iCloud, or null when there's none (or it hasn't finished downloading). */
export function readCloudBackup(): CloudBackupInfo | null {
  if (!CloudBackup) return null;
  const sections: Sections & LegacySections = {};
  const stamps: Partial<Record<SectionName, SectionStamp>> = {};
  for (const s of SECTIONS) {
    const d = decodeSection(s, kvGet);
    if (d) {
      sections[s] = d.data;
      stamps[s] = d.stamp;
    }
  }
  for (const s of LEGACY_SECTIONS) {
    const d = decodeSection(s as unknown as SectionName, kvGet);
    if (d) sections[s] = d.data;
  }
  if (!Array.isArray(sections.systems) || sections.systems.length === 0) return null;
  let from: string | null = null;
  try {
    from = (JSON.parse(kvGet(KV_SUMMARY) ?? '{}') as { deviceName?: string }).deviceName ?? null;
  } catch {}
  const updatedAt = Math.max(0, ...Object.values(stamps).map((st) => st.updatedAt));
  return { sections, stamps, summary: summaryText(sections), from, updatedAt };
}

let running: Promise<void> | null = null;

/** Uploads whatever changed since the last backup. Safe to call often. */
export function backupNow(): Promise<void> {
  running ??= doBackup().finally(() => {
    running = null;
  });
  return running;
}

async function doBackup(): Promise<void> {
  await backupHydrated();
  const b = useBackup.getState();
  const st = useApp.getState();
  if (!b.enabled || !CloudBackup) return;
  // Nothing worth keeping yet (and never overwrite a backup with an empty phone).
  if (!st.onboarded || st.systems.length === 0) return;
  if (!CloudBackup.isSignedIn()) {
    b.set({ lastError: tr().settings.backup.signInICloud });
    return;
  }

  // Stream-link passwords go to the keychain first (extractSections strips them regardless).
  await migrateStreamCredentials().catch(() => {});

  if (!b.secretsMigrated) {
    try {
      await copySecretsToCloud(secretRefs(st.systems));
      b.set({ secretsMigrated: true });
    } catch {
      // iCloud Keychain may be off; settings still back up. Retried next time.
    }
  }

  // Never back up the smart-alerts defaults in place of what's still loading from disk.
  await smartHydrated();
  const fit = fitToBudget(extractSections({ ...st, smart: smartBackupSource() }));
  const sections = fit.sections;
  const hashes = Object.fromEntries(SECTIONS.map((s) => [s, hashSection(sections[s])])) as Record<SectionName, string>;
  const remote = Object.fromEntries(SECTIONS.map((s) => [s, readHeader(s, kvGet)]));
  const now = Date.now();
  const plan = planUpload(hashes, b.meta, remote, now, backupDeviceId());

  const written = Object.keys(plan.write) as SectionName[];
  for (const s of written) {
    const pairs = encodeSection(s, plan.write[s]!, sections[s]);
    for (const [k, v] of pairs) CloudBackup.kvSet(k, v);
    for (const k of staleParts(s, remote[s]?.n ?? 0, pairs)) CloudBackup.kvRemove(k);
  }
  if (written.length) {
    CloudBackup.kvSet(
      KV_SUMMARY,
      JSON.stringify({ deviceName: Device.deviceName ?? null, updatedAt: now, systems: st.systems.length, cameras: countCameras(sections) }),
    );
    CloudBackup.kvSynchronize();
  }
  b.set({
    meta: plan.meta,
    lastBackupAt: now,
    lastError: fit.fits ? null : tr().settings.backupMsg.tooBig,
  });
}

/**
 * Starts automatic backup: shortly after launch, a few seconds after settings change, and
 * when iCloud reports a change from another phone (e.g. the backup was deleted there).
 */
export function startCloudBackup(): () => void {
  if (!CloudBackup) return () => {};
  let timer: ReturnType<typeof setTimeout> | null = null;
  const soon = (ms: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void backupNow().catch(() => {}), ms);
  };
  soon(5000);

  const unsubApp = useApp.subscribe((st, prev) => {
    if (
      st.systems !== prev.systems ||
      st.appearance !== prev.appearance ||
      st.phoneOrder !== prev.phoneOrder ||
      st.hidden !== prev.hidden ||
      st.gridViews !== prev.gridViews ||
      st.cameraGroups !== prev.cameraGroups ||
      st.alerts !== prev.alerts ||
      st.alertZones !== prev.alertZones ||
      st.cameraMap !== prev.cameraMap ||
      st.savedClips !== prev.savedClips
    )
      soon(4000);
  });
  // Learned feedback, the rain/wind setting and check-ins (not check-in progress: per device).
  const unsubSmart = useSmart.subscribe((st, prev) => {
    if (st.learning !== prev.learning || st.conditions !== prev.conditions || st.checkins !== prev.checkins) soon(4000);
  });
  const unsubBackup = useBackup.subscribe((b, prev) => {
    if (b.enabled && !prev.enabled) soon(300);
  });
  const sub = CloudBackup.addListener('onCloudChange', (e) => {
    if (e.reason === CLOUD_CHANGE.quotaViolation) {
      useBackup.getState().set({ lastError: tr().settings.backupMsg.refusedTooBig });
    } else if (e.reason !== CLOUD_CHANGE.accountChange) soon(5000);
  });
  return () => {
    if (timer) clearTimeout(timer);
    unsubApp();
    unsubSmart();
    unsubBackup();
    sub.remove();
  };
}

/** Turns iCloud backup on or off. Turning it on copies existing passwords to iCloud Keychain. */
export function setCloudBackupEnabled(enabled: boolean) {
  useBackup.getState().set(enabled ? { enabled, secretsMigrated: false, lastError: null } : { enabled, lastError: null });
}

/** "Delete iCloud backup": removes the settings and passwords Sightline put in iCloud, and stops backing up. */
export async function deleteCloudBackup(): Promise<void> {
  useBackup.getState().set({ enabled: false, meta: {}, secretsMigrated: false, lastBackupAt: 0, lastError: null });
  if (!CloudBackup) return;
  for (const k of CloudBackup.kvKeys()) if (k.startsWith(KV_PREFIX)) CloudBackup.kvRemove(k);
  CloudBackup.kvSynchronize();
  await removeCloudSecrets();
}

/** Restores this phone from the iCloud backup. */
export async function restoreFromCloud(info: CloudBackupInfo): Promise<RestoreResult> {
  // Smart alerts keep learning on this phone between backups (every "Not important" tap): if
  // this phone's copy is newer than iCloud's (last writer wins, as for uploads), keep it rather
  // than rolling it back. The meta below still marks it as changed, so it's uploaded next.
  await Promise.all([backupHydrated(), smartHydrated()]);
  const local = fitToBudget(extractSections({ ...useApp.getState(), smart: smartBackupSource() })).sections;
  const keep = localNewerSections({ smart: hashSection(local.smart) }, useBackup.getState().meta, info.stamps);
  const sections = { ...info.sections };
  if (keep.includes('smart')) delete sections.smart;
  const result = await applyBackup(sections);
  // What's here now *is* the backup: don't upload it again as if it were a new edit.
  const meta = Object.fromEntries(Object.entries(info.stamps).map(([s, st]) => [s, { hash: st.hash, updatedAt: st.updatedAt }]));
  useBackup.getState().set({ meta, restoreDismissed: true, enabled: true });
  return result;
}

/**
 * Looks for an iCloud backup, waiting up to `timeoutMs` for iCloud to finish its first download
 * (a brand-new phone often hasn't yet when the app first opens).
 */
export function findCloudBackup(timeoutMs = 15_000): Promise<CloudBackupInfo | null> {
  const cb = CloudBackup;
  if (!cb || !cb.isSignedIn()) return Promise.resolve(null);
  cb.kvSynchronize();
  const now = readCloudBackup();
  if (now) return Promise.resolve(now);
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: CloudBackupInfo | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sub.remove();
      resolve(v);
    };
    const sub = cb.addListener('onCloudChange', () => {
      const found = readCloudBackup();
      if (found) finish(found);
    });
    const timer = setTimeout(() => finish(readCloudBackup()), timeoutMs);
  });
}

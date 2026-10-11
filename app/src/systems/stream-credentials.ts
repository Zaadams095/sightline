import { restoreUrlCredentials, streamSecretName, stripUrlCredentials } from '@/backup/sections';
import { secrets } from '@/state/secrets';
import { useApp } from '@/state/store';
import type { ManualCamera, SystemConfig } from '@/systems/types';

/**
 * Stream-link cameras are often saved as rtsp://user:password@camera/… . The password belongs
 * in the keychain, not the settings, so links are stored without it and the full link (with
 * it) is kept as a secret per camera, put back only when the stream is opened.
 *
 * Snapshot links (http://user:pass@…/snapshot.jpg) are read synchronously by the image view,
 * so they stay in the settings on this phone, but a copy goes to the keychain too: backups
 * leave them out of the settings and restore them from there.
 */

let migrating: Promise<void> | null = null;

/** Moves passwords out of stream links in the settings. Safe to call often. */
export function migrateStreamCredentials(): Promise<void> {
  migrating ??= doMigrate().finally(() => {
    migrating = null;
  });
  return migrating;
}

async function doMigrate(): Promise<void> {
  const moved = new Map<string, Map<string, { from: string; to: string }>>();
  for (const sys of useApp.getState().systems) {
    for (const cam of sys.manualCameras ?? []) {
      const r = stripUrlCredentials(cam.rtspUrl);
      if (r.hadCredentials) {
        try {
          await secrets.set(sys.id, streamSecretName(cam.id, 'rtsp'), cam.rtspUrl);
          if (!moved.has(sys.id)) moved.set(sys.id, new Map());
          moved.get(sys.id)!.set(cam.id, { from: cam.rtspUrl, to: r.clean });
        } catch {
          // Keychain unavailable right now: leave the link as it is and try again later.
        }
      }
      if (cam.snapshotUrl && stripUrlCredentials(cam.snapshotUrl).hadCredentials) {
        const name = streamSecretName(cam.id, 'snap');
        const saved = await secrets.get(sys.id, name).catch(() => null);
        if (saved !== cam.snapshotUrl) await secrets.set(sys.id, name, cam.snapshotUrl).catch(() => {});
      }
    }
  }
  if (!moved.size) return;
  // Re-read: only replace links nobody changed meanwhile; keep the systems' order.
  useApp.setState((st) => ({
    systems: st.systems.map((s) => {
      const m = moved.get(s.id);
      if (!m || !s.manualCameras) return s;
      return {
        ...s,
        manualCameras: s.manualCameras.map((c) => {
          const mv = m.get(c.id);
          return mv && c.rtspUrl === mv.from ? { ...c, rtspUrl: mv.to } : c;
        }),
      };
    }),
  }));
}

/** Watches for newly added stream-link cameras and moves their passwords right away. */
export function watchStreamCredentials(): () => void {
  void migrateStreamCredentials().catch(() => {});
  return useApp.subscribe((st, prev) => {
    if (st.systems !== prev.systems) void migrateStreamCredentials().catch(() => {});
  });
}

/** The full stream link to open (with the camera's password put back). */
export async function streamUrlFor(systemId: string, cam: ManualCamera): Promise<string> {
  const original = await secrets.get(systemId, streamSecretName(cam.id, 'rtsp')).catch(() => null);
  return restoreUrlCredentials(cam.rtspUrl, original);
}

/** After a restore: snapshot links get their password back from the keychain. */
export async function restoreSnapshotCredentials(): Promise<void> {
  const fixes = new Map<string, string>();
  const systems: SystemConfig[] = useApp.getState().systems;
  for (const s of systems) {
    for (const c of s.manualCameras ?? []) {
      if (!c.snapshotUrl) continue;
      const original = await secrets.get(s.id, streamSecretName(c.id, 'snap')).catch(() => null);
      const full = restoreUrlCredentials(c.snapshotUrl, original);
      if (full !== c.snapshotUrl) fixes.set(`${s.id}\n${c.id}`, full);
    }
  }
  if (!fixes.size) return;
  useApp.setState((st) => ({
    systems: st.systems.map((s) =>
      s.manualCameras?.some((c) => fixes.has(`${s.id}\n${c.id}`))
        ? { ...s, manualCameras: s.manualCameras.map((c) => ({ ...c, snapshotUrl: fixes.get(`${s.id}\n${c.id}`) ?? c.snapshotUrl })) }
        : s,
    ),
  }));
}

import { File, Paths } from 'expo-file-system';

import type { CameraEntry } from '@/systems/registry';
import type { ReviewItem } from '@/systems/types';
import { AppGroup } from '@modules/app-group';

/**
 * Feeds the Home/Lock Screen widgets. Widgets can't use the in-app VPN, so the app saves
 * small snapshots into the shared App Group whenever it's running (foreground or background
 * check). Format must match targets/widget/Shared.swift.
 */
const MIN_INTERVAL_MS = 4 * 60_000;
const MAX_CAMERAS = 12;
let lastSync = 0;
let running = false;

const safe = (key: string) => key.replace(/[^A-Za-z0-9_-]/g, '_');

export async function syncWidgets(entries: CameraEntry[], opts: { force?: boolean } = {}) {
  if (!AppGroup || running || !entries.length) return;
  if (!opts.force && Date.now() - lastSync < MIN_INTERVAL_MS) return;
  running = true;
  lastSync = Date.now();
  try {
    const out: { key: string; name: string; image: string | null; updatedAt: number | null }[] = [];
    for (const { camera, adapter } of entries.slice(0, MAX_CAMERAS)) {
      const src = adapter.snapshot(camera.id, { height: 360 }).uri;
      let image: string | null = null;
      let updatedAt: number | null = null;
      if (src) {
        try {
          const tmp = new File(Paths.cache, `widget-${safe(camera.key)}.jpg`);
          if (tmp.exists) tmp.delete();
          const file = await File.downloadFileAsync(src.replace('latest.webp', 'latest.jpg'), tmp);
          image = `widget/img/${safe(camera.key)}.jpg`;
          await AppGroup.copyFile(file.uri, image);
          updatedAt = Math.floor(Date.now() / 1000);
        } catch {
          // Keep whatever the widget last had for this camera.
          image = `widget/img/${safe(camera.key)}.jpg`;
        }
      }
      out.push({ key: camera.key, name: camera.name, image, updatedAt });
    }
    await AppGroup.writeText('widget/cameras.json', JSON.stringify(out));
    AppGroup.reloadWidgets();
  } finally {
    running = false;
  }
}

/** Lock Screen "last alert" widget. */
export async function recordLastAlert(item: ReviewItem, title: string, cameraName: string) {
  if (!AppGroup) return;
  await AppGroup.writeText(
    'widget/last-alert.json',
    JSON.stringify({ title, camera: cameraName, key: `${item.systemId}:${item.cameraId}`, time: item.startTime }),
  ).catch(() => {});
  AppGroup.reloadWidgets();
}

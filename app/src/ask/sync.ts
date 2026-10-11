import { File, Paths } from 'expo-file-system';

import { ASSISTANT_FILE, ASSISTANT_HOURS, assistantSnapshot } from '@/ask/assistant-data';
import { buildIndex, isDoorCamera, type CameraInfo, type EventRecord } from '@/ask/engine';
import { useApp } from '@/state/store';
import type { CameraEntry } from '@/systems/registry';
import type { CameraSystemAdapter, ReviewItem } from '@/systems/types';
import { AppGroup } from '@modules/app-group';

/**
 * Leaves recent events (and one small picture per camera) in the App Group for the Siri /
 * HomePod intents in targets/intents. Runs whenever the app has events anyway: the Live tab,
 * the Ask screen and the background check. Throttled; never throws.
 */
const MIN_INTERVAL_MS = 4 * 60_000;
let lastSync = 0;
let running = false;

export function cameraInfos(entries: CameraEntry[]): CameraInfo[] {
  return entries.map(({ camera }) => ({ key: camera.key, name: camera.name, zones: camera.zones, door: isDoorCamera(camera) }));
}

/** Events from every system that keeps them (one failing system doesn't stop the rest). */
export async function fetchEvents(adapters: CameraSystemAdapter[], after: number, limit: number): Promise<{ items: ReviewItem[]; failed: string[] }> {
  const usable = adapters.filter((a, i) => a.capabilities.review && a.listReview && adapters.findIndex((b) => b.config.id === a.config.id) === i);
  const res = await Promise.allSettled(usable.map((a) => a.listReview!({ after, limit })));
  return {
    items: res.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])),
    failed: usable.filter((_, i) => res[i].status === 'rejected').map((a) => a.config.name),
  };
}

/** Fetches the last two days of events and writes them for Siri. */
export async function syncAssistant(entries: CameraEntry[], opts: { force?: boolean } = {}) {
  if (!AppGroup || running || !entries.length) return;
  if (!opts.force && Date.now() - lastSync < MIN_INTERVAL_MS) return;
  running = true;
  try {
    const now = Date.now() / 1000;
    const { items } = await fetchEvents(entries.map((e) => e.adapter), now - ASSISTANT_HOURS * 3600, 200);
    const cams = cameraInfos(entries);
    await writeAssistant(buildIndex(items, cams), cams);
  } catch {
    // Siri keeps the last summary.
  } finally {
    running = false;
  }
}

/** Writes an index the app already built (the Ask screen loads a week of events). */
export async function writeAssistant(index: EventRecord[], cameras: CameraInfo[]) {
  if (!AppGroup) return;
  lastSync = Date.now();
  const packages = Object.values(useApp.getState().packages ?? {});
  const { data, images } = assistantSnapshot(index, cameras, packages, Date.now() / 1000);
  const failed = new Set<string>();
  for (const job of images) {
    try {
      const tmp = new File(Paths.cache, `siri-${job.path.replace(/[^A-Za-z0-9_-]/g, '_')}`);
      if (tmp.exists) tmp.delete();
      const file = await File.downloadFileAsync(job.url, tmp);
      await AppGroup.copyFile(file.uri, job.path);
    } catch {
      failed.add(job.path);
    }
  }
  // A picture that didn't download would show an older event: leave it out.
  for (const e of data.events) if (e.image && failed.has(e.image)) e.image = null;
  for (const p of data.packages) if (p.image && failed.has(p.image)) p.image = null;
  await AppGroup.writeText(ASSISTANT_FILE, JSON.stringify(data));
}

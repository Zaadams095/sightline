import {
  demoCamera,
  demoCameras,
  demoEventAt,
  demoEvents,
  demoMotion,
  demoPlayback,
  demoRecordingDays,
  demoSearch,
  demoSegments,
  DEMO_GROUPS,
  DEMO_HEALTH,
  demoKnownNames,
  DEMO_PRESETS,
  demoPresetName,
  type DemoEvent,
  type DemoStill,
} from '@/systems/demo/data';
import { clipUri, stillUri } from '@/systems/demo/media';
import { demoPtzAction, demoPtzPreset } from '@/systems/demo/ptz';
import { tr } from '@/i18n';
import type {
  Camera,
  CameraSystemAdapter,
  HealthReport,
  LiveSource,
  MediaSource,
  MotionPoint,
  PlaybackSource,
  PtzAction,
  PtzInfo,
  RecordingSegment,
  ReviewItem,
  SearchHit,
  Severity,
  SystemCapabilities,
  SystemConfig,
} from '@/systems/types';

/** Reviewed and kept events, shared by every adapter instance (lost on restart, like a demo). */
const reviewed = new Set<string>();
const kept = new Set<string>();

const now = () => Date.now() / 1000;

/**
 * Demo mode's built-in "recorder": five sample cameras with bundled footage and a week of
 * made-up events, so every feature can be tried with no cameras and no network (App Review,
 * curious new users). Nothing here touches the network.
 */
export class DemoAdapter implements CameraSystemAdapter {
  readonly capabilities: SystemCapabilities = {
    live: true,
    // Tiles show the looping sample video instead of refreshing stills.
    snapshots: false,
    review: true,
    events: true,
    ptz: true,
    twoWayAudio: false,
    deter: false,
  };

  constructor(readonly config: SystemConfig) {}

  async connect() {}

  async listCameras(): Promise<Camera[]> {
    return demoCameras(this.config.id);
  }

  snapshot(cameraId: string): MediaSource {
    return { uri: demoCamera(cameraId) ? stillUri(`${cameraId}-live` as DemoStill) : '' };
  }

  async liveStream(cameraId: string): Promise<LiveSource> {
    const cam = demoCamera(cameraId);
    if (!cam) throw new Error(tr().systems.common.cameraNotFound);
    return {
      kind: 'loop',
      uri: clipUri(cameraId, 'live'),
      pan: cam.panAspect ? { key: `${this.config.id}:${cameraId}`, aspect: cam.panAspect } : undefined,
    };
  }

  private toItem = (e: DemoEvent): ReviewItem => {
    const { kind, ...item } = e;
    return {
      ...item,
      // Older sample events start out reviewed, so "Unreviewed" has a believable handful.
      reviewed: reviewed.has(e.id) || e.startTime < now() - 6 * 3600,
      thumbnailUrl: stillUri(kind.thumb),
    };
  };

  async listReview(q: { cameras?: string[]; after?: number; before?: number; severity?: Severity; limit?: number }): Promise<ReviewItem[]> {
    return demoEvents(now(), q, this.config.id).map(this.toItem);
  }

  async markReviewed(ids: string[]) {
    for (const id of ids) reviewed.add(id);
  }

  async recordingSegments(_cameraId: string, after: number, before: number): Promise<RecordingSegment[]> {
    return demoSegments(after, before, now());
  }

  async recordingDays(): Promise<string[]> {
    return demoRecordingDays(now());
  }

  async playback(cameraId: string, start: number): Promise<PlaybackSource> {
    const { clip, fileStart } = demoPlayback(cameraId, start, now());
    return { kind: 'stream', source: { kind: 'file', uri: clipUri(cameraId, clip), startTime: fileStart } };
  }

  async motionActivity(cameraId: string, after: number, before: number, scaleSec: number): Promise<MotionPoint[]> {
    return demoMotion(cameraId, after, before, scaleSec, now());
  }

  async detectionPoints(item: ReviewItem) {
    const ev = demoEvents(now(), { cameras: [item.cameraId], after: item.startTime - 1, before: item.startTime + 1 }).find((e) => e.id === item.id);
    return ev ? [ev.kind.at] : [];
  }

  previewClip(item: ReviewItem): MediaSource {
    const ev = demoEventAt(item.cameraId, item.startTime, now());
    return { uri: clipUri(item.cameraId, ev?.kind.clip ?? 'event') };
  }

  async search(q: { query: string; cameras?: string[]; limit?: number }): Promise<SearchHit[]> {
    return demoSearch(now(), q, stillUri, this.config.id);
  }

  async groups() {
    return DEMO_GROUPS;
  }

  async knownNames() {
    return demoKnownNames();
  }

  async health(): Promise<HealthReport> {
    return DEMO_HEALTH;
  }

  async retain(eventId: string, keep: boolean) {
    if (keep) kept.add(eventId);
    else kept.delete(eventId);
  }

  clip(cameraId: string, start: number): MediaSource {
    return { uri: clipUri(cameraId, demoPlayback(cameraId, start, now()).clip) };
  }

  async ptzInfo(cameraId: string): Promise<PtzInfo> {
    const cam = demoCamera(cameraId);
    return cam?.ptz ? { presets: Object.keys(DEMO_PRESETS).map(demoPresetName), canMove: true, canZoom: true } : { presets: [], canMove: false, canZoom: false };
  }

  async ptz(cameraId: string, action: PtzAction | `preset_${string}`) {
    const key = `${this.config.id}:${cameraId}`;
    if (action.startsWith('preset_')) {
      const name = action.slice('preset_'.length);
      const view = DEMO_PRESETS[Object.keys(DEMO_PRESETS).find((k) => demoPresetName(k) === name) ?? name];
      if (view) demoPtzPreset(key, view);
      return;
    }
    demoPtzAction(key, action as PtzAction);
  }

  dispose() {}
}

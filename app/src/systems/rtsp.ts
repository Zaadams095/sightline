import type {
  Camera,
  CameraSystemAdapter,
  LiveSource,
  MediaSource,
  SystemCapabilities,
  SystemConfig,
} from '@/systems/types';
import { WgTunnel } from '@modules/wg-tunnel';

/**
 * Cameras added by stream link. No recorder means no review, events or PTZ; live video is
 * restreamed in-app (systems/live.ts).
 */
export class RtspAdapter implements CameraSystemAdapter {
  readonly capabilities: SystemCapabilities = {
    live: !!WgTunnel,
    snapshots: true,
    review: false,
    events: false,
    ptz: false,
    twoWayAudio: false,
  };

  constructor(readonly config: SystemConfig) {}

  async connect() {}

  async listCameras(): Promise<Camera[]> {
    return (this.config.manualCameras ?? []).map((c) => ({
      key: `${this.config.id}:${c.id}`,
      systemId: this.config.id,
      id: c.id,
      name: c.name,
      enabled: true,
      zones: [],
      objects: [],
      ptz: false,
      aspect: 16 / 9,
    }));
  }

  snapshot(cameraId: string): MediaSource {
    const cam = this.config.manualCameras?.find((c) => c.id === cameraId);
    return { uri: cam?.snapshotUrl ?? '' };
  }

  async liveStream(cameraId: string): Promise<LiveSource> {
    const cam = this.config.manualCameras?.find((c) => c.id === cameraId);
    if (!cam) throw new Error('Camera not found');
    return { kind: 'rtsp', url: cam.rtspUrl };
  }

  dispose() {}
}

import type {
  Camera,
  CameraSystemAdapter,
  LiveSource,
  MediaSource,
  SystemCapabilities,
  SystemConfig,
  TalkTarget,
} from '@/systems/types';
import { streamUrlFor } from '@/systems/stream-credentials';
import { WgTunnel } from '@modules/wg-tunnel';
import { tr } from '@/i18n';

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
    // When the camera offers the ONVIF RTSP backchannel (the talk layer asks it first).
    twoWayAudio: true,
    deter: false,
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
    if (!cam) throw new Error(tr().systems.common.cameraNotFound);
    // Stored links have no password; the keychain copy puts it back (systems/stream-credentials.ts).
    return { kind: 'rtsp', url: await streamUrlFor(this.config.id, cam) };
  }

  async talkTarget(cameraId: string): Promise<TalkTarget | null> {
    const cam = this.config.manualCameras?.find((c) => c.id === cameraId);
    return cam && /^rtsps?:\/\//i.test(cam.rtspUrl) ? { kind: 'rtsp', url: await streamUrlFor(this.config.id, cam) } : null;
  }

  dispose() {}
}

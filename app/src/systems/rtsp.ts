import { ensureTunnel } from '@/net/connection';
import type {
  Camera,
  CameraSystemAdapter,
  MediaSource,
  SystemCapabilities,
  SystemConfig,
} from '@/systems/types';
import { WgTunnel } from '@modules/wg-tunnel';

/**
 * Cameras added by URL. No recorder means no review, events or PTZ.
 * Live view uses the RTSP→MSE restreamer in the native tunnel library: each camera gets a
 * loopback WebSocket that the same live player used for Frigate can play.
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

  private ports = new Map<string, number>();

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

  async liveStream(cameraId: string): Promise<MediaSource> {
    if (!WgTunnel) throw new Error('Live RTSP needs the full app build.');
    const cam = this.config.manualCameras?.find((c) => c.id === cameraId);
    if (!cam) throw new Error('Camera not found');

    const host = new URL(cam.rtspUrl.replace(/^rtsps?:/, 'http:'));
    const hostport = `${host.hostname}:${host.port || '554'}`;
    const direct = await WgTunnel.probe(hostport, false, 700);
    let viaTunnel = false;
    if (!direct) {
      if (!this.config.endpoint.useTunnel) throw new Error('Camera is not reachable from this network.');
      await ensureTunnel();
      viaTunnel = true;
    }

    let port = this.ports.get(cameraId);
    if (port == null) {
      port = await WgTunnel.addRTSPSource(cam.rtspUrl, viaTunnel);
      this.ports.set(cameraId, port);
    } else {
      WgTunnel.setRTSPViaTunnel(port, viaTunnel);
    }
    return { uri: `ws://127.0.0.1:${port}/api/ws` };
  }

  dispose() {
    for (const port of this.ports.values()) WgTunnel?.removeRTSPSource(port);
    this.ports.clear();
  }
}

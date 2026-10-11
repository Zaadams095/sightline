import { secrets, SECRET } from '@/state/secrets';
import { HttpSystem } from '@/systems/http-base';
import { loginError, parseLinks, type ScryptedLink } from '@/systems/scrypted-parse';
import type { Camera, CameraSystemAdapter, LiveSource, MediaSource, SystemCapabilities } from '@/systems/types';

/**
 * Scrypted, by camera link. Scrypted has no plain HTTP API for listing cameras (its own
 * clients and Home Assistant use an engine.io RPC), so setup asks for each camera's
 * "RTSP Rebroadcast Url" (camera → Rebroadcast extension → Streams). Those links are stable
 * and play like any RTSP camera (restreamed in-app). Recordings and events stay in Scrypted.
 *
 * The address is still used: `localhost` in pasted links becomes the server's address, and
 * when a username is given the sign-in is checked with `POST /login`.
 */
export class ScryptedAdapter extends HttpSystem implements CameraSystemAdapter {
  protected readonly label = 'Scrypted';
  readonly capabilities: SystemCapabilities = {
    live: true,
    snapshots: false,
    review: false,
    events: false,
    ptz: false,
    twoWayAudio: false,
  };

  private serverHost(): string {
    try {
      return new URL(this.config.endpoint.lanUrl).hostname;
    } catch {
      return '';
    }
  }

  private links(): ScryptedLink[] {
    return parseLinks(this.config.extra?.links ?? '', this.serverHost()).links;
  }

  async connect(): Promise<void> {
    const { links, bad } = parseLinks(this.config.extra?.links ?? '', this.serverHost());
    if (bad.length) {
      throw new Error(
        `“${bad[0].slice(0, 40)}” isn’t a camera link. Paste the links that start with rtsp:// (from each camera’s Rebroadcast settings in Scrypted).`,
      );
    }
    if (!links.length) {
      throw new Error('Paste at least one camera link. In Scrypted, open a camera → Rebroadcast → Streams and copy “RTSP Rebroadcast Url”.');
    }
    if (this.config.username) {
      const password = (await secrets.get(this.config.id, SECRET.password)) ?? '';
      const body = await this.json<{ error?: string; authorization?: string }>('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: this.config.username, password }),
      });
      const err = loginError(body);
      if (err) throw new Error(err);
    }
  }

  async listCameras(): Promise<Camera[]> {
    return this.links().map((l) => ({
      key: `${this.config.id}:${l.id}`,
      systemId: this.config.id,
      id: l.id,
      name: l.name,
      enabled: true,
      zones: [],
      objects: [],
      ptz: false,
      aspect: 16 / 9,
    }));
  }

  snapshot(): MediaSource {
    return { uri: '' };
  }

  async liveStream(cameraId: string): Promise<LiveSource> {
    const link = this.links().find((l) => l.id === cameraId);
    if (!link) throw new Error('This camera’s link was removed. Edit the Scrypted system to add it again.');
    return { kind: 'rtsp', url: link.url };
  }

  dispose() {}
}

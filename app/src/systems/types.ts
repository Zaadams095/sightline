/**
 * Brand-neutral contract every camera system implements (see docs/PLATFORM.md).
 * The UI checks `capabilities` and only renders features the system actually supports;
 * nothing outside an adapter should know which brand it is talking to.
 */

export type SystemKind =
  | 'hub'
  | 'frigate'
  | 'rtsp'
  | 'onvif'
  | 'reolink'
  | 'unifi-protect'
  | 'blue-iris'
  | 'hikvision'
  | 'dahua'
  | 'scrypted'
  | 'zoneminder'
  | 'shinobi'
  | 'agent-dvr';

export interface SystemCapabilities {
  live: boolean;
  snapshots: boolean;
  review: boolean;
  events: boolean;
  ptz: boolean;
  twoWayAudio: boolean;
}

/** How to reach a system. `lanUrl` is tried first; the tunnel is used when it's unreachable. */
export interface Endpoint {
  lanUrl: string;
  /** Optional URL used through the tunnel if it differs from lanUrl (rare). */
  tunnelUrl?: string;
  /** Whether this system needs the WireGuard tunnel when off the home network. */
  useTunnel: boolean;
  /** Skip TLS verification (most NVRs ship self-signed certificates). */
  allowSelfSigned?: boolean;
}

/** Persisted (non-secret) system definition. Secrets live in SecureStore keyed by id. */
export interface SystemConfig {
  id: string;
  kind: SystemKind;
  name: string;
  endpoint: Endpoint;
  username?: string;
  /** IP cameras added by address/stream URL (no recorder). */
  manualCameras?: ManualCamera[];
  /** Brand-specific extras from the setup form (e.g. channel count), as entered. */
  extra?: Record<string, string>;
}

export interface ManualCamera {
  id: string;
  name: string;
  rtspUrl: string;
  snapshotUrl?: string;
}

export interface Camera {
  /** Globally unique: `${systemId}:${cameraName}` */
  key: string;
  systemId: string;
  /** System-native camera identifier (camera name, channel number, UUID…). */
  id: string;
  name: string;
  enabled: boolean;
  zones: string[];
  objects: string[];
  ptz: boolean;
  /** Detection resolution, used to normalize object boxes for masks (when known). */
  detectSize?: { width: number; height: number };
  /** Aspect ratio width/height, used for layout before video arrives. */
  aspect: number;
}

export type Severity = 'alert' | 'detection';

export interface ReviewItem {
  id: string;
  systemId: string;
  cameraId: string;
  startTime: number; // unix seconds
  endTime: number | null; // null while in progress
  severity: Severity;
  objects: string[];
  /** Recognized identities (face names / known plates). Empty = nobody recognized. */
  subLabels: string[];
  zones: string[];
  reviewed: boolean;
  /** Underlying object-event IDs, where the system tracks them separately. */
  detections?: string[];
  /** Absolute or proxy-relative URL for a still image. */
  thumbnailUrl?: string;
}

export interface MotionPoint {
  t: number;
  v: number;
}

/** A result from smart (semantic) search: one tracked object. */
export interface SearchHit {
  eventId: string;
  systemId: string;
  cameraId: string;
  label: string;
  subLabel?: string;
  startTime: number;
  endTime: number | null;
  thumbnailUrl: string;
}

export interface HealthReport {
  /** Camera IDs that are enabled but receiving no frames. */
  offline: string[];
  storage: { path: string; usedPct: number; freeGb: number }[];
}

export interface RecordingSegment {
  start: number;
  end: number;
}

export type PtzAction =
  | 'MOVE_UP'
  | 'MOVE_DOWN'
  | 'MOVE_LEFT'
  | 'MOVE_RIGHT'
  | 'ZOOM_IN'
  | 'ZOOM_OUT'
  | 'STOP';

export interface PtzInfo {
  presets: string[];
  canZoom: boolean;
  canMove: boolean;
}

export interface MediaSource {
  uri: string;
  headers?: Record<string, string>;
}

/** How a camera's live video is delivered. 'rtsp' is restreamed in-app (see systems/live.ts). */
export type LiveSource =
  | { kind: 'mse'; wsUrl: string }
  | { kind: 'rtsp'; url: string }
  | { kind: 'hls'; uri: string }
  | { kind: 'mjpeg'; uri: string };

/**
 * Recorded video for a time window.
 * - vod: seekable HLS of the whole window (gaps removed; mapped with recordingSegments()).
 * - stream: plays forward from the window start; seeking asks for a new window. `startsAt` is
 *   the wall-clock time (unix s) of the source's first frame when it isn't the requested start
 *   (e.g. a whole recording file); the player seeks to `start - startsAt`.
 */
export type PlaybackSource =
  | { kind: 'vod'; uri: string }
  | { kind: 'stream'; source: LiveSource | { kind: 'file'; uri: string }; startsAt?: number };

export interface CameraSystemAdapter {
  readonly config: SystemConfig;
  readonly capabilities: SystemCapabilities;

  /** Validate credentials / reachability. Throws a user-readable Error on failure. */
  connect(): Promise<void>;
  listCameras(): Promise<Camera[]>;

  snapshot(cameraId: string, opts?: { height?: number }): MediaSource;
  liveStream(cameraId: string, opts?: { quality?: 'main' | 'sub' }): Promise<LiveSource>;

  listReview?(q: {
    cameras?: string[];
    after?: number;
    before?: number;
    severity?: Severity;
    limit?: number;
  }): Promise<ReviewItem[]>;
  markReviewed?(ids: string[]): Promise<void>;
  recordingSegments?(cameraId: string, after: number, before: number): Promise<RecordingSegment[]>;
  playback?(cameraId: string, start: number, end: number): Promise<PlaybackSource>;
  /** Motion intensity (0–100) bucketed by scaleSec. */
  motionActivity?(cameraId: string, after: number, before: number, scaleSec: number): Promise<MotionPoint[]>;
  /** Local dates (YYYY-MM-DD) that have recordings, newest first. */
  recordingDays?(cameraId: string): Promise<string[]>;
  /** Normalized foot positions (0–1) of the objects in a review item, for alert masks. */
  detectionPoints?(item: ReviewItem): Promise<{ x: number; y: number }[]>;
  /** Short preview video of a review item (for notification attachments). */
  previewClip?(item: ReviewItem): MediaSource;
  /** Smart search by description or visual similarity. Throws a readable error if unsupported. */
  search?(q: { query: string; type: 'description' | 'thumbnail'; cameras?: string[]; limit?: number }): Promise<SearchHit[]>;
  /** Camera groups defined on the recorder (camera IDs). */
  groups?(): Promise<{ name: string; cameraIds: string[] }[]>;
  /** Names the recorder can recognize (faces, known plates), for "unknown only" alerts. */
  knownNames?(): Promise<string[]>;
  health?(): Promise<HealthReport>;
  /** Keep (or stop keeping) an event forever so retention doesn't delete it. */
  retain?(eventId: string, keep: boolean): Promise<void>;
  /** Downloadable MP4 of a time range (for sharing / saving). */
  clip?(cameraId: string, start: number, end: number): MediaSource;

  ptzInfo?(cameraId: string): Promise<PtzInfo>;
  ptz?(cameraId: string, action: PtzAction | `preset_${string}`): Promise<void>;

  dispose(): void;
}

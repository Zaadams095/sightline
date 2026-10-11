import { requireOptionalNativeModule } from 'expo-modules-core';

export interface TunnelStatus {
  running: boolean;
  lastHandshake: number;
  rx: number;
  tx: number;
}

/** '' none · 'frigate' JWT login · 'basic' · 'http' auto Basic/Digest (most NVRs/cameras). */
export type AuthKind = '' | 'frigate' | 'basic' | 'http';

interface NativeWgTunnel {
  startTunnel(conf: string): Promise<void>;
  stopTunnel(): Promise<void>;
  tunnelStatus(): string;
  validateConfig(conf: string): string;
  probe(hostport: string, viaTunnel: boolean, timeoutMs: number): Promise<boolean>;
  /** '' when reachable, otherwise the dial error. */
  probeError(hostport: string, viaTunnel: boolean, timeoutMs: number): Promise<string>;
  /** 'HTTP <status>' or the error (self-signed certs allowed). */
  httpCheck(url: string, viaTunnel: boolean, timeoutMs: number): Promise<string>;
  /** JSON string[] of the phone's private /24 networks. */
  localSubnets(): string;
  /** JSON string[] of open "ip:port" in a /24. */
  scanSubnet(cidr: string, ports: string, timeoutMs: number): Promise<string>;
  /** JSON {status, server, auth, body, error} for brand fingerprinting. */
  httpProbe(url: string, timeoutMs: number): Promise<string>;
  addRoute(
    target: string,
    viaTunnel: boolean,
    insecureTLS: boolean,
    authKind: AuthKind,
    user: string,
    pass: string,
  ): Promise<number>;
  setRouteViaTunnel(port: number, viaTunnel: boolean): void;
  removeRoute(port: number): void;
  login(port: number): Promise<string>;
  addRTSPSource(url: string, viaTunnel: boolean): Promise<number>;
  setRTSPViaTunnel(port: number, viaTunnel: boolean): void;
  removeRTSPSource(port: number): void;
  /**
   * Two-way audio (builds from the talk release on; absent in older binaries, so optional).
   * addTalk returns a loopback port whose /api/talk WebSocket takes 16-bit mono PCM at 8 kHz.
   * kind: 'rtsp' (ONVIF backchannel), 'isapi' (Hikvision) or 'ws' (a Hub's talk WebSocket).
   */
  addTalk?(kind: string, url: string, viaTunnel: boolean): Promise<number>;
  removeTalk?(port: number): void;
  /** The camera speaker's codec (e.g. "PCMU/8000"), or '' when it can't take audio. */
  probeTalk?(kind: string, url: string, viaTunnel: boolean, timeoutMs: number): Promise<string>;
  /**
   * Evidence export (builds from the export release on; absent in older binaries, so optional).
   * startRecording records an RTSP stream (live or a recorder's replay) to an MP4 file path
   * (no file://) for up to maxSeconds; recordingStatus is JSON {bytes, seconds, done, error}.
   */
  startRecording?(url: string, viaTunnel: boolean, outPath: string, maxSeconds: number): Promise<number>;
  recordingStatus?(id: number): string;
  stopRecording?(id: number): Promise<void>;
  /** P-256 key (PKCS#8 base64) for signing export manifests; kept in the Keychain by the app. */
  newSigningKey?(): Promise<string>;
  signingPublicKey?(privateKey: string): Promise<string>;
  /** Signs a file (ECDSA P-256 / SHA-256, DER) into sigPath; returns the signature as base64. */
  signFile?(privateKey: string, path: string, sigPath: string): Promise<string>;
  sha256File?(path: string): Promise<string>;
  /** Stores every file under dir in a .zip, inside a top folder named rootName. */
  zipFolder?(dir: string, outPath: string, rootName: string): Promise<void>;
  setShared(name: string, value: string): void;
  removeShared(name: string): void;
}

/** null in Expo Go / web, where the native tunnel isn't available. */
export const WgTunnel = requireOptionalNativeModule<NativeWgTunnel>('WgTunnel');

export function parseStatus(json: string): TunnelStatus {
  try {
    return JSON.parse(json) as TunnelStatus;
  } catch {
    return { running: false, lastHandshake: 0, rx: 0, tx: 0 };
  }
}

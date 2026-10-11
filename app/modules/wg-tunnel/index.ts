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
  setShared(name: string, value: string): void;
  removeShared(name: string): void;
  /**
   * Phone-to-phone transfer. Missing on builds made before it existed (an OTA update can
   * reach them), so check with `typeof … === 'function'`.
   * JSON {port, hosts, error}: serves `payload` once at http://host:port/move/<token>.
   */
  transferServe?(token: string, payload: string, ttlSec: number): Promise<string>;
  /** JSON {active, served}. */
  transferStatus?(): string;
  transferStop?(): void;
  /** JSON {status, body, error}; plain http to private addresses only. */
  transferFetch?(url: string, timeoutMs: number): Promise<string>;
  /** PBKDF2-SHA256 → base64 32-byte key ('' on bad input). */
  deriveKey?(passcode: string, saltB64: string, iterations: number): Promise<string>;
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

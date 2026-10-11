import { requireOptionalNativeModule } from 'expo-modules-core';

export interface TunnelStatus {
  running: boolean;
  lastHandshake: number;
  rx: number;
  tx: number;
}

export type AuthKind = '' | 'frigate' | 'basic';

interface NativeWgTunnel {
  startTunnel(conf: string): Promise<void>;
  stopTunnel(): Promise<void>;
  tunnelStatus(): string;
  validateConfig(conf: string): string;
  probe(hostport: string, viaTunnel: boolean, timeoutMs: number): Promise<boolean>;
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

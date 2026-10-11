import { requireOptionalNativeModule } from 'expo';

export interface PairListenInfo {
  /** The TV's IPv4 address on the home network ('' without a network). */
  host: string;
  port: number;
  /** One-time key the phone must send back. */
  key: string;
}

interface Subscription {
  remove(): void;
}

interface NativeTvPairing {
  start(): Promise<PairListenInfo>;
  stop(): void;
  respond(id: string, status: number, json: string): void;
  qrPng(text: string): string;
  getSecret(name: string): string | null;
  setSecret(name: string, value: string): void;
  removeSecret(name: string): void;
  addListener(event: 'onPairRequest', listener: (e: { id: string; body: string }) => void): Subscription;
}

export const TvPairing = requireOptionalNativeModule<NativeTvPairing>('TvPairing');

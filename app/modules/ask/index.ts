import { requireOptionalNativeModule } from 'expo-modules-core';

/** "available", or why Apple Intelligence can't answer: os, device, disabled, notReady, language, unavailable. */
export type ModelAvailability = 'available' | 'os' | 'device' | 'disabled' | 'notReady' | 'language' | 'unavailable';

export interface SpeechEvent {
  text: string;
  final: boolean;
  /** '' when there's no error. */
  error: string;
}

interface Subscription {
  remove(): void;
}

interface NativeAsk {
  availability(): ModelAvailability;
  /** JSON search plan from the on-device model (see PlanContext in src/ask/engine.ts). */
  plan(question: string, contextJSON: string): Promise<string>;
  /** A short answer phrased from the facts only. */
  answer(question: string, facts: string): Promise<string>;
  speechAvailable(): boolean;
  startListening(): Promise<void>;
  stopListening(): void;
  addListener(event: 'onSpeech', listener: (e: SpeechEvent) => void): Subscription;
}

/** On-device Q&A and speech. null in Expo Go and on builds without it. */
export const Ask = requireOptionalNativeModule<NativeAsk>('Ask');

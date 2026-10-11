import { requireOptionalNativeModule } from 'expo-modules-core';

interface Subscription {
  remove(): void;
}

export interface RedactCounts {
  /** Faces covered (in a video: the most seen in one frame). */
  faces: number;
  plates: number;
}

interface NativeRedact {
  /** Blurs faces/plates in a photo (file:// URIs). */
  redactImage(input: string, output: string, faces: boolean, plates: boolean): Promise<RedactCounts>;
  /** Saves the frame at `seconds` of a video as a JPEG. */
  frameAt(input: string, seconds: number, output: string): Promise<void>;
  /** Blurs faces/plates in a video into a new MP4. Rejects with "Cancelled" after cancel(jobId). */
  redactVideo(jobId: string, input: string, output: string, faces: boolean, plates: boolean): Promise<RedactCounts>;
  cancel(jobId: string): void;
  addListener(event: 'onRedactProgress', listener: (e: { jobId: string; progress: number }) => void): Subscription;
}

/** On-device face and plate blurring (Vision). null in Expo Go and on builds without it. */
export const Redact = requireOptionalNativeModule<NativeRedact>('Redact');

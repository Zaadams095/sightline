import { requireOptionalNativeModule } from 'expo-modules-core';

/** Normalized 0–1 box, top-left origin. */
export interface VisionBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface VisionDetection {
  box: VisionBox;
  /** Face capture quality 0–1 (faces), or saliency confidence (vehicles). */
  quality: number;
  /** L2-normalized feature print, base64 Float32 (see src/familiar/match.ts). */
  print: string;
  /** Number of floats in `print` (changes with the Vision revision). */
  dim: number;
  /** Small JPEG of the crop (file:// URI) when a crop directory was given. */
  crop?: string;
  /** On-device text recognized in a vehicle crop (plate candidates). */
  texts?: string[];
}

export interface VisionResult {
  width: number;
  height: number;
  faces: VisionDetection[];
  vehicles: VisionDetection[];
  /** Faces found but skipped (too small, turned away, blurry). */
  skippedFaces: number;
}

export interface AnalyzeOptions {
  faces: boolean;
  vehicles: boolean;
  /** Read plates in vehicle crops (on-device text recognition). */
  plates?: boolean;
  /** file:// directory for crop JPEGs; omitted = no crops written. */
  cropDir?: string;
  maxFaces?: number;
  /** Smallest face side to use, in source pixels (default 40). */
  minFacePx?: number;
}

interface NativeVision {
  analyze(fileUri: string, options: AnalyzeOptions): Promise<VisionResult>;
}

/**
 * Apple Vision on this iPhone: face detection + feature prints, vehicle crops, plate text.
 * null in Expo Go and on builds without the module. Never sends anything anywhere.
 */
export const SightlineVision = requireOptionalNativeModule<NativeVision>('SightlineVision');

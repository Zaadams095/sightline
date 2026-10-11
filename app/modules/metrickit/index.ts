import { requireOptionalNativeModule } from 'expo-modules-core';

interface NativeMetricKitReports {
  /** Stored MetricKit diagnostic payloads (MXDiagnosticPayload JSON), newest first. */
  collect(limit: number): Promise<string[]>;
  clear(): Promise<void>;
}

/** Crash/hang reports iOS delivered to the app. null in Expo Go and on builds without it. */
export const MetricKitReports = requireOptionalNativeModule<NativeMetricKitReports>('MetricKitReports');

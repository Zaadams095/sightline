import type { QueryClient } from '@tanstack/react-query';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import * as Updates from 'expo-updates';
import { Linking, Platform } from 'react-native';

import { SUPPORT_EMAIL } from '@/config';
import { connectSystem, useLinks } from '@/net/connection';
import { useApp } from '@/state/store';
import { HubAdapter } from '@/systems/hub';
import { getAdapter } from '@/systems/registry';
import { MetricKitReports } from '@modules/metrickit';

import { formatReport, mailtoUrl, type HubDiagnostics, type Report, type ReportInput } from './core';
import { flushDiagnostics, privateNames, useDiagnostics } from './log';

/** Most recent iOS crash/hang payloads to attach. */
const METRICKIT_LIMIT = 5;

/** Camera names the app has seen this session (from the query cache), to scrub them too. */
function cachedCameraNames(qc?: QueryClient): string[] {
  if (!qc) return [];
  const out: string[] = [];
  try {
    for (const [, data] of qc.getQueriesData({})) {
      if (!Array.isArray(data)) continue;
      for (const x of data as unknown[]) {
        const c = x as { name?: unknown; id?: unknown };
        if (c && typeof c === 'object' && typeof c.name === 'string') {
          out.push(c.name);
          if (typeof c.id === 'string') out.push(c.id);
        }
      }
    }
  } catch {}
  return out;
}

async function hubDiagnostics(): Promise<(HubDiagnostics | string)[]> {
  const hubs = useApp.getState().systems.filter((s) => s.kind === 'hub' && s.extra?.role === 'owner');
  return Promise.all(
    hubs.map(async (s): Promise<HubDiagnostics | string> => {
      try {
        const link = useLinks.getState().links[s.id]?.baseUrl ? useLinks.getState().links[s.id] : await connectSystem(s);
        const adapter = getAdapter(s, link);
        if (!(adapter instanceof HubAdapter)) return 'not connected';
        const res = await adapter.request('GET', '/v1/diagnostics', undefined, 5000);
        return (await res.json()) as HubDiagnostics;
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        return /404|didn.t recognize/i.test(m) ? 'this Hub version doesn’t have diagnostics yet' : m;
      }
    }),
  );
}

export interface ReportOptions {
  note?: string;
  /** The error behind the "Something went wrong" screen. */
  error?: Error;
  /** Used to find camera names to scrub (optional; absent on the error screen). */
  queryClient?: QueryClient;
  /** Ask the Hub for its diagnostics (skipped on the error screen: keep it quick). */
  includeHub?: boolean;
}

/** Gathers everything (on the phone, plus the owner's Hub) and builds the report. Sends nothing. */
export async function buildReport(opts: ReportOptions = {}): Promise<Report> {
  return formatReport(await gatherReport(opts));
}

/** The report's inputs; format with formatReport({ ...input, note }) as the user types. */
export async function gatherReport(opts: ReportOptions = {}): Promise<ReportInput> {
  flushDiagnostics();
  const diag = useDiagnostics.getState();
  const include = diag.includeDiagnostics;
  const [metricKit, hubs] = include
    ? await Promise.all([
        MetricKitReports?.collect(METRICKIT_LIMIT).catch(() => [] as string[]) ?? Promise.resolve([] as string[]),
        opts.includeHub === false ? Promise.resolve([]) : hubDiagnostics().catch(() => []),
      ])
    : [[], []];
  const systems = useApp.getState().systems;
  return {
    generatedAt: Date.now(),
    app: {
      version: Constants.expoConfig?.version ?? '?',
      build: Platform.OS === 'android' ? String(Constants.expoConfig?.android?.versionCode ?? '') : Constants.expoConfig?.ios?.buildNumber,
      update: Updates.updateId ?? undefined,
      channel: Updates.channel ?? undefined,
    },
    device: { model: Device.modelId ?? Device.modelName ?? undefined, os: Device.osVersion ? `iOS ${Device.osVersion}` : undefined },
    note: opts.note,
    includeDiagnostics: include,
    brands: systems.map((s) => s.kind),
    events: diag.events,
    metricKit,
    hubs,
    error: opts.error ? { message: `${opts.error.name}: ${opts.error.message}`, stack: opts.error.stack } : undefined,
    names: privateNames(cachedCameraNames(opts.queryClient)),
  };
}

/** True when SUPPORT_EMAIL has been set to a real address. */
export const supportEmailSet = /^[^@\s<>]+@[^@\s<>]+\.[a-z]{2,}$/i.test(SUPPORT_EMAIL) && !/example\.(com|org)$/i.test(SUPPORT_EMAIL);

/** Opens Mail addressed to support with the readable report. Returns false if Mail can't open. */
export async function emailReport(report: Report): Promise<boolean> {
  try {
    await Linking.openURL(mailtoUrl(SUPPORT_EMAIL, report.subject, report.text));
    return true;
  } catch {
    return false;
  }
}

/** Opens the share sheet with the full report (including raw iOS crash data) as a text file. */
export async function shareReportFile(report: Report): Promise<void> {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const file = new File(Paths.cache, `sightline-report-${stamp}.txt`);
  if (file.exists) file.delete();
  file.create();
  file.write(`${report.file}\n\nSend to: ${SUPPORT_EMAIL}\n`);
  await Sharing.shareAsync(file.uri, { mimeType: 'text/plain', UTI: 'public.plain-text', dialogTitle: report.subject });
}

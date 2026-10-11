import Storage from 'expo-sqlite/kv-store';
import { create } from 'zustand';

import { useApp } from '@/state/store';

import { endpointName, errorCategory, parseEvents, pushEvent, scrubDetail, type DiagArea, type DiagEvent } from './core';

/**
 * Recent problems, kept on this phone only (never sent unless the user taps Send in
 * Settings → Report a problem). Each entry is brand + feature + error category; any free text
 * is scrubbed of addresses, credentials and names before it's stored.
 */

const EVENTS_KEY = 'sightline.diagnostics.events';
const PREFS_KEY = 'sightline.diagnostics.prefs';
const SAVE_DELAY_MS = 2000;

interface DiagPrefs {
  /** Attach recent problems, crash reports and Hub diagnostics when reporting a problem. */
  includeDiagnostics: boolean;
}

interface DiagState extends DiagPrefs {
  events: DiagEvent[];
  setIncludeDiagnostics(v: boolean): void;
  clear(): void;
}

function load<T>(key: string, parse: (s: string | null) => T): T {
  try {
    return parse(Storage.getItemSync(key));
  } catch {
    return parse(null);
  }
}

const loadPrefs = (s: string | null): DiagPrefs => {
  try {
    const p = s ? (JSON.parse(s) as Partial<DiagPrefs>) : {};
    return { includeDiagnostics: p.includeDiagnostics !== false };
  } catch {
    return { includeDiagnostics: true };
  }
};

export const useDiagnostics = create<DiagState>((set) => ({
  events: load(EVENTS_KEY, parseEvents),
  ...load(PREFS_KEY, loadPrefs),
  setIncludeDiagnostics: (v) => {
    set({ includeDiagnostics: v });
    try {
      Storage.setItemSync(PREFS_KEY, JSON.stringify({ includeDiagnostics: v }));
    } catch {}
  },
  clear: () => {
    set({ events: [] });
    saveNow();
  },
}));

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function saveNow() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  try {
    Storage.setItemSync(EVENTS_KEY, JSON.stringify(useDiagnostics.getState().events));
  } catch {}
}

function saveSoon() {
  saveTimer ??= setTimeout(saveNow, SAVE_DELAY_MS);
}

/**
 * Words that must never appear in diagnostics: system and camera names, usernames, host
 * names, group and clip titles. Scrubbing also removes addresses, emails and tokens by pattern.
 */
export function privateNames(extra: readonly string[] = []): string[] {
  const out = new Set<string>(extra);
  try {
    const s = useApp.getState();
    for (const sys of s.systems) {
      out.add(sys.name);
      if (sys.username) out.add(sys.username);
      for (const v of Object.values(sys.extra ?? {})) if (v && !/^\d+$/.test(v)) out.add(v);
      for (const url of [sys.endpoint.lanUrl, sys.extra?.remoteUrl]) {
        try {
          if (url) out.add(new URL(url.includes('://') ? url : `http://${url}`).hostname);
        } catch {}
      }
      for (const cam of sys.manualCameras ?? []) if (cam.name) out.add(cam.name);
    }
    for (const g of s.cameraGroups) out.add(g.name);
    for (const c of s.savedClips) {
      out.add(c.cameraName);
      out.add(c.title);
    }
    for (const key of [...s.phoneOrder, ...s.hidden, ...Object.keys(s.alerts.rules)]) {
      const id = key.split(/[:~]/).pop();
      if (id && !/^\d+$/.test(id)) out.add(id);
    }
  } catch {}
  return [...out].filter((n) => n && n.trim().length >= 3);
}

interface NoteOpts {
  brand?: string;
  feature?: string;
  /** Overrides the category worked out from the error text. */
  category?: string;
  /** Keep a scrubbed copy of the error text (JS errors). Off by default: categories only. */
  keepDetail?: boolean;
  /** Write to storage now (the app may be about to close). */
  flush?: boolean;
}

/** Records one problem. Never throws. */
export function noteProblem(area: DiagArea, error: unknown, opts: NoteOpts = {}): void {
  try {
    const raw = error instanceof Error ? error.message : String(error ?? '');
    const category = opts.category ?? errorCategory(raw);
    const status = /\b(?:HTTP|error|status)\s*(\d{3})\b/i.exec(raw)?.[1];
    const detail = opts.keepDetail ? scrubDetail(raw, privateNames()) : status ? `HTTP ${status}` : undefined;
    useDiagnostics.setState((s) => ({
      events: pushEvent(s.events, { t: Date.now(), area, category, brand: opts.brand, feature: opts.feature, detail }),
    }));
    if (opts.flush) saveNow();
    else saveSoon();
  } catch {}
}

/** Records a failed request to a camera system, by brand and API shape (never the full URL). */
export function noteRequestProblem(brand: string, pathOrUrl: string, error: unknown): void {
  noteProblem('adapter', error, { brand, feature: endpointName(pathOrUrl) });
}

let installed = false;

/**
 * Catches JavaScript errors that nothing else handled (React Native's global handler) and
 * unhandled promise rejections in release builds, records them, then lets React Native carry
 * on as before (a fatal error still closes the app, which iOS also logs as a crash).
 */
export function installCrashHandlers(): void {
  if (installed) return;
  installed = true;
  try {
    const previous = ErrorUtils.getGlobalHandler();
    ErrorUtils.setGlobalHandler((error: unknown, isFatal?: boolean) => {
      const e = error instanceof Error ? error : new Error(String(error));
      noteProblem('js', `${e.name}: ${e.message}${firstFrame(e)}`, {
        category: isFatal ? 'fatal' : 'error',
        keepDetail: true,
        flush: true,
      });
      previous(error, isFatal);
    });
  } catch {}
  if (!__DEV__) {
    try {
      const hermes = (globalThis as { HermesInternal?: { enablePromiseRejectionTracker?: (o: object) => void } }).HermesInternal;
      hermes?.enablePromiseRejectionTracker?.({
        allRejections: true,
        onUnhandled: (_id: number, rejection: unknown) => {
          const e = rejection instanceof Error ? rejection : new Error(String(rejection));
          noteProblem('js', `${e.name}: ${e.message}`, { category: 'unhandled-promise', keepDetail: true });
        },
        onHandled: () => {},
      });
    } catch {}
  }
}

/** " @ render (bundle:12:345)": where it happened, without file paths. */
function firstFrame(e: Error): string {
  const line = e.stack?.split('\n').find((l) => /\d+:\d+/.test(l));
  if (!line) return '';
  return ` @ ${line.trim().replace(/\(?(?:file|https?):\/\/\S*\/([^/\s]+:\d+:\d+)\)?/, '($1)').slice(0, 120)}`;
}

/** Saves pending events (e.g. right before building a report). */
export function flushDiagnostics(): void {
  saveNow();
}

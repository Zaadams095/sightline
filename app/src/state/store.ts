import Storage from 'expo-sqlite/kv-store';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import type { PackageState } from '@/alerts/packages';
import type { Severity, SystemConfig } from '@/systems/types';
import { DEFAULT_APPEARANCE, type Appearance } from '@/theme/tokens';

/** A tile on the iPad grid. Units are grid cells (GRID_COLUMNS wide). */
export interface GridTile {
  cameraKey: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GridView {
  id: string;
  name: string;
  tiles: GridTile[];
}

export const GRID_COLUMNS = 12;

/** A named set of cameras (Front Yard, Indoors…), shown as chips on the Live tab. */
export interface CameraGroup {
  id: string;
  name: string;
  cameraKeys: string[];
  /** Set when imported from a recorder (e.g. Frigate camera_groups). */
  source?: string;
}

export interface CameraAlertRule {
  enabled: boolean;
  /** Empty = any object. */
  objects: string[];
  /** Empty = anywhere in frame. */
  zones: string[];
  severities: Severity[];
}

export interface AlertSettings {
  mode: 'built-in' | 'instant';
  /** Keyed by camera key. Cameras without an entry use `defaultRule`. */
  rules: Record<string, CameraAlertRule>;
  defaultRule: CameraAlertRule;
  quietHours: { enabled: boolean; start: string; end: string };
  /** Minimum seconds between notifications for the same camera. */
  cooldownSec: number;
  /**
   * Recognized people/plates (Frigate sub-labels) that never trigger alerts. An event alerts
   * unless everyone recognized in it is on this list; unrecognized = always alerts.
   */
  quietFor: string[];
  /** Camera key -> unix seconds until which that camera is muted. */
  snoozed: Record<string, number>;
  health: { enabled: boolean; storagePct: number };
  /** Home/Away: while at home, only cameras in alertWhenHome notify. */
  presence: {
    enabled: boolean;
    atHome: boolean;
    alertWhenHome: string[];
    home?: { latitude: number; longitude: number; radius: number };
  };
  /** Instant Alerts bridge, if configured. */
  bridge?: { url: string; pairedAt: number };
  /** Doorbell rings open the full-screen "Someone's at the door" screen. */
  doorbell: { fullScreen: boolean };
  /** Doorbell rings and ongoing events show as a Live Activity (Lock Screen, Dynamic Island). */
  lockScreen: boolean;
  /** "Package delivered" / "picked up" alerts, and an optional evening reminder ("HH:MM"). */
  packages: { enabled: boolean; reminder: boolean; reminderTime: string };
}

/** Camera placement on the property map. x/y are 0–1 of the map; heading in degrees (0 = up). */
export interface MapPlacement {
  x: number;
  y: number;
  heading: number;
  fov: number;
}

/** Two cameras someone can walk between, and roughly how long that takes. */
export interface CameraLink {
  a: string;
  b: string;
  transitSec: number;
}

export interface CameraMap {
  /** Local file URI of a floor plan / satellite screenshot; blank grid when unset. */
  background?: string;
  /** width / height of the background. */
  aspect: number;
  placements: Record<string, MapPlacement>;
  links: CameraLink[];
}

/** Alert mask polygons per camera, normalized 0–1 points. Detections whose feet fall inside are ignored. */
export type AlertMasks = Record<string, { x: number; y: number }[][]>;

/** A bookmarked moment, optionally downloaded for offline viewing. */
export interface SavedClip {
  id: string;
  systemId: string;
  cameraId: string;
  cameraName: string;
  title: string;
  start: number;
  end: number;
  savedAt: number;
  /** Frigate events kept forever on the recorder because of this bookmark. */
  retainedEvents: string[];
  /** Local file when downloaded for offline viewing. */
  localUri?: string;
}

export interface SecuritySettings {
  lockEnabled: boolean;
  /** device = Face ID / Touch ID with the iPhone passcode as fallback; pin = an app-only PIN. */
  method: 'device' | 'pin';
  /** With method 'pin', allow Face ID to unlock too. */
  biometricsWithPin: boolean;
  /** Re-lock after this many seconds in the background (0 = immediately). */
  relockAfterSec: number;
  /** Hide notification previews' snapshots until unlocked. */
  hideAppSwitcherPreview: boolean;
}

interface AppState {
  onboarded: boolean;
  systems: SystemConfig[];
  appearance: Appearance;
  /** Phone stack: ordered camera keys; missing cameras are appended. */
  phoneOrder: string[];
  hidden: string[];
  gridViews: GridView[];
  activeGridViewId: string | null;
  cameraGroups: CameraGroup[];
  /** Selected group on the Live tab; null = all cameras. */
  activeGroupId: string | null;
  alerts: AlertSettings;
  security: SecuritySettings;
  cameraMap: CameraMap;
  masks: AlertMasks;
  savedClips: SavedClip[];
  /** Health issues already notified (issue key -> unix seconds), cleared when resolved. */
  healthAlerted: Record<string, number>;
  /** Newest review item start time already notified, per system. */
  lastNotified: Record<string, number>;
  /** Packages seen and not yet picked up, per camera key. */
  packages: PackageState;

  setOnboarded(v: boolean): void;
  upsertSystem(s: SystemConfig): void;
  removeSystem(id: string): void;
  setAppearance(p: Partial<Appearance>): void;
  setPhoneOrder(keys: string[]): void;
  toggleHidden(key: string): void;
  saveGridView(v: GridView): void;
  deleteGridView(id: string): void;
  setActiveGridView(id: string | null): void;
  saveGroup(g: CameraGroup): void;
  deleteGroup(id: string): void;
  moveGroup(id: string, dir: -1 | 1): void;
  setActiveGroup(id: string | null): void;
  setAlerts(p: Partial<AlertSettings>): void;
  setCameraRule(key: string, rule: CameraAlertRule | null): void;
  setLastNotified(systemId: string, t: number): void;
  setSecurity(p: Partial<SecuritySettings>): void;
  setCameraMap(p: Partial<CameraMap>): void;
  setMasks(cameraKey: string, polygons: { x: number; y: number }[][]): void;
  snooze(cameraKey: string, until: number | null): void;
  saveClip(c: SavedClip): void;
  removeClip(id: string): void;
  setHealthAlerted(v: Record<string, number>): void;
  setPackages(v: PackageState): void;
}

export const useApp = create<AppState>()(
  persist(
    (set) => ({
      onboarded: false,
      systems: [],
      appearance: DEFAULT_APPEARANCE,
      phoneOrder: [],
      hidden: [],
      gridViews: [],
      activeGridViewId: null,
      cameraGroups: [],
      activeGroupId: null,
      alerts: {
        mode: 'built-in',
        rules: {},
        defaultRule: { enabled: true, objects: ['person'], zones: [], severities: ['alert'] },
        quietHours: { enabled: false, start: '23:00', end: '06:30' },
        cooldownSec: 60,
        quietFor: [],
        snoozed: {},
        health: { enabled: true, storagePct: 90 },
        presence: { enabled: false, atHome: false, alertWhenHome: [] },
        doorbell: { fullScreen: true },
        lockScreen: true,
        packages: { enabled: true, reminder: false, reminderTime: '19:00' },
      },
      savedClips: [],
      healthAlerted: {},
      lastNotified: {},
      packages: {},
      cameraMap: { aspect: 4 / 3, placements: {}, links: [] },
      masks: {},
      security: { lockEnabled: false, method: 'device', biometricsWithPin: true, relockAfterSec: 60, hideAppSwitcherPreview: true },

      setOnboarded: (onboarded) => set({ onboarded }),
      upsertSystem: (s) =>
        set((st) => ({ systems: [...st.systems.filter((x) => x.id !== s.id), s] })),
      removeSystem: (id) => set((st) => ({ systems: st.systems.filter((x) => x.id !== id) })),
      setAppearance: (p) => set((st) => ({ appearance: { ...st.appearance, ...p } })),
      setPhoneOrder: (phoneOrder) => set({ phoneOrder }),
      toggleHidden: (key) =>
        set((st) => ({
          hidden: st.hidden.includes(key) ? st.hidden.filter((k) => k !== key) : [...st.hidden, key],
        })),
      saveGridView: (v) =>
        set((st) => ({ gridViews: [...st.gridViews.filter((x) => x.id !== v.id), v] })),
      deleteGridView: (id) =>
        set((st) => ({
          gridViews: st.gridViews.filter((x) => x.id !== id),
          activeGridViewId: st.activeGridViewId === id ? null : st.activeGridViewId,
        })),
      setActiveGridView: (activeGridViewId) => set({ activeGridViewId }),
      saveGroup: (g) =>
        set((st) => {
          const i = st.cameraGroups.findIndex((x) => x.id === g.id);
          const cameraGroups = [...st.cameraGroups];
          if (i >= 0) cameraGroups[i] = g;
          else cameraGroups.push(g);
          return { cameraGroups };
        }),
      deleteGroup: (id) =>
        set((st) => ({
          cameraGroups: st.cameraGroups.filter((g) => g.id !== id),
          activeGroupId: st.activeGroupId === id ? null : st.activeGroupId,
        })),
      moveGroup: (id, dir) =>
        set((st) => {
          const i = st.cameraGroups.findIndex((g) => g.id === id);
          const j = i + dir;
          if (i < 0 || j < 0 || j >= st.cameraGroups.length) return {};
          const cameraGroups = [...st.cameraGroups];
          [cameraGroups[i], cameraGroups[j]] = [cameraGroups[j], cameraGroups[i]];
          return { cameraGroups };
        }),
      setActiveGroup: (activeGroupId) => set({ activeGroupId }),
      setAlerts: (p) => set((st) => ({ alerts: { ...st.alerts, ...p } })),
      setCameraRule: (key, rule) =>
        set((st) => {
          const rules = { ...st.alerts.rules };
          if (rule) rules[key] = rule;
          else delete rules[key];
          return { alerts: { ...st.alerts, rules } };
        }),
      snooze: (key, until) =>
        set((st) => {
          const snoozed = { ...st.alerts.snoozed };
          if (until) snoozed[key] = until;
          else delete snoozed[key];
          return { alerts: { ...st.alerts, snoozed } };
        }),
      saveClip: (c) => set((st) => ({ savedClips: [c, ...st.savedClips.filter((x) => x.id !== c.id)] })),
      removeClip: (id) => set((st) => ({ savedClips: st.savedClips.filter((x) => x.id !== id) })),
      setHealthAlerted: (healthAlerted) => set({ healthAlerted }),
      setPackages: (packages) => set({ packages }),
      setCameraMap: (p) => set((st) => ({ cameraMap: { ...st.cameraMap, ...p } })),
      setMasks: (key, polygons) =>
        set((st) => {
          const masks = { ...st.masks };
          if (polygons.length) masks[key] = polygons;
          else delete masks[key];
          return { masks };
        }),
      setSecurity: (p) => set((st) => ({ security: { ...st.security, ...p } })),
      setLastNotified: (systemId, t) =>
        set((st) => ({ lastNotified: { ...st.lastNotified, [systemId]: t } })),
    }),
    {
      name: 'app-state',
      version: 1,
      storage: createJSONStorage(() => Storage),
      // Settings saved by older app versions lack newer fields: fill them from defaults
      // one level deep so updates never load half-empty settings objects.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<AppState>;
        return {
          ...current,
          ...p,
          alerts: { ...current.alerts, ...p.alerts },
          appearance: { ...current.appearance, ...p.appearance },
          security: { ...current.security, ...p.security },
          cameraMap: { ...current.cameraMap, ...p.cameraMap },
        };
      },
    },
  ),
);

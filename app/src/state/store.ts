import Storage from 'expo-sqlite/kv-store';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

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
  /** Instant Alerts bridge, if configured. */
  bridge?: { url: string; pairedAt: number };
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
  alerts: AlertSettings;
  security: SecuritySettings;
  cameraMap: CameraMap;
  masks: AlertMasks;
  /** Newest review item start time already notified, per system. */
  lastNotified: Record<string, number>;

  setOnboarded(v: boolean): void;
  upsertSystem(s: SystemConfig): void;
  removeSystem(id: string): void;
  setAppearance(p: Partial<Appearance>): void;
  setPhoneOrder(keys: string[]): void;
  toggleHidden(key: string): void;
  saveGridView(v: GridView): void;
  deleteGridView(id: string): void;
  setActiveGridView(id: string | null): void;
  setAlerts(p: Partial<AlertSettings>): void;
  setCameraRule(key: string, rule: CameraAlertRule | null): void;
  setLastNotified(systemId: string, t: number): void;
  setSecurity(p: Partial<SecuritySettings>): void;
  setCameraMap(p: Partial<CameraMap>): void;
  setMasks(cameraKey: string, polygons: { x: number; y: number }[][]): void;
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
      alerts: {
        mode: 'built-in',
        rules: {},
        defaultRule: { enabled: true, objects: ['person'], zones: [], severities: ['alert'] },
        quietHours: { enabled: false, start: '23:00', end: '06:30' },
        cooldownSec: 60,
      },
      lastNotified: {},
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
      setAlerts: (p) => set((st) => ({ alerts: { ...st.alerts, ...p } })),
      setCameraRule: (key, rule) =>
        set((st) => {
          const rules = { ...st.alerts.rules };
          if (rule) rules[key] = rule;
          else delete rules[key];
          return { alerts: { ...st.alerts, rules } };
        }),
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
    },
  ),
);

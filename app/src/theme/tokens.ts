import type { LanguagePref } from '../i18n/locales.ts';

export type ThemeMode = 'system' | 'light' | 'dark' | 'oled';

export interface Palette {
  bg: string;
  surface: string;
  surfaceRaised: string;
  border: string;
  text: string;
  textMuted: string;
  accent: string;
  accentText: string;
  danger: string;
  warning: string;
  success: string;
  /** Translucent backdrop for labels drawn over video. */
  scrim: string;
}

export const ACCENTS = {
  violet: '#7C5CFF',
  blue: '#3B82F6',
  teal: '#14B8A6',
  green: '#22C55E',
  amber: '#F59E0B',
  coral: '#FF6B5B',
  pink: '#EC4899',
  graphite: '#8E95A3',
} as const;
export type AccentName = keyof typeof ACCENTS;

const base = {
  danger: '#FF453A',
  warning: '#FFB020',
  success: '#30D158',
  scrim: 'rgba(0,0,0,0.45)',
};

export function buildPalette(mode: Exclude<ThemeMode, 'system'>, accent: string): Palette {
  switch (mode) {
    case 'light':
      return {
        ...base,
        bg: '#F4F5F8',
        surface: '#FFFFFF',
        surfaceRaised: '#FFFFFF',
        border: 'rgba(15,20,30,0.08)',
        text: '#0E1116',
        textMuted: '#5E6673',
        accent,
        accentText: '#FFFFFF',
      };
    case 'oled':
      return {
        ...base,
        bg: '#000000',
        surface: '#0A0A0B',
        surfaceRaised: '#141416',
        border: 'rgba(255,255,255,0.07)',
        text: '#F5F6F8',
        textMuted: '#8B919C',
        accent,
        accentText: '#FFFFFF',
      };
    case 'dark':
    default:
      return {
        ...base,
        bg: '#0B0D12',
        surface: '#13161D',
        surfaceRaised: '#1B1F28',
        border: 'rgba(255,255,255,0.08)',
        text: '#F2F4F7',
        textMuted: '#9AA1AD',
        accent,
        accentText: '#FFFFFF',
      };
  }
}

export type Density = 'compact' | 'comfortable';
export type LabelStyle = 'overlay' | 'below' | 'hidden';

export interface Appearance {
  mode: ThemeMode;
  accent: AccentName;
  /** Tile corner radius in points (0–24). */
  radius: number;
  density: Density;
  labelStyle: LabelStyle;
  /** Phone camera stack: 1 or 2 columns. */
  phoneColumns: 1 | 2;
  showTimestamps: boolean;
  /** App language: 'auto' follows the iPhone. */
  language: LanguagePref;
  /** In-app "Bigger text", on top of the iPhone's own text size (for people who don't know that setting). */
  biggerText: boolean;
}

export const DEFAULT_APPEARANCE: Appearance = {
  mode: 'system',
  accent: 'violet',
  radius: 14,
  density: 'comfortable',
  labelStyle: 'overlay',
  phoneColumns: 1,
  showTimestamps: true,
  language: 'auto',
  biggerText: false,
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const font = {
  title: { fontSize: 28, fontWeight: '700' as const, letterSpacing: -0.5 },
  heading: { fontSize: 20, fontWeight: '600' as const, letterSpacing: -0.3 },
  body: { fontSize: 16, fontWeight: '400' as const },
  label: { fontSize: 13, fontWeight: '600' as const, letterSpacing: 0.1 },
  caption: { fontSize: 12, fontWeight: '500' as const },
};

/**
 * Largest text size each style may reach, as a multiple of its normal size (iPhone text
 * size × in-app "Bigger text" combined). Body text goes all the way up (the biggest
 * accessibility size is ~3.1×); titles and small labels stop earlier so they don't swamp
 * the screen. Text drawn over video uses OVERLAY_MAX_SCALE.
 */
export const MAX_SCALE = { title: 2, heading: 2.4, body: 3.2, label: 2.6, caption: 2.4 } as const;
export const OVERLAY_MAX_SCALE = 1.3;
/** What "Bigger text" multiplies the iPhone's text size by. */
export const BIGGER_TEXT = 1.25;

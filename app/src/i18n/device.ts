import { getLocales } from 'expo-localization';

import { useApp } from '@/state/store';

import { isLocale, matchLocale, setLocale } from './index.ts';

/**
 * Picks the app's language: the choice in Settings → Appearance, else the iPhone's language
 * (including the per-app language in iOS Settings), else English. Importing this module
 * applies it right away and keeps it in sync — so background alert tasks speak the same
 * language as the screens.
 */
function apply(): void {
  let device: { languageTag: string }[] = [];
  try {
    device = getLocales();
  } catch {
    // Not available (tests, web without Intl): English.
  }
  const pref = useApp.getState().appearance.language;
  const locale = isLocale(pref) ? pref : (matchLocale(device.map((l) => l.languageTag)) ?? 'en');
  // Dates keep the person's region (24-hour clock in "en-GB") when it speaks the active language.
  const regional = device.find((l) => matchLocale([l.languageTag]) === locale)?.languageTag;
  setLocale(locale, regional);
}

let started = false;

export function startLocaleSync(): void {
  if (started) return;
  started = true;
  apply();
  useApp.persist.onFinishHydration(apply);
  useApp.subscribe((s, prev) => {
    if (s.appearance.language !== prev.appearance.language) apply();
  });
}

startLocaleSync();

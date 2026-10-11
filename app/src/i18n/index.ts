/**
 * Sightline's translations: a tiny typed layer instead of a library.
 *
 * Every language is a plain object shaped exactly like English (`Strings`), so tsc flags a
 * missing or extra key, and a message with values is a function whose parameters are typed
 * (`t.alerts.motion({ camera })`), so a wrong placeholder can't compile. Plurals go through
 * Intl.PluralRules (with a built-in fallback when Hermes lacks it). No parsing at runtime,
 * nothing to download, no dependency.
 *
 * Pure (no React Native imports) so alert logic and tests can use it: relative imports only.
 * React components use `useT()` from './use-t'; other code calls `tr()` at the moment it
 * needs text — never at module load, or the text would be frozen in the launch language.
 */
import de from './de.ts';
import { en, type Strings } from './en.ts';
import es from './es.ts';
import fr from './fr.ts';
import { LOCALES, type Locale } from './locales.ts';
import pt from './pt.ts';

export type { Strings } from './en.ts';
export { LOCALE_NAMES, LOCALES, isLocale, matchLocale, type LanguagePref, type Locale } from './locales.ts';
export { plural, type PluralForms } from './plural.ts';

const DICTS: Record<Locale, Strings> = { en, es, fr, de, 'pt-BR': pt };

let current: Locale = 'en';
/** BCP-47 tag for dates and numbers: the device's own tag ("de-AT") when it speaks the active language. */
let formatTag: string = 'en';
const listeners = new Set<() => void>();

/** Switch language. `regionTag` is the device's full tag when its language is the active one. */
export function setLocale(locale: Locale, regionTag?: string): void {
  const tag = regionTag && regionTag.toLowerCase().startsWith(locale.split('-')[0]) ? regionTag : locale;
  if (locale === current && tag === formatTag) return;
  current = locale;
  formatTag = tag;
  for (const fn of listeners) fn();
}

export function getLocale(): Locale {
  return current;
}

/** The tag to hand to Intl / toLocale*String. */
export function formatLocale(): string {
  return formatTag;
}

/** The current language's strings. Call at the moment you need text (not at module load). */
export function tr(): Strings {
  return DICTS[current];
}

/** A specific language's strings (tests, and text built for someone else's language). */
export function stringsFor(locale: Locale): Strings {
  return DICTS[locale];
}

export function subscribeLocale(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const ALL_STRINGS: readonly [Locale, Strings][] = LOCALES.map((l) => [l, DICTS[l]]);

// ---- Dates, times and numbers in the active language ----

function safe<T>(fn: () => T, fallback: () => T): T {
  try {
    return fn();
  } catch {
    return fallback();
  }
}

/** "9:41 PM" / "21:41". */
export function fmtTime(d: Date, withSeconds = false): string {
  const opts: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit', ...(withSeconds ? { second: '2-digit' } : {}) };
  return safe(
    () => d.toLocaleTimeString(formatTag, opts),
    () => d.toLocaleTimeString([], opts),
  );
}

/** Any date pattern, e.g. fmtDate(d, { weekday: 'long', month: 'short', day: 'numeric' }). */
export function fmtDate(d: Date, opts: Intl.DateTimeFormatOptions): string {
  return safe(
    () => d.toLocaleDateString(formatTag, opts),
    () => d.toLocaleDateString([], opts),
  );
}

/** 1234.5 → "1,234.5" / "1.234,5". */
export function fmtNumber(n: number, opts?: Intl.NumberFormatOptions): string {
  return safe(
    () => n.toLocaleString(formatTag, opts),
    () => String(n),
  );
}

/** "Mia, Leo and Sam" / "Mia, Leo y Sam" — joins names with the language's "and". */
export function fmtList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  const and = tr().common.and;
  return `${items.slice(0, -1).join(', ')} ${and} ${items[items.length - 1]}`;
}

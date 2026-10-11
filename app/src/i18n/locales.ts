/** The languages Sightline ships in. 'pt-BR' is Brazilian Portuguese. */
export const LOCALES = ['en', 'es', 'fr', 'de', 'pt-BR'] as const;
export type Locale = (typeof LOCALES)[number];

/** What the user picked in Settings → Appearance; 'auto' follows the iPhone's language. */
export type LanguagePref = 'auto' | Locale;

/** Each language named in itself, so people can find their own even when the app is in another. */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: 'English',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
  'pt-BR': 'Português',
};

/** The first supported language among the device's preferred ones ("es-MX" → es, "pt-PT" → pt-BR). */
export function matchLocale(tags: readonly (string | null | undefined)[]): Locale | null {
  for (const tag of tags) {
    const lang = (tag ?? '').toLowerCase().split(/[-_]/)[0];
    if (lang === 'pt') return 'pt-BR';
    const hit = LOCALES.find((l) => l === lang);
    if (hit) return hit;
  }
  return null;
}

export function isLocale(v: unknown): v is Locale {
  return typeof v === 'string' && (LOCALES as readonly string[]).includes(v);
}

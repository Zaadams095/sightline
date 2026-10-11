import type { Locale } from './locales.ts';

/**
 * Plural forms for one message. `zero` is an exact-0 override ("No cameras"), not the CLDR
 * category; the rest follow CLDR (English, German and Spanish use one/other; French and
 * Brazilian Portuguese count 0 as "one").
 */
export interface PluralForms {
  zero?: string;
  one?: string;
  few?: string;
  many?: string;
  other: string;
}

type Category = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';

/** Hermes may lack Intl.PluralRules; these match CLDR for whole numbers in our five languages. */
export function fallbackCategory(locale: Locale, n: number): 'one' | 'other' {
  const i = Math.floor(Math.abs(n));
  if (locale === 'fr' || locale === 'pt-BR') return i === 0 || i === 1 ? 'one' : 'other';
  return n === 1 ? 'one' : 'other';
}

function rulesFor(locale: Locale): (n: number) => Category {
  try {
    if (typeof Intl !== 'undefined' && typeof Intl.PluralRules === 'function') {
      const r = new Intl.PluralRules(locale);
      return (n) => r.select(n) as Category;
    }
  } catch {
    // Fall through to the built-in rules.
  }
  return (n) => fallbackCategory(locale, n);
}

/** `const p = plural('fr');` then `p(n, { one: `${n} caméra`, other: `${n} caméras` })`. */
export function plural(locale: Locale): (n: number, forms: PluralForms) => string {
  let select: ((n: number) => Category) | null = null;
  return (n, forms) => {
    if (n === 0 && forms.zero !== undefined) return forms.zero;
    select ??= rulesFor(locale);
    const cat = select(n);
    return (cat === 'one' || cat === 'few' || cat === 'many' ? forms[cat] : undefined) ?? forms.other;
  };
}

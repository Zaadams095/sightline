import { useSyncExternalStore } from 'react';

import { getLocale, subscribeLocale, tr, type Locale, type Strings } from './index.ts';

/** The current language's strings; the component re-renders when the language changes. */
export function useT(): Strings {
  return useSyncExternalStore(subscribeLocale, tr);
}

export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, getLocale);
}

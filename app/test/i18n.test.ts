import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ALL_STRINGS, fmtDate, fmtNumber, fmtTime, setLocale, stringsFor, tr, type Locale } from '../src/i18n/index.ts';
import { matchLocale } from '../src/i18n/locales.ts';
import { fallbackCategory, plural } from '../src/i18n/plural.ts';
import { formatRelative, labelFor, titleFor } from '../src/util/format.ts';

type Tree = { [k: string]: unknown };
const en = stringsFor('en') as unknown as Tree;
const others = ALL_STRINGS.filter(([l]) => l !== 'en') as unknown as [Locale, Tree][];

/** Every leaf as [path, value]. */
function leaves(node: unknown, path = ''): [string, unknown][] {
  if (node && typeof node === 'object') {
    return Object.entries(node as Tree).flatMap(([k, v]) => leaves(v, path ? `${path}.${k}` : k));
  }
  return [[path, node]];
}

const enLeaves = new Map(leaves(en));

test('every language has exactly the English keys, with the same kind of value', () => {
  for (const [locale, dict] of others) {
    const theirs = new Map(leaves(dict));
    const missing = [...enLeaves.keys()].filter((k) => !theirs.has(k));
    const extra = [...theirs.keys()].filter((k) => !enLeaves.has(k));
    assert.deepEqual(missing, [], `${locale} is missing keys`);
    assert.deepEqual(extra, [], `${locale} has keys English doesn't`);
    for (const [k, v] of enLeaves) {
      assert.equal(typeof theirs.get(k), typeof v, `${locale}: ${k} should be a ${typeof v}`);
    }
  }
});

test('no empty strings anywhere', () => {
  for (const [locale, dict] of ALL_STRINGS) {
    for (const [k, v] of leaves(dict)) {
      if (typeof v === 'string') assert.ok(v.trim().length > 0, `${locale}: ${k} is empty`);
    }
  }
});

// ---- Placeholders: call each message with recognizable values and compare which ones come out ----

/** Sentinel numbers: below 1000 (no digit grouping), never 0 or 1 (no special plural text). */
const SENTINELS = [731, 742, 753, 764, 775, 786, 797];

/** Arguments for a message: plain sentinels, or an object whose every field is a sentinel. */
function argsFor(fn: (...a: unknown[]) => unknown, asStrings: boolean): unknown[] {
  const val = (i: number) => (asStrings ? `«${SENTINELS[i]}»` : SENTINELS[i]);
  const n = Math.max(fn.length, 1);
  return Array.from({ length: n }, (_, i) => val(i));
}

function objectArg(asStrings: boolean): unknown {
  const keys = new Map<string, number>();
  return new Proxy(
    {},
    {
      get(_t, key) {
        if (typeof key !== 'string') return undefined;
        if (!keys.has(key)) keys.set(key, keys.size);
        const i = 100 + [...key].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 800, 7);
        return asStrings ? `«${i}»` : i;
      },
    },
  );
}

/** Runs a message with sentinel inputs; returns the sentinels found in its output, or null if it can't be driven. */
function sentinelsIn(fn: unknown): Set<string> | null {
  const f = fn as (...a: unknown[]) => unknown;
  const attempts: (() => unknown)[] = [
    () => f(...argsFor(f, false)),
    () => f(...argsFor(f, true)),
    () => f(objectArg(false)),
    () => f(objectArg(true)),
  ];
  for (const run of attempts) {
    try {
      const out = run();
      if (typeof out !== 'string') continue;
      if (/undefined|NaN|\[object /.test(out)) continue;
      return new Set(out.match(/\d{3}/g) ?? []);
    } catch {
      // Try the next shape of arguments.
    }
  }
  return null;
}

test('messages with values use the same values in every language', () => {
  const problems: string[] = [];
  for (const [k, v] of enLeaves) {
    if (typeof v !== 'function') continue;
    const want = sentinelsIn(v);
    if (!want) continue; // takes something richer than strings/numbers (checked by tsc)
    for (const [locale, dict] of others) {
      const theirFn = new Map(leaves(dict)).get(k);
      const got = sentinelsIn(theirFn);
      if (!got) {
        problems.push(`${locale}: ${k} could not be called like English`);
        continue;
      }
      const a = [...want].sort().join(',');
      const b = [...got].sort().join(',');
      if (a !== b) problems.push(`${locale}: ${k} uses {${b}} but English uses {${a}}`);
    }
  }
  assert.deepEqual(problems, []);
});

test('plural messages work for 0, 1, 2 and 5 in every language', () => {
  // A plural message: English text for 1 and for 5 differ by more than the digit ("1 clip" / "5 clips").
  const numeric = [...enLeaves].filter(([, v]) => {
    if (typeof v !== 'function' || v.length !== 1) return false;
    try {
      const f = v as (n: number) => unknown;
      const one = f(1);
      const five = f(5);
      return typeof one === 'string' && typeof five === 'string' && one.replace(/1/g, '#') !== five.replace(/5/g, '#');
    } catch {
      return false;
    }
  });
  assert.ok(numeric.length > 20, `only ${numeric.length} plural messages found`);
  for (const [locale, dict] of ALL_STRINGS) {
    const theirs = new Map(leaves(dict));
    for (const [k] of numeric) {
      const fn = theirs.get(k) as (n: number) => unknown;
      for (const n of [0, 1, 2, 5]) {
        const out = fn(n);
        assert.equal(typeof out, 'string', `${locale}: ${k}(${n})`);
        assert.doesNotMatch(out as string, /undefined|NaN|\[object /, `${locale}: ${k}(${n})`);
      }
    }
  }
});

test('translations are actually translated (not English pasted in)', () => {
  const strings = [...enLeaves].filter(([, v]) => typeof v === 'string' && (v as string).length > 12);
  for (const [locale, dict] of others) {
    const theirs = new Map(leaves(dict));
    const same = strings.filter(([k, v]) => theirs.get(k) === v).map(([k]) => k);
    // A few long strings legitimately match (brand names, URLs, code-like hints).
    assert.ok(same.length <= Math.max(8, strings.length * 0.05), `${locale}: ${same.length} strings identical to English, e.g. ${same.slice(0, 8).join(', ')}`);
  }
});

// ---- Plurals, language matching, formatting ----

test('plural categories follow each language', () => {
  const en1 = plural('en');
  const fr1 = plural('fr');
  const forms = (n: number) => ({ one: `${n} one`, other: `${n} other` });
  assert.equal(en1(1, forms(1)), '1 one');
  assert.equal(en1(0, forms(0)), '0 other');
  assert.equal(fr1(0, forms(0)), '0 one'); // French: 0 is singular
  assert.equal(fr1(2, forms(2)), '2 other');
  assert.equal(en1(0, { zero: 'none', other: 'x' }), 'none');
  assert.equal(fallbackCategory('pt-BR', 1), 'one');
  assert.equal(fallbackCategory('pt-BR', 0), 'one');
  assert.equal(fallbackCategory('de', 0), 'other');
  assert.equal(fallbackCategory('es', 1), 'one');
});

test('device languages map to a supported language', () => {
  assert.equal(matchLocale(['es-MX']), 'es');
  assert.equal(matchLocale(['pt-PT']), 'pt-BR');
  assert.equal(matchLocale(['it-IT', 'de-AT']), 'de');
  assert.equal(matchLocale(['ja-JP']), null);
  assert.equal(matchLocale(['fr_CA']), 'fr');
});

test('dates, times and numbers follow the active language', () => {
  const d = new Date(2026, 2, 14, 21, 5);
  try {
    setLocale('en');
    assert.match(fmtTime(d), /9:05\s?PM/);
    assert.equal(fmtNumber(1234.5), '1,234.5');
    setLocale('de');
    assert.equal(fmtTime(d), '21:05');
    assert.equal(fmtNumber(1234.5), '1.234,5');
    assert.match(fmtDate(d, { weekday: 'long' }), /Samstag/);
    setLocale('fr');
    assert.equal(fmtTime(d), '21:05');
    assert.match(fmtDate(d, { month: 'long' }), /mars/);
    setLocale('es');
    assert.match(fmtDate(d, { weekday: 'long' }), /sábado/);
    setLocale('pt-BR');
    assert.equal(fmtTime(d), '21:05');
    assert.match(fmtDate(d, { weekday: 'long' }), /sábado/);
    // A device in en-GB keeps its 24-hour clock while the app speaks English.
    setLocale('en', 'en-GB');
    assert.equal(fmtTime(d), '21:05');
    // A region tag in another language is ignored.
    setLocale('de', 'en-US');
    assert.equal(fmtTime(d), '21:05');
  } finally {
    setLocale('en');
  }
});

test('shared format helpers speak the active language', () => {
  try {
    setLocale('es');
    assert.equal(labelFor(['person', 'car']), 'Persona y Coche');
    assert.equal(labelFor([]), 'Movimiento');
    assert.equal(formatRelative(Date.now() / 1000 - 5), 'Ahora mismo');
    assert.equal(formatRelative(Date.now() / 1000 - 600), 'hace 10 min');
    setLocale('de');
    assert.equal(labelFor(['package']), 'Paket');
    assert.equal(titleFor({ objects: ['dog'], subLabels: [] }), 'Hund');
    setLocale('en');
    assert.equal(labelFor(['person', 'car']), 'Person & Car');
    assert.equal(labelFor(['person', 'car', 'dog', 'cat']), 'Person, Car +2');
    assert.equal(labelFor(['license_plate']), 'License plate');
    assert.equal(labelFor(['wombat']), 'Wombat');
  } finally {
    setLocale('en');
  }
  assert.equal(tr().common.cancel, 'Cancel');
});

#!/usr/bin/env node
// Checks every length-limited App Store field in docs/APP_STORE_LISTING.md.
//
// Each field is a fenced block whose info string is: text <field> <lang> <limit>[b]
//   ```text subtitle en 30
//   Private viewer for NVR & CCTV
//   ```
//   ↳ 29 / 30 characters
// A trailing "b" means the limit is in UTF-8 bytes (Apple's keyword field). Otherwise it's
// characters (Unicode code points). The "↳" line after the block states the count; this script
// checks it matches, and `--fix` rewrites it.
//
// Usage: node scripts/check-listing.mjs [--fix] [path]

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const fix = args.includes('--fix');
const here = dirname(fileURLToPath(import.meta.url));
const file = resolve(args.find((a) => !a.startsWith('--')) ?? resolve(here, '../docs/APP_STORE_LISTING.md'));

let src = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const block = /^```text ([\w.-]+) ([\w-]+) (\d+)(b?)\n([\s\S]*?)\n```\n(↳ [^\n]*)?/gm;

const errors = [];
const warnings = [];
const rows = [];
const seen = new Map(); // lang -> { name, subtitle }

const words = (s) => s.toLowerCase().normalize('NFC').split(/[^\p{L}\p{N}]+/u).filter(Boolean);

src = src.replace(block, (whole, field, lang, limitStr, isBytes, text, stated) => {
  const limit = Number(limitStr);
  const unit = isBytes ? 'bytes' : 'characters';
  const n = isBytes ? Buffer.byteLength(text, 'utf8') : [...text].length;
  const where = `${field} [${lang}]`;
  rows.push({ where, n, limit, unit, ok: n <= limit });
  if (n > limit) errors.push(`${where}: ${n} ${unit}, limit ${limit}`);
  if (text !== text.trim()) warnings.push(`${where}: leading/trailing whitespace`);

  const s = seen.get(lang) ?? {};
  if (field === 'name' || field === 'subtitle') s[field] = text;
  seen.set(lang, s);

  if (field === 'keywords') {
    if (/,\s|\s,/.test(text)) errors.push(`${where}: spaces around commas waste bytes`);
    if (/\n/.test(text)) errors.push(`${where}: must be one line`);
    const list = text.split(',');
    const dup = list.filter((k, i) => list.indexOf(k) !== i);
    if (dup.length) errors.push(`${where}: duplicate keywords: ${dup.join(', ')}`);
    const short = list.filter((k) => [...k].length <= 2);
    if (short.length) errors.push(`${where}: keywords must be longer than two characters: ${short.join(', ')}`);
    // Words already in the name or subtitle are indexed anyway: repeating them wastes space.
    const taken = new Set([...words(s.name ?? ''), ...words(s.subtitle ?? '')]);
    const wasted = list.filter((k) => taken.has(k.toLowerCase()));
    if (wasted.length) warnings.push(`${where}: already in name/subtitle: ${wasted.join(', ')}`);
  }

  const line = `↳ ${n} / ${limit} ${unit}`;
  if (stated !== undefined && stated !== line && !fix) errors.push(`${where}: stated "${stated}" but actual is "${line}" (run with --fix)`);
  if (stated === undefined && !fix) errors.push(`${where}: missing "↳ count" line (run with --fix)`);
  return `\`\`\`text ${field} ${lang} ${limitStr}${isBytes}\n${text}\n\`\`\`\n${line}`;
});

if (fix) writeFileSync(file, src);

const pad = (s, w) => String(s).padEnd(w);
console.log(`${pad('field', 26)}${pad('count', 8)}limit`);
for (const r of rows) console.log(`${pad(r.where, 26)}${pad(r.n, 8)}${r.limit} ${r.unit}${r.ok ? '' : '  <-- TOO LONG'}`);
console.log(`\n${rows.length} fields checked${fix ? ' (counts rewritten)' : ''}.`);
for (const w of warnings) console.log(`warning: ${w}`);
for (const e of errors) console.error(`error: ${e}`);
if (rows.length === 0) {
  console.error('error: no fields found');
  process.exit(1);
}
process.exit(errors.length ? 1 : 0);

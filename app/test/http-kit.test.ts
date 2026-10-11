import assert from 'node:assert/strict';
import { test } from 'node:test';

import { daysOf, formatLocalDateTime, mergeSpans, parseLocalDateTime, qs, withQuery } from '../src/systems/http-kit.ts';

test('query strings skip empty values and append to existing ones', () => {
  assert.equal(qs({ a: 1, b: 'x y', c: undefined, d: '' }), 'a=1&b=x%20y');
  assert.equal(withQuery('/p?x=1', { y: 2 }), '/p?x=1&y=2');
  assert.equal(withQuery('/p', {}), '/p');
});

test('spans merge when touching, and sort', () => {
  assert.deepEqual(
    mergeSpans([
      { start: 200, end: 300 },
      { start: 100, end: 150 },
      { start: 150.5, end: 180 },
      { start: 5, end: 5 },
    ]),
    [
      { start: 100, end: 180 },
      { start: 200, end: 300 },
    ],
  );
});

test('server wall-clock times convert using the server time zone', () => {
  // 2024-07-01 12:00 in New York (EDT, UTC-4) = 16:00 UTC.
  assert.equal(parseLocalDateTime('2024-07-01 12:00:00', 'America/New_York'), Date.UTC(2024, 6, 1, 16) / 1000);
  // Winter: EST, UTC-5.
  assert.equal(parseLocalDateTime('2024-01-15T08:30:00', 'America/New_York'), Date.UTC(2024, 0, 15, 13, 30) / 1000);
  assert.equal(parseLocalDateTime('2024-01-15T08:30:00Z'), Date.UTC(2024, 0, 15, 8, 30) / 1000);
  assert.equal(parseLocalDateTime('2024-01-15T08:30:00+02:00'), Date.UTC(2024, 0, 15, 6, 30) / 1000);
  assert.ok(Number.isNaN(parseLocalDateTime('garbage')));
  assert.equal(formatLocalDateTime(Date.UTC(2024, 6, 1, 16) / 1000, 'America/New_York'), '2024-07-01 12:00:00');
  assert.equal(formatLocalDateTime(Date.UTC(2024, 6, 1, 16) / 1000, 'UTC', 'T'), '2024-07-01T16:00:00');
});

test('recording days are listed newest first', () => {
  const t = new Date(2024, 4, 1, 23, 0).getTime() / 1000;
  assert.deepEqual(daysOf([{ start: t, end: t + 7200 }]), ['2024-05-02', '2024-05-01']);
});

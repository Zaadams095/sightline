import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ringsUrl } from '../src/hub.ts';
import { advance, clockText, dimOpacity, inDailyWindow, onRings, pixelShift, RING_HOLD_MS, shownIndex, type TourState } from '../src/tour.ts';

const ids = ['drive', 'door', 'back'];

test('tour goes round the cameras', () => {
  let s: TourState = { index: 0, ring: null };
  s = advance(s, 3, 0);
  s = advance(s, 3, 0);
  assert.equal(shownIndex(s, 0), 2);
  assert.equal(shownIndex(advance(s, 3, 0), 0), 0);
  assert.deepEqual(advance(s, 0, 0), s);
});

test('a ring switches to the doorbell, pauses the tour, then it carries on', () => {
  const t0 = 1_000_000;
  let s: TourState = { index: 2, ring: null };
  s = onRings(s, [{ id: 'r', camera: 'door', at: 5 }], ids, t0);
  assert.equal(shownIndex(s, t0 + 1000), 1);
  // The tour doesn't move while the doorbell is up.
  assert.deepEqual(advance(s, 3, t0 + 1000), s);
  // Afterwards the tour resumes where it was.
  assert.equal(shownIndex(s, t0 + RING_HOLD_MS + 1), 2);
  assert.equal(shownIndex(advance(s, 3, t0 + RING_HOLD_MS + 1), t0 + RING_HOLD_MS + 1), 0);
  // Rings on cameras this TV can't see are ignored; the newest known ring wins.
  assert.deepEqual(onRings({ index: 0, ring: null }, [{ id: 'x', camera: 'garage', at: 9 }], ids, t0), { index: 0, ring: null });
  const two = onRings({ index: 0, ring: null }, [{ id: 'a', camera: 'drive', at: 1 }, { id: 'b', camera: 'back', at: 2 }], ids, t0);
  assert.equal(shownIndex(two, t0), 2);
});

test('night dimming crosses midnight', () => {
  assert.equal(inDailyWindow(new Date(2026, 9, 11, 23, 0), '22:00', '06:30'), true);
  assert.equal(inDailyWindow(new Date(2026, 9, 11, 7, 0), '22:00', '06:30'), false);
  assert.ok(dimOpacity(new Date(2026, 9, 11, 2, 0)) > 0);
  assert.equal(dimOpacity(new Date(2026, 9, 11, 14, 0)), 0);
});

test('drift stays small and changes each minute', () => {
  const a = pixelShift(0);
  const b = pixelShift(60_000);
  assert.notDeepEqual(a, b);
  for (let m = 0; m < 20; m++) {
    const s = pixelShift(m * 60_000, 8);
    assert.ok(Math.abs(s.x) <= 8 && Math.abs(s.y) <= 8);
  }
});

test('rings URL clamps the wait', () => {
  assert.equal(ringsUrl('https://h', 12.5, 60), 'https://h/v1/rings?after=12.5&wait=25');
  assert.equal(ringsUrl('https://h', 0, -1), 'https://h/v1/rings?after=0&wait=0');
  assert.equal(clockText(new Date(2026, 9, 11, 21, 5)), '9:05 PM');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chunkAt, clipSpans, hourTicks, planVod, sampleIndexAt, spanPlayerToWall, spanWallToPlayer, streamSteps } from '../src/util/timelapse.ts';

test('short windows play straight through at a high rate', () => {
  const plan = planVod([{ start: 0, end: 600 }], { targetSec: 60 });
  assert.equal(plan?.mode, 'rate');
  assert.equal(plan?.mode === 'rate' && plan.rate, 10);
  assert.equal(planVod([], {}), null);
});

test('a full day jumps through recorded time, skipping gaps', () => {
  const spans = clipSpans([{ start: 50000, end: 86400 }, { start: 0, end: 40000 }], 0, 86400);
  const plan = planVod(spans, { targetSec: 60, dwellSec: 1.5 });
  assert.ok(plan && plan.mode === 'jump');
  if (plan?.mode !== 'jump') return;
  assert.equal(plan.samples.length, 40);
  assert.equal(plan.durationSec, 60);
  for (const s of plan.samples) {
    assert.ok(s.wall < 40000 || s.wall >= 50000, `sample in a gap: ${s.wall}`);
    assert.equal(spanWallToPlayer(spans, s.wall), s.player);
  }
  for (let i = 1; i < plan.samples.length; i++) assert.ok(plan.samples[i].wall > plan.samples[i - 1].wall);
  assert.ok(plan.samples[plan.samples.length - 1].wall > 80000);
  const idx = sampleIndexAt(plan.samples, 45000);
  assert.ok(plan.samples[idx].wall <= 45000 && plan.samples[idx + 1].wall > 45000);
  assert.equal(spanPlayerToWall(spans, 40000), 50000);
});

test('long windows load in chunks and never play straight through across them', () => {
  assert.deepEqual(chunkAt(0, 86400, 0), { index: 0, start: 0, end: 7200 });
  assert.deepEqual(chunkAt(0, 86400, 86399), { index: 11, start: 79200, end: 86400 });
  assert.deepEqual(chunkAt(0, 5000, 9999), { index: 0, start: 0, end: 5000 });
  assert.equal(planVod([{ start: 0, end: 600 }], { straightThrough: false })?.mode, 'jump');
});

test('stream steps and hour ticks', () => {
  assert.equal(streamSteps(0, 86400).length, 24);
  assert.equal(streamSteps(0, 3600).length, 4);
  const start = new Date(2026, 4, 1, 0, 0).getTime() / 1000;
  const ticks = hourTicks(start, start + 86400);
  assert.equal(ticks.length, 25);
  assert.equal(ticks[0].label, '12 AM');
  assert.equal(ticks[12].label, 'Noon');
  assert.equal(ticks[1].label, undefined);
  const mid = hourTicks(start + 1800, start + 3 * 3600);
  assert.equal(new Date(mid[0].t * 1000).getHours(), 1);
});

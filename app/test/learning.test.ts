import assert from 'node:assert/strict';
import { test } from 'node:test';

import { lightAt } from '../src/alerts/clock.ts';
import {
  addFeedback,
  featuresOf,
  forgetRule,
  learnRules,
  likelyFalseTrigger,
  newlyLearned,
  quietedBy,
  ruleExplanation,
  smartQuiet,
  type AlertFeatures,
  type Feedback,
  type LearningState,
} from '../src/alerts/learning.ts';

// Shared fixtures: bridge/learning_test.go runs the same cases against the Hub.
const T0 = 1_760_000_000;
const base: AlertFeatures = {
  camera: 'driveway',
  objects: ['car'],
  zones: ['street'],
  subLabels: [],
  severity: 'detection',
  hour: 'evening',
  light: 'night',
  duration: 'short',
};
const fb = (i: number, over: Partial<Feedback> = {}): Feedback => ({ ...base, id: `e${i}`, at: T0 + i * 60, verdict: 'not-important', ...over });
const learn = (fs: Feedback[], confirmed: string[] = []) => {
  let st: LearningState = { feedback: [], confirmed };
  for (const f of fs) st = addFeedback(st, f);
  return { st, rules: learnRules(st, T0 + 3600) };
};

test('three dismissals of cars at night become a rule; two do not', () => {
  assert.equal(learn([fb(1), fb(2)]).rules.length, 0);
  const { rules } = learn([fb(1), fb(2), fb(3)]);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].key, 'driveway|car|night');
  assert.ok(quietedBy(base, rules));
  // Daytime cars, a person, another camera, a new zone, a recognized name: still alert.
  assert.equal(quietedBy({ ...base, light: 'day' }, rules), null);
  assert.equal(quietedBy({ ...base, objects: ['car', 'person'] }, rules), null);
  assert.equal(quietedBy({ ...base, camera: 'porch' }, rules), null);
  assert.equal(quietedBy({ ...base, zones: ['driveway'] }, rules), null);
  assert.equal(quietedBy({ ...base, subLabels: ['ABC123'] }, rules), null);
  assert.equal(quietedBy({ ...base, severity: 'alert' }, rules), null);
  // All dismissed ones were short: a car that stays a minute+ still alerts.
  assert.equal(quietedBy({ ...base, duration: 'long' }, rules), null);
  assert.ok(quietedBy({ ...base, duration: 'unknown' }, rules));
  assert.equal(
    ruleExplanation(rules[0], 'Driveway'),
    'You marked 3 cars on Driveway at night in street as not important — Sightline will stop alerting for those.',
  );
});

test('the same event twice counts once', () => {
  assert.equal(learn([fb(1), fb(1), fb(1)]).rules.length, 0);
});

test('mixed day and night: one rule for any time once there are four', () => {
  const fs = [fb(1), fb(2), fb(3, { light: 'day' }), fb(4, { light: 'day' })];
  const { rules } = learn(fs);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].light, 'any');
  assert.ok(quietedBy({ ...base, light: 'day' }, rules));
});

test('"Always tell me" wins until newer dismissals; latest opinion wins', () => {
  const { rules } = learn([fb(1), fb(2), fb(3), fb(4, { verdict: 'important' })]);
  assert.deepEqual(rules.map((r) => r.kind), ['always']);
  assert.equal(quietedBy(base, rules), null);
  const later = learn([fb(1), fb(2), fb(3), fb(4, { verdict: 'important' }), fb(5), fb(6), fb(7)]);
  assert.deepEqual(later.rules.map((r) => r.kind), ['quiet']);
});

test('people are never quieted unless the user confirms the rule', () => {
  const people = [1, 2, 3].map((i) => fb(i, { objects: ['person'] }));
  const { rules } = learn(people);
  assert.equal(rules[0].needsConfirm, true);
  assert.equal(quietedBy({ ...base, objects: ['person'] }, rules), null);
  const ok = learn(people, ['driveway|person|night']);
  assert.ok(quietedBy({ ...base, objects: ['person'] }, ok.rules));
});

test('doorbell rings are never learned or quieted', () => {
  const rings = [1, 2, 3, 4].map((i) => fb(i, { objects: ['doorbell'] }));
  const { rules } = learn(rings);
  assert.equal(rules.length, 0);
  assert.equal(smartQuiet({ ...base, objects: ['doorbell'], start: T0 }, rules, { conditions: true }, []), null);
});

test('forgetting a rule drops its feedback; newlyLearned spots the rule a dismissal created', () => {
  const two = learn([fb(1), fb(2)]);
  const three = learn([fb(1), fb(2), fb(3)]);
  assert.equal(newlyLearned(two.rules, three.rules)?.key, 'driveway|car|night');
  const forgotten = forgetRule(three.st, three.rules[0]);
  assert.equal(forgotten.feedback.length, 0);
  assert.equal(learnRules(forgotten, T0 + 3600).length, 0);
});

test('old feedback expires', () => {
  const { st } = learn([fb(1), fb(2), fb(3)]);
  assert.equal(learnRules(st, T0 + 200 * 86400).length, 0);
});

test('rain/wind burst across cameras and short night motion (headlights)', () => {
  const motion = { ...base, objects: [] as string[], light: 'day' as const, duration: 'unknown' as const, start: T0 };
  const recent = [
    { camera: 'porch', start: T0 + 2, motionOnly: true },
    { camera: 'yard', start: T0 - 4, motionOnly: true },
  ];
  assert.equal(likelyFalseTrigger(motion, recent), 'weather');
  assert.equal(likelyFalseTrigger(motion, recent.slice(0, 1)), null);
  assert.equal(likelyFalseTrigger(motion, [{ camera: 'porch', start: T0 + 30, motionOnly: true }, recent[1]]), null);
  assert.equal(likelyFalseTrigger({ ...motion, light: 'night', duration: 'short' }, []), 'headlights');
  assert.equal(likelyFalseTrigger({ ...motion, light: 'night', duration: 'long' }, []), null);
  // A detected object is never "weather".
  assert.equal(likelyFalseTrigger({ ...motion, objects: ['person'] }, recent), null);
  assert.equal(smartQuiet({ ...motion, light: 'night', duration: 'short' }, [], { conditions: false }, []), null);
  assert.deepEqual(smartQuiet({ ...motion, light: 'night', duration: 'short' }, [], { conditions: true }, []), { reason: 'headlights' });
});

test('features: objects normalized, durations bucketed, day/night from the sun', () => {
  const f = featuresOf({ camera: 'c', objects: ['motion', 'car', 'car'], zones: [], severity: 'alert', start: T0, end: T0 + 3 }, 'UTC');
  assert.deepEqual(f.objects, ['car']);
  assert.equal(f.duration, 'short');
  // London, midsummer: 12:00 UTC is day, 01:00 UTC is night. Fallback without a place: 7 PM–6 AM.
  const june = Date.UTC(2026, 5, 21, 12) / 1000;
  assert.equal(lightAt(june, 'Europe/London', { lat: 51.5, lon: -0.1 }), 'day');
  assert.equal(lightAt(june - 11 * 3600, 'Europe/London', { lat: 51.5, lon: -0.1 }), 'night');
  // Winter in New York: 17:30 local is already dark (22:30 UTC).
  assert.equal(lightAt(Date.UTC(2026, 11, 15, 22, 30) / 1000, 'America/New_York', { lat: 40.7, lon: -74 }), 'night');
  assert.equal(lightAt(Date.UTC(2026, 11, 15, 22, 30) / 1000, 'America/New_York'), 'day');
});

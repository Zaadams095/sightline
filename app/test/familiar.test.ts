import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  bestMatch,
  clusterUnknowns,
  cosine,
  decodePrint,
  encodePrint,
  matchOptions,
  mergeNames,
  normalizePlate,
  pickPlate,
  platesMatch,
  pruneSamples,
} from '../src/familiar/match.ts';

/** A unit vector near axis `axis` (+ a little of `noiseAxis`), in 8 dimensions. */
function vec(axis: number, noise = 0, noiseAxis = (axis + 1) % 8): Float32Array {
  const v = new Float32Array(8);
  v[axis] = 1;
  v[noiseAxis] += noise;
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}

test('prints round-trip through base64', () => {
  const v = vec(2, 0.3);
  const back = decodePrint(encodePrint(v));
  assert.equal(back.length, 8);
  assert.ok(Math.abs(cosine(v, back) - 1) < 1e-6);
});

test('different-length prints never match', () => {
  assert.equal(cosine(new Float32Array(4).fill(1), new Float32Array(8).fill(1)), -1);
  assert.equal(cosine(new Float32Array(0), new Float32Array(0)), -1);
  assert.equal(cosine(new Float32Array(3), new Float32Array(3)), -1);
});

test('best match needs votes, the threshold and a margin', () => {
  const o = matchOptions('face');
  const dad = { id: 'dad', prints: [vec(0, 0.05), vec(0, 0.1), vec(0, 0.02)] };
  const sam = { id: 'sam', prints: [vec(3, 0.05), vec(3, 0.1)] };
  assert.equal(bestMatch(vec(0, 0.07), [dad, sam], o)?.id, 'dad');
  // Nobody close.
  assert.equal(bestMatch(vec(6), [dad, sam], o), null);
  // A single good sample doesn't outvote: two samples needed when the person has them.
  const lucky = { id: 'lucky', prints: [vec(5), vec(1)] };
  assert.equal(bestMatch(vec(5), [lucky], o), null);
  // A person with one sample needs that one only.
  assert.equal(bestMatch(vec(5), [{ id: 'one', prints: [vec(5)] }], o)?.id, 'one');
});

test('ambiguous between two people = no name', () => {
  const o = matchOptions('face');
  // Two people whose samples look the same: never guess.
  const a = { id: 'a', prints: [vec(0), vec(0, 0.01)] };
  const b = { id: 'b', prints: [vec(0, 0.02), vec(0, 0.015)] };
  assert.equal(bestMatch(vec(0, 0.012), [a, b], o), null);
});

test('relaxed is looser than careful', () => {
  assert.ok(matchOptions('face', 'relaxed').threshold < matchOptions('face').threshold);
  assert.ok(matchOptions('vehicle').threshold >= matchOptions('face').threshold);
});

test('plates', () => {
  assert.equal(normalizePlate('7abc 123'), '7ABC123');
  assert.equal(normalizePlate('STOP'), null);
  assert.equal(normalizePlate('1234'), null);
  assert.equal(normalizePlate('AB12'), 'AB12');
  assert.equal(normalizePlate('ABCDEFGH1234'), null);
  assert.equal(pickPlate(['FORD', '12:45', 'KX19 ABC', 'MAIN ST']), 'KX19ABC');
  assert.equal(pickPlate(['hello']), null);
  assert.equal(platesMatch('7ABC123', '7ABC128'), true);
  assert.equal(platesMatch('7ABC123', '7XBC128'), false);
  assert.equal(platesMatch('AB12', 'AB13'), false);
});

test('unknown sightings cluster by similarity and kind', () => {
  const s = (id: string, v: Float32Array, at: number, kind: 'face' | 'vehicle' = 'face') => ({ id, kind, print: encodePrint(v), at });
  const clusters = clusterUnknowns([
    s('a1', vec(0, 0.05), 1),
    s('b1', vec(4, 0.05), 2),
    s('a2', vec(0, 0.1), 3),
    s('a3', vec(0, 0.02), 4),
    s('c1', vec(0, 0.05), 5, 'vehicle'),
  ]);
  assert.deepEqual(
    clusters.map((c) => c.map((x) => x.id)),
    [['a1', 'a2', 'a3'], ['c1'], ['b1']],
  );
});

test('pruning keeps samples varied', () => {
  const s = (id: string, v: Float32Array, at: number) => ({ id, print: encodePrint(v), at });
  const kept = pruneSamples([s('x1', vec(0), 1), s('x2', vec(0, 0.01), 2), s('y', vec(0, 0.5), 3)], 2);
  assert.deepEqual(kept.map((k) => k.id).sort(), ['x2', 'y']);
});

test('names merge without duplicates', () => {
  assert.deepEqual(mergeNames(['Dad'], ['Dad', 'Our car']), ['Dad', 'Our car']);
  assert.deepEqual(mergeNames(undefined, undefined), []);
});
